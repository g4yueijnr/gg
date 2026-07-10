import { PolymarketUS } from "polymarket-us";
import { config } from "./config.js";

/**
 * The exchange's REST/WS payloads are enveloped inconsistently (and the SDK's
 * declared types don't always match the wire format - most endpoints wrap
 * their payload, e.g. {market: {...}}, {order: {...}}). Accept every plausible
 * shape so a wrapper or renamed field can never read as an "empty book" again.
 */
function unwrapBook(raw) {
  const b = raw?.book || raw?.marketBook || raw?.market_book || raw?.data || raw || {};
  return {
    bids: b.bids || b.buys || [],
    asks: b.offers || b.asks || b.sells || [],
    stats: b.stats,
    state: b.state,
  };
}

function unwrapBbo(raw) {
  const b = raw?.bbo || raw?.marketBbo || raw?.market_bbo || raw?.data || raw || {};
  return {
    bestBid: b.bestBid ?? b.best_bid ?? b.bid,
    bestAsk: b.bestAsk ?? b.best_ask ?? b.ask ?? b.offer,
    bidDepth: b.bidDepth ?? b.bid_depth,
    askDepth: b.askDepth ?? b.ask_depth,
    lastTradePx: b.lastTradePx ?? b.last_trade_px ?? b.lastTradePrice,
  };
}

function levelPrice(l) { return l.px ?? l.price ?? l.p; }
function levelQty(l) { return l.qty ?? l.quantity ?? l.size ?? l.q; }

/**
 * Polymarket US (the CFTC-regulated exchange behind the US app) client.
 * Exposes the exact same interface as the global client in polymarket.js,
 * so the rules engine / agent / server don't care which one is running.
 *
 * Markets here are identified by their SLUG (e.g. "fed-cut-march-yes");
 * we carry it in the same `tokenId` field the rest of the app already uses.
 */
export class PolymarketUSClient {
  constructor(api = null) {
    this.platform = "us";
    this.ready = false;
    this.readonly = !config.polymarketUsKeyId || !config.polymarketUsSecret;
    this.funder = this.readonly ? null : "Polymarket US account";
    this.api = api || new PolymarketUS({
      keyId: config.polymarketUsKeyId || undefined,
      secretKey: config.polymarketUsSecret || undefined,
    });

    // Some deployments quote prices in dollars ("0.55"), the exchange may use
    // cents ("55"). We detect from live data and convert transparently -
    // the rest of the app always works in dollars per share (0-1).
    this.priceScale = 1;

    this.books = new Map();           // slug -> {bestBid, bestAsk, ts}
    this.bookListeners = new Set();
    this.orderMarketSlugs = new Map(); // orderId -> marketSlug (cancel needs both)

    this.ws = null;
    this.wsWanted = new Set();
    this.wsReconnectDelay = 1000;
    this._wsConnecting = false;

    // Poll backstop: guarantees book updates for watched markets even if the
    // websocket is down/silent. lastBookAt tracks freshness per market.
    this.lastBookAt = new Map();
    this._pollTimer = null;
  }

  async init() {
    if (this.readonly) {
      console.warn("[polymarket-us] POLYMARKET_US_KEY_ID / POLYMARKET_US_SECRET_KEY not set - read-only mode (no trading).");
    } else {
      console.log("[polymarket-us] trading enabled (Polymarket US)");
    }
    // Connectivity self-test so hosting logs immediately show whether the
    // exchange API is reachable from this server.
    try {
      await this.api.events.list({ limit: 1 });
      this.apiOk = true;
      console.log("[polymarket-us] API connectivity OK (public market data reachable)");
    } catch (err) {
      this.apiOk = false;
      this.apiError = err.message;
      console.error(`[polymarket-us] API CONNECTIVITY FAILED: ${err.message} - market data will not work until this is resolved.`);
    }
    this.ready = true;
  }

  _toDollars(amount) {
    if (amount === undefined || amount === null) return null;
    let v;
    if (typeof amount === "object") {
      if (amount.units !== undefined || amount.nanos !== undefined) {
        // protobuf-style Money: {units, nanos}
        v = Number(amount.units || 0) + Number(amount.nanos || 0) / 1e9;
      } else {
        v = Number(amount.value ?? amount.amount ?? amount.px);
      }
    } else {
      v = Number(amount);
    }
    if (Number.isNaN(v)) return null;
    // These contracts always trade strictly below $1, so any value >= 1 must be
    // cents quoting (e.g. "55" = 55c, and "1" = 1c - never $1).
    if (v >= 1) this.priceScale = 100;
    return this.priceScale === 100 || v >= 1 ? v / 100 : v;
  }

  _fromDollars(price) {
    const v = this.priceScale === 100 ? Math.round(price * 100) : Math.round(price * 100) / 100;
    return { value: String(v), currency: "USD" };
  }

  // ---------- market discovery ----------

  async searchMarkets(query, limit = 8) {
    // Pasted a polymarket.us link or an exact slug? Resolve it directly.
    const direct = await this._resolveDirect(query);
    if (direct) return [direct];

    const res = await this.api.search.query({ query, status: "active", limit });
    const out = [];
    for (const event of res.events || []) {
      // NB: search results may omit the `active` flag entirely - only drop
      // markets that are explicitly inactive/closed.
      const markets = (event.markets || []).filter((m) => m.active !== false && m.closed !== true && m.slug);
      if (!markets.length) continue;
      out.push({
        question: event.title,
        eventTitle: event.title,
        slug: event.slug,
        endDate: event.endTime,
        volume: event.volume,
        liquidity: event.liquidity,
        outcomes: markets.map((m) => ({
          outcome: m.outcome || m.title,
          marketTitle: m.title,
          tokenId: m.slug, // slug is the trading identifier on Polymarket US
        })),
      });
    }
    const results = out.slice(0, limit);
    // Search truncates each event's market list - fetch full events so every
    // prop (e.g. "before round 4") is present, not just the popular ones.
    await Promise.all(results.slice(0, 3).map(async (r) => {
      if (!r.slug) return;
      try {
        const full = await this.api.events.retrieveBySlug(r.slug);
        const markets = (full?.event?.markets || []).filter((mk) => mk.active !== false && mk.closed !== true && mk.slug);
        if (markets.length > r.outcomes.length) {
          r.outcomes = markets.slice(0, 25).map((mk) => ({
            outcome: mk.outcome || mk.title,
            marketTitle: mk.title,
            tokenId: mk.slug,
          }));
        }
      } catch { /* keep the search-provided subset */ }
    }));
    await this._attachQuotes(results);
    return results;
  }

  /** Add live best bid/ask to search results so the assistant sees real prices immediately. */
  async _attachQuotes(results) {
    const outcomes = results.flatMap((r) => r.outcomes).slice(0, 12);
    await Promise.all(outcomes.map(async (o) => {
      try {
        const bbo = unwrapBbo(await this.api.markets.bbo(o.tokenId));
        o.bestBid = this._toDollars(bbo.bestBid);
        o.bestAsk = this._toDollars(bbo.bestAsk);
        o.lastPrice = this._toDollars(bbo.lastTradePx);
      } catch { /* quote unavailable; leave blank */ }
    }));
  }

  /** Resolve a pasted polymarket.us URL or bare slug straight to its market(s). */
  async _resolveDirect(query) {
    const m = String(query).trim().match(/(?:polymarket\.us\/(?:event|market)s?\/)?([a-z0-9]+(?:-[a-z0-9]+)+)\/?(?:[?#].*)?$/i);
    if (!m) return null;
    const slug = m[1].toLowerCase();
    try {
      const r = await this.api.markets.retrieveBySlug(slug);
      if (r?.market && !r.market.closed) {
        const result = {
          question: r.market.title,
          eventTitle: r.market.title,
          slug: r.market.eventSlug || r.market.slug,
          outcomes: [{ outcome: r.market.outcome || r.market.title, marketTitle: r.market.title, tokenId: r.market.slug }],
        };
        await this._attachQuotes([result]);
        return result;
      }
    } catch { /* not a market slug */ }
    try {
      const r = await this.api.events.retrieveBySlug(slug);
      const markets = (r?.event?.markets || []).filter((mk) => mk.active !== false && mk.closed !== true && mk.slug);
      if (markets.length) {
        const result = {
          question: r.event.title,
          eventTitle: r.event.title,
          slug: r.event.slug,
          endDate: r.event.endTime,
          outcomes: markets.map((mk) => ({ outcome: mk.outcome || mk.title, marketTitle: mk.title, tokenId: mk.slug })),
        };
        await this._attachQuotes([result]);
        return result;
      }
    } catch { /* not an event slug either */ }
    return null;
  }

  async getMarketByToken(slug) {
    const res = await this.api.markets.retrieveBySlug(slug);
    const m = res?.market;
    if (!m) return null;
    return {
      question: m.title,
      slug: m.slug,
      outcome: m.outcome,
      closed: !!m.closed,
      outcomes: [{ outcome: m.outcome || m.title, tokenId: m.slug }],
    };
  }

  // ---------- order book / prices ----------

  async getOrderBook(slug) {
    // Primary: full depth from the book endpoint (normalized across the
    // envelope/field-name variants the exchange may use).
    let book = null;
    let bookErr = null;
    try {
      book = unwrapBook(await this.api.markets.book(slug));
    } catch (err) {
      bookErr = err;
    }
    if (book && (book.bids.length || book.asks.length)) {
      const s = this._summarizeBook(slug, book.bids, book.asks, book.stats?.lastTradePx);
      s.state = book.state;
      return s;
    }

    // Fallback: best bid/offer endpoint (some deployments serve quotes here even
    // when the depth endpoint comes back empty).
    try {
      const bbo = unwrapBbo(await this.api.markets.bbo(slug));
      const bestBid = this._toDollars(bbo.bestBid);
      const bestAsk = this._toDollars(bbo.bestAsk);
      if (bestBid !== null || bestAsk !== null) {
        const summary = {
          tokenId: slug,
          bestBid, bestAsk,
          noBestBid: bestAsk !== null ? Math.round((1 - bestAsk) * 1000) / 1000 : null,
          noBestAsk: bestBid !== null ? Math.round((1 - bestBid) * 1000) / 1000 : null,
          bids: bestBid !== null ? [{ price: bestBid, size: bbo.bidDepth ?? null }] : [],
          asks: bestAsk !== null ? [{ price: bestAsk, size: bbo.askDepth ?? null }] : [],
          tickSize: 0.01,
          lastTradePrice: this._toDollars(bbo.lastTradePx),
          note: "Full depth unavailable from the book endpoint - showing live best bid/ask.",
        };
        this.books.set(slug, { bestBid, bestAsk, ts: Date.now() });
        this.lastBookAt.set(slug, Date.now());
        return summary;
      }
    } catch { /* fall through to diagnosis */ }

    // Still nothing: figure out WHY so the assistant can say something useful
    // instead of pretending the market is empty.
    console.warn(`[polymarket-us] empty book for "${slug}"; raw book=${JSON.stringify(book || null).slice(0, 300)}${bookErr ? ` err=${bookErr.message}` : ""}`);
    let title = null;
    let state = book?.state;
    try {
      const r = await this.api.markets.retrieveBySlug(slug);
      title = r?.market?.title;
      if (r?.market?.closed) state = state || "CLOSED";
    } catch (err) {
      if (err?.status === 404) {
        throw new Error(`No market exists with slug "${slug}". The identifier may be wrong - use search_markets (or paste the market link) to get the exact tokenId.`);
      }
    }
    return {
      tokenId: slug,
      bestBid: null, bestAsk: null, bids: [], asks: [],
      tickSize: 0.01,
      state,
      note: title
        ? `Market "${title}" exists but both quote endpoints returned no orders (state: ${state || "unknown"}). If the app clearly shows orders, this is a data issue - tell the user exactly that rather than claiming the book is empty.`
        : "No order data returned.",
    };
  }

  _summarizeBook(slug, rawBids, rawAsks, lastTradePx) {
    const bids = rawBids.map((l) => ({ price: this._toDollars(levelPrice(l)), size: Number(levelQty(l)) }))
      .filter((l) => l.price !== null)
      .sort((a, b) => b.price - a.price);
    const asks = rawAsks.map((l) => ({ price: this._toDollars(levelPrice(l)), size: Number(levelQty(l)) }))
      .filter((l) => l.price !== null)
      .sort((a, b) => a.price - b.price);
    const summary = {
      tokenId: slug,
      bestBid: bids[0]?.price ?? null,
      bestAsk: asks[0]?.price ?? null,
      bids: bids.slice(0, 8),
      asks: asks.slice(0, 8),
      tickSize: 0.01, // Polymarket US trades in penny increments
      lastTradePrice: this._toDollars(lastTradePx),
    };
    // NO-side view of the same book (buying NO = shorting YES): the best NO
    // bid mirrors the YES ask, and vice versa.
    summary.noBestBid = summary.bestAsk !== null ? Math.round((1 - summary.bestAsk) * 1000) / 1000 : null;
    summary.noBestAsk = summary.bestBid !== null ? Math.round((1 - summary.bestBid) * 1000) / 1000 : null;
    this.books.set(slug, { bestBid: summary.bestBid, bestAsk: summary.bestAsk, ts: Date.now() });
    this.lastBookAt.set(slug, Date.now());
    return summary;
  }

  async getTickSize() {
    return 0.01;
  }

  // ---------- trading ----------

  _assertTradable() {
    if (this.readonly) {
      throw new Error("Trading is disabled: POLYMARKET_US_KEY_ID / POLYMARKET_US_SECRET_KEY are not configured.");
    }
  }

  checkLimits({ price, size }) {
    if (size > config.maxOrderSizeShares) {
      throw new Error(`Order size ${size} exceeds MAX_ORDER_SIZE_SHARES (${config.maxOrderSizeShares}).`);
    }
    const cost = price * size;
    if (cost > config.maxOrderCostUsd) {
      throw new Error(`Order cost $${cost.toFixed(2)} exceeds MAX_ORDER_COST_USD ($${config.maxOrderCostUsd}).`);
    }
  }

  /**
   * Place a limit order. On Polymarket US every market is the YES side of its
   * question; NO positions are the SHORT intents on the same market.
   *   BUY  + YES -> BUY_LONG      BUY  + NO -> BUY_SHORT
   *   SELL + YES -> SELL_LONG     SELL + NO -> SELL_SHORT
   * For NO orders, `price` is the NO price (what you pay per NO share).
   */
  async placeOrder({ tokenId, side, price, size, outcomeSide = "YES" }) {
    this._assertTradable();
    this.checkLimits({ price, size });
    const short = String(outcomeSide).toUpperCase() === "NO";
    const sell = String(side).toUpperCase() === "SELL";
    const intent = short
      ? (sell ? "ORDER_INTENT_SELL_SHORT" : "ORDER_INTENT_BUY_SHORT")
      : (sell ? "ORDER_INTENT_SELL_LONG" : "ORDER_INTENT_BUY_LONG");
    if (config.dryRun) {
      return { success: true, dryRun: true, orderID: `dry-${Date.now()}`, status: "live (dry run)", intent };
    }
    const resp = await this.api.orders.create({
      marketSlug: tokenId,
      intent,
      type: "ORDER_TYPE_LIMIT",
      price: this._fromDollars(price),
      quantity: size,
      tif: "TIME_IN_FORCE_GOOD_TILL_CANCEL",
    });
    this.orderMarketSlugs.set(resp.id, tokenId);
    return { success: true, orderID: resp.id, intent };
  }

  async cancelOrder(orderId) {
    this._assertTradable();
    if (config.dryRun) return { canceled: [orderId], dryRun: true };
    let slug = this.orderMarketSlugs.get(orderId);
    if (!slug) {
      const res = await this.api.orders.retrieve(orderId);
      slug = res?.order?.marketSlug;
    }
    if (!slug) throw new Error(`Can't find the market for order ${orderId}.`);
    await this.api.orders.cancel(orderId, { marketSlug: slug });
    return { canceled: [orderId] };
  }

  async getOpenOrders() {
    this._assertTradable();
    const res = await this.api.orders.list();
    return (res.orders || []).map((o) => {
      this.orderMarketSlugs.set(o.id, o.marketSlug);
      const intent = o.intent || "";
      const sell = intent.includes("SELL") || o.side === "ORDER_SIDE_SELL";
      const short = intent.includes("SHORT");
      return {
        orderId: o.id,
        tokenId: o.marketSlug,
        market: o.marketMetadata?.title || o.marketSlug,
        side: `${sell ? "SELL" : "BUY"}${short ? " NO" : ""}`,
        outcomeSide: short ? "NO" : "YES",
        price: this._toDollars(o.price),
        size: o.quantity,
        filled: o.cumQuantity || 0,
        outcome: o.marketMetadata?.outcome || "",
        createdAt: o.createTime,
      };
    });
  }

  /** Normalized to what the rules engine expects: {status, size_matched}. */
  async getOrder(orderId) {
    this._assertTradable();
    let res;
    try {
      res = await this.api.orders.retrieve(orderId);
    } catch (err) {
      if (err?.status === 404) return null; // gone
      throw err; // transient - caller decides
    }
    const o = res?.order;
    if (!o) return null;
    const LIVE_STATES = new Set([
      "ORDER_STATE_NEW", "ORDER_STATE_PENDING_NEW", "ORDER_STATE_PARTIALLY_FILLED",
      "ORDER_STATE_PENDING_REPLACE", "ORDER_STATE_PENDING_RISK",
    ]);
    return {
      id: o.id,
      status: LIVE_STATES.has(o.state) ? "LIVE" : o.state.replace("ORDER_STATE_", ""),
      size_matched: o.cumQuantity || 0,
      price: this._toDollars(o.price),
    };
  }

  async getBalance() {
    this._assertTradable();
    const res = await this.api.account.balances();
    const b = res?.balances?.[0];
    return b ? { usd: b.currentBalance, buyingPower: b.buyingPower } : { usd: null };
  }

  async getPositions() {
    this._assertTradable();
    const res = await this.api.portfolio.positions();
    const out = [];
    for (const [slug, p] of Object.entries(res?.positions || {})) {
      out.push({
        market: p.marketMetadata?.title || slug,
        outcome: p.marketMetadata?.outcome || "",
        tokenId: slug,
        size: Number(p.netPosition),
        costUsd: this._toDollars(p.cost),
        valueUsd: this._toDollars(p.cashValue),
        realizedPnlUsd: this._toDollars(p.realized),
      });
    }
    return out.filter((p) => p.size !== 0);
  }

  // ---------- real-time market feed ----------

  onBookUpdate(fn) {
    this.bookListeners.add(fn);
    return () => this.bookListeners.delete(fn);
  }

  watchToken(slug) {
    if (this.wsWanted.has(slug)) return;
    this.wsWanted.add(slug);
    this._ensureWs(true);
    this._ensurePolling();
  }

  unwatchToken(slug) {
    this.wsWanted.delete(slug);
    if (this.wsWanted.size === 0) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  /**
   * REST polling backstop. Every 3s, any watched market whose book hasn't
   * updated (via websocket or otherwise) in >4s gets a fresh BBO fetch.
   * With a healthy websocket this does nothing; if the socket is down or
   * silently broken, outbid detection still works within a few seconds.
   */
  _ensurePolling() {
    if (this._pollTimer) return;
    this._pollTimer = setInterval(async () => {
      const now = Date.now();
      const stale = [...this.wsWanted].filter((s) => now - (this.lastBookAt.get(s) || 0) > 4000);
      // stay well inside public rate limits even with many rules
      for (const slug of stale.slice(0, 5)) {
        this.lastBookAt.set(slug, now); // claim before fetch so a slow request isn't re-fetched next tick
        try {
          const bbo = unwrapBbo(await this.api.markets.bbo(slug));
          const bestBid = this._toDollars(bbo.bestBid);
          const bestAsk = this._toDollars(bbo.bestAsk);
          if (bestBid === null && bestAsk === null) continue;
          const prev = this.books.get(slug);
          this.books.set(slug, { bestBid, bestAsk, ts: now });
          if (!prev || prev.bestBid !== bestBid || prev.bestAsk !== bestAsk) {
            const summary = { tokenId: slug, bestBid, bestAsk, bids: [], asks: [], tickSize: 0.01, viaPoll: true };
            for (const fn of this.bookListeners) {
              try { fn(summary); } catch (err) { console.error("[polymarket-us] book listener error:", err); }
            }
          }
        } catch { /* transient; next tick retries */ }
      }
    }, 3000);
    if (this._pollTimer.unref) this._pollTimer.unref();
  }

  _ensureWs(resubscribe = false) {
    if (this.wsWanted.size === 0) return;
    if (this.ws && this.ws.isConnected) {
      if (resubscribe) this._subscribe();
      return;
    }
    if (this._wsConnecting) return;
    this._connectWs();
  }

  async _connectWs() {
    this._wsConnecting = true;
    try {
      const ws = this.api.ws.markets();
      this.ws = ws;
      ws.on("marketData", (msg) => {
        const d = msg.marketData || msg.market_data || msg.data || msg;
        const slug = d?.marketSlug || d?.market_slug;
        if (!slug) return;
        const nb = unwrapBook(d);
        const summary = this._summarizeBook(slug, nb.bids, nb.asks, nb.stats?.lastTradePx);
        for (const fn of this.bookListeners) {
          try { fn(summary); } catch (err) { console.error("[polymarket-us] book listener error:", err); }
        }
      });
      ws.on("error", (err) => console.warn("[polymarket-us] market feed error:", err.message));
      ws.on("close", () => {
        console.warn("[polymarket-us] market feed disconnected, reconnecting...");
        const delay = this.wsReconnectDelay;
        this.wsReconnectDelay = Math.min(this.wsReconnectDelay * 2, 30000);
        setTimeout(() => this._ensureWs(true), delay);
      });
      await ws.connect();
      this.wsReconnectDelay = 1000;
      this._subscribe();
      console.log("[polymarket-us] market feed connected");
    } catch (err) {
      console.warn("[polymarket-us] market feed connect failed:", err.message);
      const delay = this.wsReconnectDelay;
      this.wsReconnectDelay = Math.min(this.wsReconnectDelay * 2, 30000);
      setTimeout(() => this._ensureWs(true), delay);
    } finally {
      this._wsConnecting = false;
    }
  }

  _subscribe() {
    if (!this.ws || !this.ws.isConnected) return;
    try {
      // Replace the previous subscription instead of stacking duplicates.
      if (this._mdReqId) {
        try { this.ws.unsubscribe(this._mdReqId); } catch { /* already gone */ }
      }
      this._mdReqId = `md-${Date.now()}`;
      this.ws.subscribeMarketData(this._mdReqId, [...this.wsWanted]);
    } catch (err) {
      console.warn("[polymarket-us] subscribe failed:", err.message);
    }
  }

  stop() {
    this.wsWanted.clear();
    clearInterval(this._pollTimer);
    this._pollTimer = null;
    try { this.ws?.close(); } catch { /* noop */ }
  }

  /**
   * Full data-path diagnostic, runnable from the chat. Exercises every
   * endpoint the bot depends on and returns RAW (truncated) responses so
   * problems can be pinpointed from a live deployment.
   */
  async diagnose(query) {
    const out = { platform: "us", query, steps: [] };
    const step = async (name, fn) => {
      try {
        const raw = await fn();
        out.steps.push({ name, ok: true, raw: JSON.stringify(raw)?.slice(0, 900) });
        return raw;
      } catch (err) {
        out.steps.push({ name, ok: false, error: `${err.status || ""} ${err.message}`.trim() });
        return null;
      }
    };

    await step("connectivity: events.list(limit 1)", () => this.api.events.list({ limit: 1 }));
    const search = await step(`search.query("${query}")`, () => this.api.search.query({ query, status: "active", limit: 3 }));

    // pull candidate market slugs from search or treat query as slug/link
    const slugs = new Set();
    const m = String(query).trim().match(/(?:polymarket\.us\/(?:event|market)s?\/)?([a-z0-9]+(?:-[a-z0-9]+)+)\/?(?:[?#].*)?$/i);
    if (m) slugs.add(m[1].toLowerCase());
    for (const ev of search?.events || []) {
      for (const mk of ev.markets || []) if (mk.slug) slugs.add(mk.slug);
    }
    out.candidateSlugs = [...slugs].slice(0, 3);

    for (const slug of out.candidateSlugs) {
      await step(`markets.retrieveBySlug("${slug}")`, () => this.api.markets.retrieveBySlug(slug));
      await step(`markets.book("${slug}")`, () => this.api.markets.book(slug));
      await step(`markets.bbo("${slug}")`, () => this.api.markets.bbo(slug));
    }
    if (!this.readonly) {
      await step("auth check: account.balances()", () => this.api.account.balances());
      await step("auth check: orders.list()", () => this.api.orders.list());
    } else {
      out.steps.push({ name: "auth check", ok: false, error: "skipped - no API keys configured" });
    }

    // Websocket probe: the live feed is a separate data source from the REST
    // book/bbo endpoints - it can carry quotes even when those come back empty.
    if (!this.readonly && out.candidateSlugs.length) {
      const probe = await new Promise((resolve) => {
        let ws = null;
        const seen = new Set();
        const finish = (result) => {
          clearTimeout(timer);
          try { ws?.close(); } catch { /* noop */ }
          resolve(result);
        };
        const timer = setTimeout(() => {
          resolve({ ok: seen.size > 0, receivedFor: [...seen], note: seen.size ? "live data flowing" : "no live data within 6s (may be normal for quiet markets)" });
          try { ws?.close(); } catch { /* noop */ }
        }, 6000);
        try {
          ws = this.api.ws.markets();
          ws.on("marketData", (m) => {
            const s = m.marketData?.marketSlug;
            if (s) seen.add(s);
            if (seen.size >= out.candidateSlugs.length) finish({ ok: true, receivedFor: [...seen] });
          });
          ws.on("error", () => { /* reported via timeout */ });
          ws.connect()
            .then(() => ws.subscribeMarketData(`diag-${Date.now()}`, out.candidateSlugs))
            .catch((err) => finish({ ok: false, error: err.message }));
        } catch (err) {
          finish({ ok: false, error: err.message });
        }
      });
      out.steps.push({ name: `websocket probe (${out.candidateSlugs.length} market(s), 6s window)`, ok: probe.ok, raw: JSON.stringify(probe) });
    }
    out.websocket = {
      connected: !!this.ws?.isConnected,
      watching: [...this.wsWanted],
      lastBookAgesMs: Object.fromEntries([...this.wsWanted].map((s) => [s, this.lastBookAt.has(s) ? Date.now() - this.lastBookAt.get(s) : null])),
      pollBackstopActive: !!this._pollTimer,
    };
    return out;
  }
}
