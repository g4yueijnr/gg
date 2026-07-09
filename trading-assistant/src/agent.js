import OpenAI from "openai";
import { config } from "./config.js";

const SYSTEM_PROMPT = `You are the user's personal Polymarket trading assistant and trading buddy. You run inside their private trading app, which is connected to their own Polymarket account. There is exactly one user and it is their account, their money, and their explicit standing instruction that you execute trades for them.

What you can do with your tools:
- Search Polymarket markets and read live order books.
- Place and cancel limit orders (prices are dollars per share: 0.10 = 10 cents).
- Check open orders, positions, and USDC balance.
- Create "standing rules" that the app's always-on engine enforces in real time, 24/7, even while you are not in the loop. The main one is auto_outbid: keep a buy order resting, and if anyone outbids it, instantly re-bid one tick higher up to a hard price cap.

How to behave:
- Be a sharp, friendly trading buddy. Casual conversation is welcome - chat about markets, odds, strategy, whatever. But when it's time to act, be precise.
- Lead with what you did or found; keep commentary brief.
- When the user asks for an action that is fully specified (market, side, price, size), do it - don't ask for re-confirmation.
- If something important is ambiguous (which market/outcome they mean, order size, or the price cap), ask one short clarifying question instead of guessing.
- Always resolve a market via search_markets first and confirm you have the right outcome token before trading. If several markets plausibly match, show the top candidates and ask.
- "Outbid up to X" instructions are standing rules -> use create_auto_outbid_rule, not a one-off order.
- After placing orders or creating rules, state exactly what is now resting: market, outcome, price, size, and cap.
- Report failures honestly and suggest the fix (e.g. insufficient balance, price would cross the spread).
- Prices: users often speak in cents ("10c", "ten cents") - convert to dollars per share (0.10). Shares are also called contracts.
- Never invent market data - always read it from tools.`;

/** Tool definitions in OpenAI function-calling format. */
function toolDefs() {
  const defs = [
    {
      name: "search_markets",
      description: "Search Polymarket for active markets matching a text query. Returns markets with their outcomes and each outcome's tokenId (needed for all trading calls). Call this before trading when you don't already have the tokenId.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "Free-text search, e.g. 'Fed rate cut March'" } },
        required: ["query"],
      },
    },
    {
      name: "get_order_book",
      description: "Get the live order book (best bid/ask and depth) plus tick size for an outcome token.",
      parameters: {
        type: "object",
        properties: { tokenId: { type: "string" } },
        required: ["tokenId"],
      },
    },
    {
      name: "place_order",
      description: "Place a limit order (GTC). price is dollars per share, e.g. 0.10 for 10 cents. size is number of shares/contracts.",
      parameters: {
        type: "object",
        properties: {
          tokenId: { type: "string" },
          side: { type: "string", enum: ["BUY", "SELL"] },
          price: { type: "number" },
          size: { type: "number" },
        },
        required: ["tokenId", "side", "price", "size"],
      },
    },
    {
      name: "cancel_order",
      description: "Cancel an open order by its orderId.",
      parameters: {
        type: "object",
        properties: { orderId: { type: "string" } },
        required: ["orderId"],
      },
    },
    {
      name: "list_open_orders",
      description: "List the user's open orders on Polymarket.",
      parameters: { type: "object", properties: {} },
    },
    {
      name: "get_positions",
      description: "List the user's current positions with value and PnL.",
      parameters: { type: "object", properties: {} },
    },
    {
      name: "get_balance",
      description: "Get the user's available USDC balance on Polymarket.",
      parameters: { type: "object", properties: {} },
    },
    {
      name: "create_auto_outbid_rule",
      description: "Create a standing auto-outbid rule: places a BUY order at startPrice and, whenever someone outbids it, instantly re-bids one tick above them - never exceeding maxPrice. Runs 24/7 in the app's background engine. Use for instructions like 'bid 10c and outbid anyone up to 20c'.",
      parameters: {
        type: "object",
        properties: {
          tokenId: { type: "string" },
          size: { type: "number", description: "Shares/contracts to buy" },
          startPrice: { type: "number", description: "Initial bid in dollars per share (0.10 = 10c)" },
          maxPrice: { type: "number", description: "Hard cap in dollars per share (0.20 = 20c)" },
          marketQuestion: { type: "string", description: "The market question, for display" },
          outcome: { type: "string", description: "Outcome name, e.g. Yes/No" },
        },
        required: ["tokenId", "size", "startPrice", "maxPrice", "marketQuestion", "outcome"],
      },
    },
    {
      name: "update_rule",
      description: "Change a standing rule's maxPrice and/or size. Reactivates a rule that hit its cap if the new cap is higher.",
      parameters: {
        type: "object",
        properties: {
          ruleId: { type: "string" },
          maxPrice: { type: "number" },
          size: { type: "number" },
        },
        required: ["ruleId"],
      },
    },
    {
      name: "cancel_rule",
      description: "Cancel a standing rule and remove its resting order.",
      parameters: {
        type: "object",
        properties: { ruleId: { type: "string" } },
        required: ["ruleId"],
      },
    },
    {
      name: "list_rules",
      description: "List all standing rules (active and past) with their status.",
      parameters: { type: "object", properties: {} },
    },
    {
      name: "get_activity",
      description: "Read the recent activity log - everything the background engine did (outbids, fills, cap warnings).",
      parameters: {
        type: "object",
        properties: { limit: { type: "number", description: "Max entries, default 20" } },
      },
    },
  ];
  return defs.map((d) => ({ type: "function", function: d }));
}

export class Agent {
  constructor({ polymarket, rules, store }) {
    this.pm = polymarket;
    this.rules = rules;
    this.store = store;
    // Don't crash at boot when the key is missing - fail politely in chat instead.
    this.client = config.openaiApiKey ? new OpenAI({ apiKey: config.openaiApiKey }) : null;
    this.busy = false;
    this._migrateHistory();
  }

  /** Older versions stored chat history in Anthropic's message format; reset if found. */
  _migrateHistory() {
    const msgs = this.store.state.messages;
    const looksForeign = msgs.some(
      (m) => Array.isArray(m.content) || !["user", "assistant", "tool", "system"].includes(m.role),
    );
    if (looksForeign) {
      console.log("[agent] resetting chat history from previous provider format");
      this.store.state.messages = [];
      this.store.save();
    }
  }

  async _runTool(name, input) {
    switch (name) {
      case "search_markets": return this.pm.searchMarkets(input.query);
      case "get_order_book": return this.pm.getOrderBook(input.tokenId);
      case "place_order": return this.pm.placeOrder(input);
      case "cancel_order": return this.pm.cancelOrder(input.orderId);
      case "list_open_orders": return this.pm.getOpenOrders();
      case "get_positions": return this.pm.getPositions();
      case "get_balance": return this.pm.getBalance();
      case "create_auto_outbid_rule": return this.rules.createAutoOutbid(input);
      case "update_rule": return this.rules.updateRule(input.ruleId, input);
      case "cancel_rule": return this.rules.cancelRule(input.ruleId);
      case "list_rules": return this.rules.listRules();
      case "get_activity": {
        const limit = input.limit || 20;
        return this.store.state.activity.slice(-limit);
      }
      default: throw new Error(`Unknown tool: ${name}`);
    }
  }

  /**
   * Handle one user message. Streams progress via the `emit` callback:
   *   emit({type:'text', delta})            - assistant text tokens
   *   emit({type:'tool_start', name, input}) / emit({type:'tool_end', name, ok})
   * Returns the final assistant text.
   */
  async chat(userText, emit = () => {}) {
    if (!this.client) throw new Error("OPENAI_API_KEY is not configured - add it to your .env and restart.");
    if (this.busy) throw new Error("Assistant is still working on the previous message.");
    this.busy = true;
    try {
      const messages = this.store.state.messages;
      // Ambient context rides along with the user turn.
      const contextNote =
        `<context>now=${new Date().toISOString()} trading=${this.pm.readonly ? "DISABLED (no key configured)" : "enabled"}` +
        `${config.dryRun ? " DRY_RUN(orders simulated)" : ""} activeRules=${this.rules.activeRules().length}</context>`;
      messages.push({ role: "user", content: `${contextNote}\n${userText}` });

      const tools = toolDefs();
      let finalText = "";

      for (let iter = 0; iter < 12; iter++) {
        const stream = await this.client.chat.completions.create({
          model: config.model,
          stream: true,
          messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
          tools,
        });

        let text = "";
        const toolCalls = []; // accumulate streamed tool_call deltas by index

        for await (const chunk of stream) {
          const choice = chunk.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta || {};
          if (delta.content) {
            text += delta.content;
            finalText += delta.content;
            emit({ type: "text", delta: delta.content });
          }
          for (const tc of delta.tool_calls || []) {
            const slot = (toolCalls[tc.index] ||= { id: "", name: "", arguments: "" });
            if (tc.id) slot.id = tc.id;
            if (tc.function?.name) slot.name += tc.function.name;
            if (tc.function?.arguments) slot.arguments += tc.function.arguments;
          }
        }

        const assistantMsg = { role: "assistant", content: text || null };
        if (toolCalls.length) {
          assistantMsg.tool_calls = toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: tc.arguments },
          }));
        }
        messages.push(assistantMsg);
        this.store.save();

        if (!toolCalls.length) break; // no tool requests -> the reply is final

        for (const tc of toolCalls) {
          let input = {};
          try { input = tc.arguments ? JSON.parse(tc.arguments) : {}; } catch { /* leave empty */ }
          emit({ type: "tool_start", name: tc.name, input });
          let result;
          let isError = false;
          try {
            result = await this._runTool(tc.name, input);
          } catch (err) {
            result = `Error: ${err.message}`;
            isError = true;
          }
          emit({ type: "tool_end", name: tc.name, ok: !isError });
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: typeof result === "string" ? result : JSON.stringify(result ?? null),
          });
        }
        this.store.save();
        if (finalText && !finalText.endsWith("\n\n")) {
          emit({ type: "text", delta: "\n\n" });
          finalText += "\n\n";
        }
      }

      this._trimHistory();
      this.store.save();
      return finalText;
    } finally {
      this.busy = false;
    }
  }

  /**
   * Keep chat history bounded. Trim only at plain user-message boundaries so
   * assistant tool_calls are never separated from their tool results.
   */
  _trimHistory() {
    const messages = this.store.state.messages;
    const MAX = 80;
    if (messages.length <= MAX) return;
    let cut = messages.length - MAX;
    while (cut < messages.length && messages[cut].role !== "user") cut++;
    if (cut > 0 && cut < messages.length) {
      this.store.state.messages = messages.slice(cut);
    }
  }

  resetHistory() {
    this.store.state.messages = [];
    this.store.save();
  }
}
