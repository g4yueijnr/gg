import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { extractLiveScore } from "./polymarket-us.js";

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
- NEVER reuse a market tokenId remembered from earlier in the conversation - identifiers can be stale or shortened. Take the tokenId from the LATEST search_markets result every time you trade or read a book.
- GROUND TRUTH ONLY - never guess what a market is from its slug. A slug like "astatc-fwc-nor-eng-2026-07-11-ga-fwcnonmad-gte1" is opaque; substrings like "ga", "sot", "gte1" do NOT reliably mean goals+assists, shots-on-target, or anything else. State a market's identity ONLY from the exchange-provided title: search_markets returns marketTitle/marketTitle-per-outcome, and get_order_book and place_order now return a "marketTitle" field. Quote that title verbatim. If a result has no marketTitle, say you could not confirm the exact market name - do NOT invent one from the slug.
- CONFIRM BEFORE TRADING CLOSELY-NAMED PROPS: player-prop and sports markets often have many near-identical lines (e.g. "1+ shots on target" vs "1+ goals+assists" vs "1+ shots" for the same player). Placing on the wrong one loses real money. When the user names such a market, before you place: read back the EXACT exchange marketTitle you resolved and get a yes. Never assume which line they meant.
- NEVER tell the user a market "doesn't exist" because search didn't surface it. Search can miss specific prop lines. Say "I couldn't find it via search" and ask them to paste the market link (a polymarket.us URL resolves it directly), or offer diagnose_market. The user knows their own app - if they say a market is there, believe them and keep looking, don't argue.
- After placing an order, confirm using place_order's returned marketTitle - e.g. "Resting: 5 @ 38c NO on <marketTitle>". If marketTitle came back empty, say the order is resting but you could not confirm the market name, and offer to look it up.
- "Outbid up to X" instructions are standing rules -> use create_auto_outbid_rule, not a one-off order.
- "One cent above the current highest bid" style instructions: omit startPrice on create_auto_outbid_rule - the engine reads the live book and starts one tick above the best bid at placement time. Don't read the book yourself and hardcode a price for this; the omitted-startPrice path is more accurate.
- Budget instructions ("1000 contracts at 5c, bid up to 30c, but never spend more than $150"): one rule with size=1000, startPrice=0.05, maxPrice=0.30, maxCostUsd=150. The engine shrinks the size automatically as the price climbs so spend never exceeds the budget - don't create multiple rules or do the size math yourself.
- Sell-after-fill ("when it fills, sell at 50c" / "flip fills immediately"): set onFill on the same rule - {mode:"limit", price:0.50} or {mode:"immediate"}. The engine reacts to fills in real time via the exchange's private stream, per partial fill, with no AI in the loop.
- CHANGING an existing rule (raise/lower the cap, change size, "bump it to 35c", "let it go higher"): use update_rule on that rule's id - it re-evaluates against the live book instantly. Do NOT cancel the rule and create a new one for a simple change; that churns orders and risks leaving a stray order resting. Only cancel+recreate if the market/outcome/side itself is changing.
- ONE rule per market+side: the engine REFUSES a second auto-outbid rule on a market/side that already has an active one (two would bid against each other). If create_auto_outbid_rule returns that error, do NOT retry or force it - tell the user the existing rule id and offer to update_rule it (new cap/size/budget) or cancel_rule it first. Never try to place a bare order to "add" to an existing rule's market either.
- If the user reports "two orders" / "duplicate orders" / "outbidding itself": call list_rules and list_open_orders, then if there are multiple active rules on the same market/side, cancel_rule the extras (keep one) - the engine now prevents this, but clean up any pre-existing mess. A single rule keeps exactly one order resting; you never need to place a second.
- Cancelling a rule ALWAYS pulls its resting order off the book (in any status, including error) - so "cancel it" fully stops it. One rule owns exactly one resting order at a time; you never need to hunt for a separate leftover order after cancelling a rule.
- Rules SELF-HEAL: the 24/7 engine auto-recovers a rule whose order was rejected, cancelled outside the app, or lost to a hiccup - it re-places the bid on its own and keeps the rule active. You should almost never see "error" status now. If a rule is briefly holding (e.g. the market ran past its cap, or a bid can't rest without crossing), that's the engine waiting to re-enter, not a failure - tell the user it will re-bid automatically when the market comes back into range, and offer to raise the cap/budget if they want it to compete now. Only cancel+recreate if the market/outcome/side itself is wrong.
- "Stop everything" / "cancel all" -> emergency_stop. Confirm what was cancelled from the tool result.
- After creating a rule, confirm it as a compact structured summary: market/outcome, starting bid, outbid rule, cap, size, budget, exit-on-fill, auto-cancel time, and status (say SIMULATED instead of LIVE when dry-run is on).
- Cancel conditions ("cancel it Friday night", "pull it after 24 hours"): compute an ISO UTC datetime from the current time in <context> and pass it as expiresAt. Confirm the exact time back to the user in their terms.
- After placing orders or creating rules, state exactly what is now resting: market, outcome, price, size, cap, and expiry if any.
- Report failures honestly and suggest the fix (e.g. insufficient balance, price would cross the spread).
- Order placement is verified: place_order returns verified:true only when the exchange confirmed the order is resting. If a result says dryRun/SIMULATED, the DRY_RUN setting is on - no real order was sent; tell the user to set DRY_RUN=false in their hosting variables to trade for real. If the user says an order "didn't go through", first check list_open_orders, then run diagnose_market (it now tests order placement via a no-money preview) and report the exact failing step.
- HARD RULE on liquidity claims: NEVER say a market is empty, illiquid, or "hasn't built liquidity" unless you called get_order_book on that exact tokenId in THIS turn and it came back empty. Search results only carry quotes for some outcomes - an outcome with a "quotes" note or missing bestBid/bestAsk means the quotes were NOT fetched, not that the book is empty. Read the book first, then speak.
- When the user names a market and wants info: search_markets to pin it down, then get_order_book, then give a tight live readout in one reply: best bid / best ask with sizes, top ~3 depth levels each side, the NO-side view (noBestBid/noBestAsk), and last trade. Fresh from the tools every time - never from memory.
- Order books: results may include a "note" field explaining data quality (e.g. depth unavailable, market suspended). Relay it. If a book comes back empty but the user says they can see orders in the app, NEVER insist the book is empty - immediately run diagnose_market on it and report which step failed with the raw evidence. The background engine reads the same data you do, so a broken book means broken outbidding: treat it as urgent, don't shrug it off.
- Empty book but the app shows a price? The app can display last-trade or indicative odds even when NO orders are resting. Ask the user to open the market's order book/depth view in the app and read you an actual bid - if there are no resting bids, the book really is empty and an auto-outbid rule needs an explicit starting price (there is nobody to outbid yet).
- Prices: users often speak in cents ("10c", "ten cents") - convert to dollars per share (0.10). Shares are also called contracts.
- "Bid X" / "place an order at X" means a RESTING limit order - it must NOT fill immediately. Leave fillNow=false (default). The engine refuses any order that would cross the spread; if it's refused, tell the user their price would fill instantly and ask if they want to rest lower or truly take the market. Only set fillNow=true when the user explicitly says "market", "fill now", "take it", or "buy at the ask".
- YES vs NO on Polymarket US: every market is the YES side of its question. "Buy NO" = side BUY + outcomeSide NO at the NO price (buying 100 NO at 0.60 costs $60 and pays $100 if the answer is no). NEVER translate "buy NO" into a SELL - SELL means exiting shares already owned. Order books include noBestBid/noBestAsk showing the live NO-side prices; use those when quoting NO markets. On Polymarket global, No is a separate outcome token - trade it via its own tokenId.
- "TRADE WHATEVER IS LIVE" / "trade all live ping pong" / "just trade live": use trade_all_live_pingpong (autopilot). It auto-discovers every live table-tennis match and runs the strategy on each, rediscovering new ones every 60s - no need to name matches. Pass perTradeUsd/maxExposurePerMatch/maxConcurrent only if the user gives numbers. Confirm it's on and that it only trades matches it can read a live score for. To halt, use stop_all_pingpong.
- PING-PONG / SETKA CUP strategy (a SPECIFIC match): for "trade this match off the cheat sheet" style requests, use create_pingpong_strategy on the match market's token (resolve it with search_markets; playerA = the YES side, playerB = the NO side). The engine then runs fully automatically - it reads the live score on its own and keeps a single edge-discounted limit resting on the model's favorite, re-quoting every time the score changes, holding fills to expiry, within the per-trade stake and max-exposure caps. Defaults: $0.25/quote, $20 max exposure, 20%->10% edge, 10s quote life, score read every 3s - only override when the user gives numbers. Confirm the strategy back with those settings. If a strategy warns it isn't getting a live score, run dump_match_data on that token and report the score-looking fields so the reader can be pointed at the right one. One strategy per match market. Never place manual one-off orders to 'help' a strategy.
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
      description: "Get the live order book (best bid/ask and depth) plus tick size for an outcome token. Also returns marketTitle - the exchange's real name for this market. Always report that title so you never mis-describe which market you're quoting.",
      input_schema: {
        type: "object",
        properties: { tokenId: { type: "string" } },
        required: ["tokenId"],
      },
    },
    {
      name: "place_order",
      description: "Place a limit order (GTC). price is dollars per share, e.g. 0.10 for 10 cents. size is number of shares/contracts. On Polymarket US, 'buy NO' is side=BUY + outcomeSide=NO with the NO price - NEVER a SELL (selling exits shares you own). Returns marketTitle (the exchange's real name for the market the order landed on) - always confirm the order using that title, not the slug.",
      input_schema: {
        type: "object",
        properties: {
          tokenId: { type: "string" },
          side: { type: "string", enum: ["BUY", "SELL"], description: "BUY opens/adds a position, SELL exits one you own" },
          outcomeSide: { type: "string", enum: ["YES", "NO"], description: "Polymarket US only: which side of the market. Default YES. For NO, price is the NO price (the engine converts to the exchange's YES-terms automatically). On Polymarket global, use the No outcome's own tokenId instead." },
          price: { type: "number", description: "Limit price in the chosen side's terms (NO price for a NO order). A BUY below the ask RESTS; it does not fill immediately." },
          size: { type: "number" },
          fillNow: { type: "boolean", description: "Default false. Leave false for a resting limit order ('bid X') - the engine will REFUSE an order that would cross the spread and fill immediately. Set true ONLY when the user explicitly wants to take the market / fill right now at a worse price." },
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
          outcomeSide: { type: "string", enum: ["YES", "NO"], description: "Polymarket US only: bid on YES (default) or NO. For NO, all prices are NO prices and the engine outbids competing NO bidders. On Polymarket global, use the No outcome's own tokenId instead." },
          maxCostUsd: { type: "number", description: "Optional total dollar budget for the rule. As the price rises, the engine automatically shrinks the order size so price x size never exceeds this (e.g. size 1000 with $150 budget: 1000 contracts at 5c, ~500 at 30c). Use when the user says 'don't spend more than $X'." },
          onFill: {
            type: "object",
            description: "Optional sell-after-fill: what the engine does the moment contracts fill (works per partial fill, in real time). {mode:'limit', price:0.50} rests a sell at 50c for each fill; {mode:'immediate'} sells each fill into the live best bid instantly. Omit for no automatic exit.",
            properties: {
              mode: { type: "string", enum: ["limit", "immediate"] },
              price: { type: "number", description: "Required for mode=limit: exit price in dollars per share" },
            },
            required: ["mode"],
          },
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
      name: "emergency_stop",
      description: "EMERGENCY STOP: cancels every standing rule AND every open order on the account, immediately. Use when the user says 'stop everything', 'cancel all', 'emergency stop', 'get me out'.",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "set_trading_mode",
      description: "Switch between LIVE trading and DRY RUN (simulated orders). Overrides the DRY_RUN environment variable and persists across restarts. Use when the user says 'go live', 'turn off dry run', 'stop simulating' (live=true) or 'back to practice mode' (live=false). Confirm the new mode clearly - in live mode every order is real money.",
      input_schema: {
        type: "object",
        properties: { live: { type: "boolean", description: "true = real orders, false = simulated" } },
        required: ["live"],
      },
    },
    {
      name: "diagnose_market",
      description: "Run a full data-path diagnostic against the exchange: connectivity, search, market lookup, order book, quotes, auth, and websocket state - with raw API responses. Use whenever market data looks wrong (empty books, missing markets, stale prices) or the user reports the bot 'can't see' something. Relay the failing step and raw evidence to the user.",
      input_schema: {
        type: "object",
        properties: { query: { type: "string", description: "The market to test: text, polymarket link, or slug" } },
        required: ["query"],
      },
    },
    {
      name: "get_activity",
      description: "Read the recent activity log - everything the background engine did (outbids, fills, cap warnings).",
      input_schema: {
        type: "object",
        properties: { limit: { type: "number", description: "Max entries, default 20" } },
      },
    },
    {
      name: "create_pingpong_strategy",
      description: "Start an automated ping-pong (Setka Cup) live-quoting strategy on ONE match market. The background engine reads the live score by itself and keeps a single edge-discounted BUY limit resting on whichever player the cheat-sheet model favors at the current score, re-quoting automatically every time the score changes. Fills are held to expiry. Use for 'trade this match off the cheat sheet' requests. tokenId is the match market's outcome token (its YES = playerA). Resolve it with search_markets first.",
      input_schema: {
        type: "object",
        properties: {
          tokenId: { type: "string", description: "The match market's outcome token (YES = playerA wins)" },
          playerA: { type: "string", description: "Name of the YES-side player" },
          playerB: { type: "string", description: "Name of the NO-side player" },
          perTradeUsd: { type: "number", description: "Dollars staked per individual quote. Default 0.25." },
          maxExposureUsd: { type: "number", description: "Hard cap on total money at work in this strategy. Default 20." },
          edgeEarly: { type: "number", description: "Safety discount off fair value early in the match (0.20 = 20%). Default 0.20." },
          edgeLate: { type: "number", description: "Safety discount late in the match (0.10 = 10%). Default 0.10." },
          orderTtlSec: { type: "number", description: "Seconds an unfilled quote rests before auto-pull. Default 10." },
          pollSec: { type: "number", description: "How often (seconds) to re-read the live score. Default 3." },
        },
        required: ["tokenId"],
      },
    },
    {
      name: "trade_all_live_pingpong",
      description: "AUTOPILOT: automatically find EVERY live table-tennis / Setka Cup match and run the cheat-sheet strategy on each one, hands-free. Rediscovers new live matches every 60s and only trades matches it can read a live score for. Use for 'just trade whatever is live' / 'trade all live ping pong' requests. Each match gets its own per-match exposure cap.",
      input_schema: {
        type: "object",
        properties: {
          perTradeUsd: { type: "number", description: "Stake per quote. Default 0.25." },
          maxExposurePerMatch: { type: "number", description: "Max money at work per match. Default 5." },
          maxConcurrent: { type: "number", description: "Max simultaneous live matches to trade. Default 8." },
          query: { type: "string", description: "Search phrase for finding matches. Default 'Setka Cup table tennis'." },
        },
      },
    },
    {
      name: "stop_all_pingpong",
      description: "Turn OFF ping-pong autopilot. By default leaves running strategies alone; set stopStrategies=true to also stop every active strategy and pull their quotes.",
      input_schema: {
        type: "object",
        properties: { stopStrategies: { type: "boolean", description: "Also stop all active strategies (default false)." } },
      },
    },
    {
      name: "list_pingpong_strategies",
      description: "List all ping-pong live-quoting strategies with their live score, current quote, filled/held exposure, and status.",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "stop_pingpong_strategy",
      description: "Stop a ping-pong strategy: pulls its resting quote and stops auto-quoting. Filled positions are kept and ride to settlement.",
      input_schema: {
        type: "object",
        properties: { strategyId: { type: "string" } },
        required: ["strategyId"],
      },
    },
    {
      name: "dump_match_data",
      description: "Diagnostic: probe the exchange for a match's live score. Returns scoreHunt (every score-looking field path + value found in the market AND event JSON), extractedScore (what the reader parsed, or null), errors, and the market/event key lists. Use when a ping-pong strategy isn't getting a live score. RELAY scoreHunt VERBATIM (each path and value) and whether eventPresent is true - that's what pinpoints the score field.",
      input_schema: {
        type: "object",
        properties: { tokenId: { type: "string" } },
        required: ["tokenId"],
      },
    },
  ];
}

export class Agent {
  constructor({ polymarket, rules, store, pingpong }) {
    this.pm = polymarket;
    this.rules = rules;
    this.store = store;
    this.pingpong = pingpong || null;
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
      case "place_order": return this.pm.placeOrder({ ...input, allowMarketable: !!input.fillNow });
      case "cancel_order": return this.pm.cancelOrder(input.orderId);
      case "list_open_orders": return this.pm.getOpenOrders();
      case "get_positions": return this.pm.getPositions();
      case "get_balance": return this.pm.getBalance();
      case "create_auto_outbid_rule": return this.rules.createAutoOutbid(input);
      case "update_rule": return this.rules.updateRule(input.ruleId, input);
      case "cancel_rule": return this.rules.cancelRule(input.ruleId);
      case "list_rules": return this.rules.listRules();
      case "diagnose_market": return this.pm.diagnose(input.query);
      case "emergency_stop": return this.rules.emergencyStop();
      case "set_trading_mode": {
        config.dryRun = !input.live;
        this.store.state.settings.dryRun = !input.live;
        this.store.save();
        const entry = this.store.addActivity("system",
          input.live ? "TRADING MODE: LIVE - orders are real from now on." : "TRADING MODE: DRY RUN - orders are simulated.",
          { level: "warn" });
        return { mode: input.live ? "LIVE" : "DRY_RUN", note: entry.text };
      }
      case "get_activity": {
        const limit = input.limit || 20;
        return this.store.state.activity.slice(-limit);
      }
      case "create_pingpong_strategy":
        if (!this.pingpong) throw new Error("Ping-pong strategy engine is not available.");
        return this.pingpong.createStrategy(input);
      case "trade_all_live_pingpong":
        if (!this.pingpong) throw new Error("Ping-pong strategy engine is not available.");
        return this.pingpong.startAutopilot(input);
      case "stop_all_pingpong":
        if (!this.pingpong) throw new Error("Ping-pong strategy engine is not available.");
        return this.pingpong.stopAutopilot({ alsoStopStrategies: !!input.stopStrategies });
      case "list_pingpong_strategies":
        if (!this.pingpong) throw new Error("Ping-pong strategy engine is not available.");
        return this.pingpong.listStrategies();
      case "stop_pingpong_strategy":
        if (!this.pingpong) throw new Error("Ping-pong strategy engine is not available.");
        return this.pingpong.stopStrategy(input.strategyId);
      case "dump_match_data": {
        const tok = this.pm.canonicalTokenId ? await this.pm.canonicalTokenId(input.tokenId) : input.tokenId;
        const raw = await this.pm.dumpMatchData(tok);
        const m = raw.market?.market || raw.market || {};
        const ev = raw.event?.event || raw.event || {};
        // High-signal, compact result: the score-hunt hits are the whole point.
        return {
          slug: tok,
          outcome: m.outcome ?? null,
          scoreHunt: raw.scoreHunt,                 // <-- every score-looking field + value
          extractedScore: (() => { try { return extractLiveScore(raw, m.outcome); } catch { return null; } })(),
          errors: raw.errors,
          marketKeys: Object.keys(m),
          eventKeys: Object.keys(ev),
          eventPresent: !!raw.event,
        };
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
          // Chat replies are short confirmations, not essays. Capping output low
          // is the single biggest credit saver: you only pay for tokens you use,
          // but a runaway model can burn thousands per reply. 1500 is plenty for
          // "placed your bid" style answers and still fits a full order book dump.
          max_tokens: 1500,
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
    // Every past message is re-sent (and re-billed) on each new turn, so a long
    // memory quietly multiplies cost. 16 keeps enough recent context to stay
    // coherent while cutting the per-turn token bill roughly in half vs 40.
    const MAX = 16;
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
