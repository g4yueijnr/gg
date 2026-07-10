import { ethers } from "ethers";
import WebSocket from "ws";
import { ClobClient, Side, OrderType } from "@polymarket/clob-client";
import { config, CLOB_HOST, CLOB_WS_HOST, GAMMA_HOST, DATA_API_HOST, CHAIN_ID } from "./config.js";

export { Side, OrderType };

function parseMaybeJsonArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    try { return JSON.parse(v); } catch { return []; }
  }
  return [];
}

/**
 * Everything that talks to Polymarket lives here:
 *  - authenticated CLOB client (orders, books, balances)
 *  - Gamma API (market search / metadata)
 *  - Data API (positions)
 *  - real-time market WebSocket feed with auto-reconnect
 */
export class Polymarket {
  constructor() {
    this.platform = "global";
    this.ready = false;
    this.readonly = true;
    this.address = null;
    this.funder = null;
    this.client = new ClobClient(CLOB_HOST, CHAIN_ID); // readonly fallback

    // websocket state
    this.ws = null;
    this.wsSubscribedAssets = new Set();
    this.wsWantedAssets = new Set();
    this.wsPingTimer = null;
    this.wsReconnectDelay = 1000;
    this.bookListeners = new Set(); // fn({tokenId, bestBid, bestAsk, raw})
    this.books = new Map(); // tokenId -> {bestBid, bestAsk, ts}
  }

  async _connectivityCheck() {
    try {
      const res = await Promise.race([
        this.client.getOk(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout after 6s")), 6000)),
      ]);
      // The clob client can return error OBJECTS instead of throwing - a bare
      // "no throw" is not proof of connectivity. Verify the response shape.
      const failed = res && typeof res === "object" && (res.error || res.errorMsg || Number(res.status) >= 400);
      if (failed) {
        throw new Error(String(res.error || res.errorMsg || `status ${res.status}`).slice(0, 160));
      }
      this.apiOk = true;
      console.log("[polymarket] API connectivity OK");
    } catch (err) {
      this.apiOk = false;
      this.apiError = err.message;
      console.error(`[polymarket] API CONNECTIVITY FAILED: ${err.message}`);
    }
  }

  async init() {
    if (!config.polymarketPrivateKey) {
      console.warn("[polymarket] POLYMARKET_PRIVATE_KEY not set - running in read-only mode (no trading).");
      await this._connectivityCheck();
      this.ready = true;
      return;
    }
    const signer = new ethers.Wallet(config.polymarketPrivateKey);
    this.address = await signer.getAddress();
    this.funder = config.polymarketFunderAddress || this.address;

    const bootstrap = new ClobClient(CLOB_HOST, CHAIN_ID, signer);
    const creds = await bootstrap.createOrDeriveApiKey();
    this.creds = creds;
    this.client = new ClobClient(
      CLOB_HOST,
      CHAIN_ID,
      signer,
      creds,
      config.polymarketSignatureType,
      config.polymarketFunderAddress || undefined,
    );
    this.readonly = false;
    await this._connectivityCheck();
    this.ready = true;
    console.log(`[polymarket] trading enabled for ${this.funder} (signature type ${config.polymarketSignatureType})`);
  }

  // ---------- market discovery (Gamma) ----------

  async searchMarkets(query, limit = 8) {
    const url = `${GAMMA_HOST}/public-search?q=${encodeURIComponent(query)}&limit_per_type=${limit}&events_status=active`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Gamma search failed: ${res.status}`);
    const data = await res.json();
    const out = [];
    for (const event of data.events || []) {
      for (const m of event.markets || []) {
        if (m.closed) continue;
        const tokenIds = parseMaybeJsonArray(m.clobTokenIds);
        const outcomes = parseMaybeJsonArray(m.outcomes);
        const prices = parseMaybeJsonArray(m.outcomePrices);
        if (!tokenIds.length) continue;
        out.push({
          question: m.question,
          eventTitle: event.title,
          conditionId: m.conditionId,
          slug: m.slug,
          endDate: m.endDate,
          volume: m.volumeNum ?? m.volume,
          liquidity: m.liquidityNum ?? m.liquidity,
          outcomes: outcomes.map((name, i) => ({
            outcome: name,
            tokenId: tokenIds[i],
            lastPrice: prices[i] !== undefined ? Number(prices[i]) : undefined,
          })),
        });
      }
    }
    return out.slice(0, limit);
  }

  async getMarketByToken(tokenId) {
    const res = await fetch(`${GAMMA_HOST}/markets?clob_token_ids=${encodeURIComponent(tokenId)}`);
    if (!res.ok) throw new Error(`Gamma market lookup failed: ${res.status}`);
    const arr = await res.json();
    const m = arr?.[0];
    if (!m) return null;
    const tokenIds = parseMaybeJsonArray(m.clobTokenIds);
    const outcomes = parseMaybeJsonArray(m.outcomes);
    const idx = tokenIds.indexOf(tokenId);
    return {
      question: m.question,
      conditionId: m.conditionId,
      slug: m.slug,
      endDate: m.endDate,
      outcome: idx >= 0 ? outcomes[idx] : undefined,
      outcomes: outcomes.map((name, i) => ({ outcome: name, tokenId: tokenIds[i] })),
      closed: !!m.closed,
    };
  }

  // ---------- order book / prices ----------

  async getOrderBook(tokenId) {
    const book = await this.client.getOrderBook(tokenId);
    return this._summarizeBook(tokenId, book);
  }

  _summarizeBook(tokenId, book) {
    const bids = (book.bids || []).map((b) => ({ price: Number(b.price), size: Number(b.size) }))
      .sort((a, b) => b.price - a.price);
    const asks = (book.asks || []).map((a) => ({ price: Number(a.price), size: Number(a.size) }))
      .sort((a, b) => a.price - b.price);
    const summary = {
      tokenId,
      bestBid: bids[0]?.price ?? null,
      bestAsk: asks[0]?.price ?? null,
      bids: bids.slice(0, 8),
      asks: asks.slice(0, 8),
      tickSize: book.tick_size ? Number(book.tick_size) : undefined,
      negRisk: book.neg_risk,
      lastTradePrice: book.last_trade_price ? Number(book.last_trade_price) : undefined,
    };
    this.books.set(tokenId, { bestBid: summary.bestBid, bestAsk: summary.bestAsk, ts: Date.now() });
    return summary;
  }

  async getTickSize(tokenId) {
    const t = await this.client.getTickSize(tokenId);
    return Number(t);
  }

  // ---------- trading ----------

  _assertTradable() {
    if (this.readonly) {
      throw new Error("Trading is disabled: POLYMARKET_PRIVATE_KEY is not configured.");
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
   * Place a limit order. price is in dollars per share (0.10 = 10 cents).
   */
  async placeOrder({ tokenId, side, price, size, orderType = "GTC" }) {
    this._assertTradable();
    this.checkLimits({ price, size });
    if (config.dryRun) {
      return { success: true, dryRun: true, orderID: `dry-${Date.now()}`, status: "live (dry run)" };
    }
    const [tickSize, negRisk] = await Promise.all([
      this.client.getTickSize(tokenId),
      this.client.getNegRisk(tokenId),
    ]);
    const resp = await this.client.createAndPostOrder(
      { tokenID: tokenId, price, size, side: side === "SELL" ? Side.SELL : Side.BUY },
      { tickSize, negRisk },
      orderType === "GTD" ? OrderType.GTD : OrderType.GTC,
    );
    if (resp && resp.success === false) {
      throw new Error(`Order rejected: ${resp.errorMsg || JSON.stringify(resp)}`);
    }
    return resp; // { success, orderID, status, ... }
  }

  async cancelOrder(orderId) {
    this._assertTradable();
    if (config.dryRun) return { canceled: [orderId], dryRun: true };
    return this.client.cancelOrder({ orderID: orderId });
  }

  async getOpenOrders(params = {}) {
    this._assertTradable();
    const orders = await this.client.getOpenOrders(params);
    return (orders || []).map((o) => ({
      orderId: o.id,
      tokenId: o.asset_id,
      market: o.market,
      side: o.side,
      price: Number(o.price),
      size: Number(o.original_size),
      filled: Number(o.size_matched || 0),
      outcome: o.outcome,
      createdAt: o.created_at,
    }));
  }

  async getOrder(orderId) {
    this._assertTradable();
    // Throws on transient/network errors; callers decide how to handle that.
    // A missing order comes back as null/undefined.
    return await this.client.getOrder(orderId);
  }

  async getBalance() {
    this._assertTradable();
    const res = await this.client.getBalanceAllowance({ asset_type: "COLLATERAL" });
    // balance comes back in USDC base units (6 decimals)
    const usdc = res?.balance !== undefined ? Number(res.balance) / 1e6 : null;
    return { usdc };
  }

  async getPositions() {
    const who = this.funder || this.address;
    if (!who) throw new Error("No wallet configured.");
    const res = await fetch(`${DATA_API_HOST}/positions?user=${who}&sizeThreshold=0.1&limit=100`);
    if (!res.ok) throw new Error(`Positions lookup failed: ${res.status}`);
    const arr = await res.json();
    return (arr || []).map((p) => ({
      market: p.title,
      outcome: p.outcome,
      tokenId: p.asset,
      size: p.size,
      avgPrice: p.avgPrice,
      currentPrice: p.curPrice,
      valueUsd: p.currentValue,
      pnlUsd: p.cashPnl,
    }));
  }

  // ---------- real-time market feed ----------

  onBookUpdate(fn) {
    this.bookListeners.add(fn);
    return () => this.bookListeners.delete(fn);
  }

  watchToken(tokenId) {
    if (this.wsWantedAssets.has(tokenId)) return;
    this.wsWantedAssets.add(tokenId);
    this._ensureWs(true);
  }

  unwatchToken(tokenId) {
    this.wsWantedAssets.delete(tokenId);
    // resubscribe with the reduced set on next reconnect; harmless to keep receiving meanwhile
  }

  _ensureWs(forceResubscribe = false) {
    if (this.wsWantedAssets.size === 0) return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      if (forceResubscribe) this._subscribe();
      return;
    }
    if (this.ws && this.ws.readyState === WebSocket.CONNECTING) return;
    this._connectWs();
  }

  _connectWs() {
    const ws = new WebSocket(`${CLOB_WS_HOST}/market`);
    this.ws = ws;

    ws.on("open", () => {
      this.wsReconnectDelay = 1000;
      this.wsSubscribedAssets = new Set();
      this._subscribe();
      clearInterval(this.wsPingTimer);
      this.wsPingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send("PING");
      }, 10000);
      console.log("[polymarket] market feed connected");
    });

    ws.on("message", (buf) => {
      const text = buf.toString();
      if (text === "PONG" || text === "PING") return;
      let payload;
      try { payload = JSON.parse(text); } catch { return; }
      const events = Array.isArray(payload) ? payload : [payload];
      for (const ev of events) this._handleMarketEvent(ev);
    });

    const scheduleReconnect = () => {
      clearInterval(this.wsPingTimer);
      if (this.wsWantedAssets.size === 0) return;
      const delay = this.wsReconnectDelay;
      this.wsReconnectDelay = Math.min(this.wsReconnectDelay * 2, 30000);
      setTimeout(() => this._ensureWs(), delay);
    };
    ws.on("close", () => {
      console.warn("[polymarket] market feed disconnected, reconnecting...");
      scheduleReconnect();
    });
    ws.on("error", (err) => {
      console.warn("[polymarket] market feed error:", err.message);
      try { ws.close(); } catch { /* noop */ }
    });
  }

  _subscribe() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const assets = [...this.wsWantedAssets];
    this.ws.send(JSON.stringify({ assets_ids: assets, type: "market" }));
    this.wsSubscribedAssets = new Set(assets);
  }

  _handleMarketEvent(ev) {
    const type = ev.event_type;
    if (type === "book") {
      const tokenId = ev.asset_id;
      const summary = this._summarizeBook(tokenId, ev);
      this._emitBook(tokenId, summary);
    } else if (type === "price_change") {
      // levels changed; we don't get the full book, so fetch cheaply via REST is
      // wasteful - instead derive best bid/ask from the reported changes when possible,
      // falling back to a REST refresh.
      const changes = ev.changes || ev.price_changes || [];
      const tokenId = ev.asset_id || changes[0]?.asset_id;
      if (!tokenId) return;
      this.getOrderBook(tokenId)
        .then((summary) => this._emitBook(tokenId, summary))
        .catch(() => { /* transient */ });
    } else if (type === "tick_size_change") {
      // rules engine re-reads tick size on each repost; nothing to do here
    }
  }

  _emitBook(tokenId, summary) {
    for (const fn of this.bookListeners) {
      try { fn(summary); } catch (err) { console.error("[polymarket] book listener error:", err); }
    }
  }

  stop() {
    clearInterval(this.wsPingTimer);
    this.wsWantedAssets.clear();
    try { this.ws?.close(); } catch { /* noop */ }
  }

  /** Data-path diagnostic (global platform), runnable from the chat. */
  async diagnose(query) {
    const out = { platform: "global", query, steps: [] };
    const step = async (name, fn) => {
      try {
        const raw = await fn();
        out.steps.push({ name, ok: true, raw: JSON.stringify(raw)?.slice(0, 900) });
        return raw;
      } catch (err) {
        out.steps.push({ name, ok: false, error: err.message });
        return null;
      }
    };
    const results = await step(`gamma search("${query}")`, () => this.searchMarkets(query, 2));
    const tokenId = results?.[0]?.outcomes?.[0]?.tokenId;
    if (tokenId) {
      await step(`clob getOrderBook(${tokenId.slice(0, 16)}...)`, () => this.client.getOrderBook(tokenId));
      await step("clob getTickSize", () => this.client.getTickSize(tokenId));
    }
    if (!this.readonly) {
      await step("auth check: getOpenOrders()", () => this.client.getOpenOrders());
    } else {
      out.steps.push({ name: "auth check", ok: false, error: "skipped - no keys configured" });
    }
    out.websocket = {
      connected: this.ws?.readyState === 1,
      watching: [...this.wsWantedAssets].map((t) => t.slice(0, 16) + "..."),
    };
    return out;
  }
}
