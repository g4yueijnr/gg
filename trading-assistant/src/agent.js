import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";

const SYSTEM_PROMPT = `You are the user's personal Polymarket trading assistant and trading buddy. You run inside their private trading app, which is connected to their own Polymarket account. There is exactly one user and it is their account, their money, and their explicit standing instruction that you execute trades for them.

What you can do with your tools:
- Search Polymarket markets and read live order books.
- Place and cancel limit orders (prices are dollars per share: 0.10 = 10 cents).
- Check open orders, positions, and balance.
- Create "standing rules" that the app's always-on engine enforces in real time, 24/7, even while you are not in the loop. The main one is auto_outbid: keep a buy order resting, and if anyone outbids it, instantly re-bid one tick higher up to a hard price cap.

How to behave:
- Be a sharp, friendly trading buddy. Casual conversation is welcome - chat about markets, odds, strategy, whatever. But when it's time to act, be precise.
- Lead with what you did or found; keep commentary brief.
- When the user asks for an action that is fully specified (market, side, price, size), do it - don't ask for re-confirmation.
- If something important is ambiguous (which market/outcome they mean, order size, or the price cap), ask one short clarifying question instead of guessing.
- Always resolve a market via search_markets first and confirm you have the right outcome token before trading. If several markets plausibly match, show the top candidates and ask.
- "Outbid up to X" instructions are standing rules -> use create_auto_outbid_rule, not a one-off order.
- "One cent above the current highest bid" style instructions: omit startPrice on create_auto_outbid_rule - the engine reads the live book and starts one tick above the best bid at placement time. Don't read the book yourself and hardcode a price for this; the omitted-startPrice path is more accurate.
- Cancel conditions ("cancel it Friday night", "pull it after 24 hours"): compute an ISO UTC datetime from the current time in <context> and pass it as expiresAt. Confirm the exact time back to the user in their terms.
- After placing orders or creating rules, state exactly what is now resting: market, outcome, price, size, cap, and expiry if any.
- Report failures honestly and suggest the fix (e.g. insufficient balance, price would cross the spread).
- Order books: results may include a "note" field explaining data quality (e.g. depth unavailable, market suspended). Relay it. If a book comes back empty but the user says they can see orders in the app, NEVER insist the book is empty - tell them the API returned no data for that market and show the market title/state you found, so they can confirm it's the right one.
- Prices: users often speak in cents ("10c", "ten cents") - convert to dollars per share (0.10). Shares are also called contracts.
- Never invent market data - always read it from tools.`;

/** Tool definitions (Anthropic format). */
function toolDefs() {
  return [
    {
      name: "search_markets",
      description: "Search Polymarket for active markets matching a text query, a pasted polymarket.us link, or an exact market slug. Returns markets with their outcomes, each outcome's tokenId (needed for all trading calls), and live best bid/ask where available. Call this before trading when you don't already have the tokenId.",
      input_schema: {
        type: "object",
        properties: { query: { type: "string", description: "Free-text search (e.g. 'Fed rate cut March'), a polymarket.us URL, or a market slug" } },
        required: ["query"],
      },
    },
    {
      name: "get_order_book",
      description: "Get the live order book (best bid/ask and depth) plus tick size for an outcome token.",
      input_schema: {
        type: "object",
        properties: { tokenId: { type: "string" } },
        required: ["tokenId"],
      },
    },
    {
      name: "place_order",
      description: "Place a limit order (GTC). price is dollars per share, e.g. 0.10 for 10 cents. size is number of shares/contracts.",
      input_schema: {
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
      input_schema: {
        type: "object",
        properties: { orderId: { type: "string" } },
        required: ["orderId"],
      },
    },
    {
      name: "list_open_orders",
      description: "List the user's open orders on Polymarket.",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "get_positions",
      description: "List the user's current positions with value and PnL.",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "get_balance",
      description: "Get the user's available balance on Polymarket.",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "create_auto_outbid_rule",
      description: "Create a standing auto-outbid rule: places a BUY order and, whenever someone outbids it, instantly re-bids one tick above them - never exceeding maxPrice. Runs 24/7 in the app's background engine. Use for instructions like 'bid 10c and outbid anyone up to 20c' or '200 contracts one cent above the current best bid, up to 60c' (for the latter, OMIT startPrice - the engine starts one tick above the live best bid automatically).",
      input_schema: {
        type: "object",
        properties: {
          tokenId: { type: "string" },
          size: { type: "number", description: "Shares/contracts to buy" },
          startPrice: { type: "number", description: "Initial bid in dollars per share (0.10 = 10c). OMIT to start one tick above the current best bid." },
          maxPrice: { type: "number", description: "Hard cap in dollars per share (0.60 = 60c)" },
          expiresAt: { type: "string", description: "Optional ISO 8601 UTC datetime when the rule should auto-cancel itself and pull the order, e.g. 2026-07-12T21:00:00Z. Compute it from the current time in <context> when the user says things like 'cancel it Friday' or 'kill it after 24 hours'." },
          marketQuestion: { type: "string", description: "The market question, for display" },
          outcome: { type: "string", description: "Outcome name, e.g. Yes/No" },
        },
        required: ["tokenId", "size", "maxPrice", "marketQuestion", "outcome"],
      },
    },
    {
      name: "update_rule",
      description: "Change a standing rule's maxPrice, size, and/or expiry. Reactivates a rule that hit its cap if the new cap is higher. Set expiresAt to null to remove an expiry.",
      input_schema: {
        type: "object",
        properties: {
          ruleId: { type: "string" },
          maxPrice: { type: "number" },
          size: { type: "number" },
          expiresAt: { type: ["string", "null"], description: "New ISO 8601 auto-cancel time, or null to remove" },
        },
        required: ["ruleId"],
      },
    },
    {
      name: "cancel_rule",
      description: "Cancel a standing rule and remove its resting order.",
      input_schema: {
        type: "object",
        properties: { ruleId: { type: "string" } },
        required: ["ruleId"],
      },
    },
    {
      name: "list_rules",
      description: "List all standing rules (active and past) with their status.",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "get_activity",
      description: "Read the recent activity log - everything the background engine did (outbids, fills, cap warnings).",
      input_schema: {
        type: "object",
        properties: { limit: { type: "number", description: "Max entries, default 20" } },
      },
    },
  ];
}

export class Agent {
  constructor({ polymarket, rules, store }) {
    this.pm = polymarket;
    this.rules = rules;
    this.store = store;
    // Don't crash at boot when the key is missing - fail politely in chat instead.
    this.client = config.anthropicApiKey ? new Anthropic({ apiKey: config.anthropicApiKey }) : null;
    this.busy = false;
    this._migrateHistory();
  }

  /** Older versions stored chat history in OpenAI's message format; reset if found. */
  _migrateHistory() {
    const msgs = this.store.state.messages;
    const looksForeign = msgs.some(
      (m) => typeof m.content === "string" || m.tool_calls || !["user", "assistant"].includes(m.role),
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
    if (!this.client) throw new Error("ANTHROPIC_API_KEY is not configured - add it to your .env and restart.");
    if (this.busy) throw new Error("Assistant is still working on the previous message.");
    this.busy = true;
    try {
      const messages = this.store.state.messages;
      // Ambient context rides along with the user turn (keeps the system prompt stable/cacheable).
      const contextNote =
        `<context>now=${new Date().toISOString()} platform=${this.pm.platform === "us" ? "Polymarket US (regulated exchange)" : "Polymarket global"}` +
        ` trading=${this.pm.readonly ? "DISABLED (no key configured)" : "enabled"}` +
        `${config.dryRun ? " DRY_RUN(orders simulated)" : ""} activeRules=${this.rules.activeRules().length}</context>`;
      messages.push({ role: "user", content: [{ type: "text", text: `${contextNote}\n${userText}` }] });

      const tools = toolDefs();
      let finalText = "";

      for (let iter = 0; iter < 12; iter++) {
        const stream = this.client.messages.stream({
          model: config.model,
          max_tokens: 8000,
          system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
          tools,
          messages,
        });

        stream.on("text", (delta) => {
          finalText += delta;
          emit({ type: "text", delta });
        });

        const message = await stream.finalMessage();
        messages.push({ role: "assistant", content: message.content });
        this.store.save();

        if (message.stop_reason === "pause_turn") continue;
        if (message.stop_reason !== "tool_use") break;

        const toolUses = message.content.filter((b) => b.type === "tool_use");
        const results = [];
        for (const tu of toolUses) {
          emit({ type: "tool_start", name: tu.name, input: tu.input });
          let result;
          let isError = false;
          try {
            result = await this._runTool(tu.name, tu.input);
          } catch (err) {
            result = `Error: ${err.message}`;
            isError = true;
          }
          emit({ type: "tool_end", name: tu.name, ok: !isError });
          results.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: typeof result === "string" ? result : JSON.stringify(result ?? null),
            ...(isError ? { is_error: true } : {}),
          });
        }
        messages.push({ role: "user", content: results });
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
   * Keep chat history bounded (also keeps per-message token costs down).
   * Trim only at boundaries that start with a plain user text message so
   * tool_use/tool_result pairs are never separated.
   */
  _trimHistory() {
    const messages = this.store.state.messages;
    const MAX = 40;
    if (messages.length <= MAX) return;
    let cut = messages.length - MAX;
    while (cut < messages.length) {
      const m = messages[cut];
      const isPlainUser = m.role === "user" &&
        Array.isArray(m.content) &&
        m.content.every((b) => b.type === "text");
      if (isPlainUser) break;
      cut++;
    }
    if (cut > 0 && cut < messages.length) {
      this.store.state.messages = messages.slice(cut);
    }
  }

  resetHistory() {
    this.store.state.messages = [];
    this.store.save();
  }
}
