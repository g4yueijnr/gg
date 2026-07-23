import { matchWinProb, matchProgress, modelBuyPrice } from "./pingpong.js";
import { extractLiveScore } from "./polymarket-us.js";

const START_FIELDS = ["gameStartTime", "gameTime", "startTime", "startDate", "eventStartTime", "gameStart", "startsAt", "scheduledTime"];
function parseStart(m) {
  for (const f of START_FIELDS) { if (m && m[f]) { const t = Date.parse(m[f]); if (!Number.isNaN(t)) return t; } }
  return null;
}

/**
 * Ping-pong (Setka Cup) live-quoting strategy engine.
 *
 * For one match market it keeps a single, edge-discounted BUY limit resting on
 * the player the cheat-sheet model favors at the CURRENT live score. Every time
 * the score changes it pulls the old quote and re-prices from the new score;
 * an unfilled quote is also auto-pulled after a short TTL so a stale thesis
 * never sits on the book. Fills are HELD TO EXPIRY (no auto-exit) and counted
 * against a hard max-exposure cap; each quote risks only a small fixed stake.
 *
 * Score source is external (Polymarket's SDK exposes no live score) - updateScore
 * is called from chat, an HTTP feed, or the live-score poller. The trading loop
 * is identical no matter where the score comes from.
 *
 * Safety invariants (same lessons as the auto-outbid engine):
 *   - at most ONE resting quote per strategy; cancel-before-replace, always.
 *   - never cross the spread (quotes REST; a marketable price is skipped).
 *   - filled + open stake never exceeds maxExposureUsd.
 */
export class PingPongEngine {
  constructor({ polymarket, store, notify }) {
    this.pm = polymarket;
    this.store = store;
    this.notify = notify || (() => {});
    this._locks = new Map();       // id -> promise chain (serialize per strategy)
    this._ttlTimers = new Map();   // id -> setTimeout handle for the resting quote
    this._orderIds = new Set();     // every order id we've placed (safe stray sweep)
    this._pollTimers = new Map();  // id -> setInterval handle for the score poller
    this._lastScoreKey = new Map(); // id -> last score seen, to fire only on change
  }

  start() {
    for (const s of this.strategies()) if (s.orderId) this._orderIds.add(s.orderId);
    this.pm.onOrderEvent?.((evt) => this._onOrderEvent(evt));
    // Re-quote any live strategy against its last known score on boot, and
    // restart its automatic score poller.
    for (const s of this.activeStrategies()) {
      this.pm.watchToken?.(s.tokenId);
      this._enqueue(s.id, () => this._requote(s, "resumed after restart"));
      this._startPoller(s);
    }
    // Resume autopilot ("trade whatever is live") if it was on before a restart.
    if (this.store.state.settings?.ppAutopilot?.on) this._armAutopilot();
    console.log(`[pingpong] engine started with ${this.activeStrategies().length} active strategies`);
  }

  stop() {
    for (const t of this._ttlTimers.values()) clearTimeout(t);
    for (const t of this._pollTimers.values()) clearInterval(t);
    clearInterval(this._autopilotTimer);
    this._ttlTimers.clear();
    this._pollTimers.clear();
  }

  // ---------- autopilot: discover & trade every live match automatically ----------

  /**
   * Turn on "trade whatever is live": periodically discover live Setka Cup /
   * table-tennis match markets and spin up a strategy on each one we can read a
   * live score for, bounded by maxConcurrent and a per-match exposure cap.
   */
  async startAutopilot({ perTradeUsd = 0.25, maxExposurePerMatch = 5, maxConcurrent = 8, query = "Setka Cup, table tennis, Setka, table-tennis", edgeEarly = 0.20, edgeLate = 0.10 } = {}) {
    this.store.state.settings ||= {};
    this.store.state.settings.ppAutopilot = { on: true, perTradeUsd, maxExposurePerMatch, maxConcurrent, query, edgeEarly, edgeLate };
    this.store.save();
    this.store.addActivity("pingpong",
      `AUTOPILOT ON - hunting live "${query}" matches every 60s. Trades each live match it can read: $${perTradeUsd}/quote, $${maxExposurePerMatch}/match, up to ${maxConcurrent} at once.`, { level: "success" });
    this._armAutopilot();
    const found = await this._autopilotTick(); // do a first pass right away
    return { on: true, perTradeUsd, maxExposurePerMatch, maxConcurrent, query, startedNow: found };
  }

  async stopAutopilot({ alsoStopStrategies = false } = {}) {
    if (this.store.state.settings?.ppAutopilot) this.store.state.settings.ppAutopilot.on = false;
    clearInterval(this._autopilotTimer);
    this._autopilotTimer = null;
    this.store.save();
    let stopped = 0;
    if (alsoStopStrategies) {
      for (const s of this.activeStrategies()) { await this.stopStrategy(s.id, "autopilot stopped"); stopped++; }
    }
    this.store.addActivity("pingpong", `AUTOPILOT OFF.${alsoStopStrategies ? ` Stopped ${stopped} strateg${stopped === 1 ? "y" : "ies"}.` : " Existing strategies keep running."}`, { level: "warn" });
    return { on: false, stoppedStrategies: stopped };
  }

  _armAutopilot() {
    clearInterval(this._autopilotTimer);
    const t = setInterval(() => this._autopilotTick().catch((e) => console.warn("[pingpong] autopilot:", e.message)), 60000);
    if (t.unref) t.unref();
    this._autopilotTimer = t;
  }

  /** One discovery pass: find live matches and start a strategy on each new one. Returns count started. */
  async _autopilotTick() {
    const cfg = this.store.state.settings?.ppAutopilot;
    if (!cfg?.on) return 0;
    let candidates = [];
    try { candidates = await this._discoverMatches(cfg.query); } catch { return 0; }
    const now = Date.now();
    let started = 0, liveSeen = 0;
    for (const c of candidates) {
      if (c.closed) continue;
      const isStarted = c.startMs !== null && c.startMs <= now + 60000; // started (or about to)
      if (!isStarted) continue; // scheduled for later - skip until it starts
      liveSeen++;
      if (this.activeStrategies().find((s) => s.tokenId === c.tokenId)) continue;
      if (this.activeStrategies().length >= cfg.maxConcurrent) continue;
      if (c.score) {
        try {
          await this.createStrategy({
            tokenId: c.tokenId, playerA: c.playerA, playerB: c.playerB, marketQuestion: c.marketTitle,
            perTradeUsd: cfg.perTradeUsd, maxExposureUsd: cfg.maxExposurePerMatch,
            edgeEarly: cfg.edgeEarly, edgeLate: cfg.edgeLate,
          });
          started++;
        } catch { /* already running or not tradable */ }
      } else {
        // STARTED but we couldn't read a score. Surface exactly what the exchange
        // DOES return for this in-play match so the reader can be pinpointed.
        this._diagnoseNoScore(c);
      }
    }
    if (started === 0 && candidates.length === 0) {
      // No readable-score matches. Report what the in-play matches actually
      // contain (from the client's probe of market + event + game endpoints) so
      // the score can be pinpointed - or it's confirmed the exchange lacks it.
      const un = this.pm._lastUnreadable || [];
      if (un.length) {
        const sample = un.slice(0, 3).map((u) => {
          const hunt = (u.scoreHunt || []).slice(0, 8).map((h) => `${h.path}=${h.value}`).join(", ") || "no score fields";
          return `"${u.title}" [gameId=${u.gameId ?? "none"}, game-endpoint ${u.gameFetched ? "answered" : "no-response"}; fields: ${hunt}]`;
        }).join(" || ");
        this._logThrottledGlobal("noscore", `Autopilot: probed the live matches for a score. ${sample}`, "warn");
      } else {
        this._logThrottledGlobal("nomatch", `Autopilot: found no table-tennis matches in the active list for [${cfg.query}] this pass.`, "warn");
      }
    }
    return started;
  }

  /** Log the raw score-looking fields for a live match we can't price, so we can pinpoint the score. */
  _diagnoseNoScore(c) {
    const now = Date.now();
    this._diagTs ||= new Map();
    if (now - (this._diagTs.get(c.tokenId) || 0) < 180000) return; // once every 3 min per match
    this._diagTs.set(c.tokenId, now);
    const hunt = (c.scoreHunt || []).slice(0, 12).map((h) => `${h.path}=${h.value}`).join(" | ") || "(no score-looking fields in the payload)";
    this.store.addActivity("pingpong",
      `LIVE match "${c.marketTitle}" is in-play but I can't read its score. Raw fields the exchange returns: ${hunt}`, { level: "warn" });
  }

  /**
   * Discover candidate match markets and enrich each with start time / closed /
   * live score by pulling its market payload once. Normalizes to
   * {tokenId, playerA, playerB, marketTitle, startMs, closed, score, scoreHunt}.
   */
  async _discoverMatches(query) {
    // Primary: enumerate matches that are actually IN PLAY. listLiveMatches
    // decides liveness by whether a live SCORE is readable, so everything it
    // returns is ready to trade right now.
    if (this.pm.listLiveMatches) {
      let live = [];
      try { live = await this.pm.listLiveMatches(query); } catch { live = []; }
      if (live.length) {
        return live.map((c) => {
          const { a, b } = parseVersus(c.title);
          return {
            tokenId: c.tokenId,
            playerA: c.outcome || a || "Player A",
            playerB: otherName(c.outcome || a, a, b) || "Player B",
            marketTitle: c.title,
            startMs: c.startMs ?? Date.now(),  // readable score => live now
            closed: false,
            score: c.score,
            scoreHunt: c.scoreHunt || [],
          };
        });
      }
    }
    // Fallback: search + per-match start/score enrichment.
    if (!this.pm.searchMarkets) return [];
    const queries = (Array.isArray(query) ? query : String(query || "").split(","))
      .map((q) => q.trim()).filter(Boolean);
    if (!queries.length) queries.push("Setka Cup", "table tennis");
    const seen = new Set();
    const cands = [];
    for (const q of queries) {
      let res = [];
      try { res = await this.pm.searchMarkets(q, 25); } catch { continue; }
      for (const ev of res || []) {
        const title = ev.eventTitle || ev.question || "";
        for (const o of ev.outcomes || []) {
          if (!o.tokenId || seen.has(o.tokenId)) continue;
          seen.add(o.tokenId);
          const { a, b } = parseVersus(o.marketTitle || title);
          cands.push({
            tokenId: o.tokenId,
            playerA: o.outcome || a || "Player A",
            playerB: otherName(o.outcome || a, a, b) || "Player B",
            marketTitle: o.marketTitle || title,
          });
        }
      }
    }
    await Promise.all(cands.slice(0, 25).map(async (c) => {
      try {
        const dump = await this.pm.dumpMatchData(c.tokenId);
        const m = dump.market?.market || dump.market || {};
        c.startMs = parseStart(m);
        c.closed = m.closed === true;
        c.scoreHunt = dump.scoreHunt || [];
        c.score = extractLiveScore(dump, m.outcome);
      } catch { c.startMs = null; c.closed = false; c.scoreHunt = []; c.score = null; }
    }));
    return cands;
  }

  _logThrottledGlobal(key, text, level) {
    const now = Date.now();
    this._gWarnTs ||= new Map();
    if (now - (this._gWarnTs.get(key) || 0) > 180000) {
      this._gWarnTs.set(key, now);
      this.store.addActivity("pingpong", text, { level });
    }
  }

  /**
   * Automatic score feed: every pollSec, ask the exchange for the live score and,
   * if it CHANGED, drive a re-quote. This is the hands-free heart of the strategy
   * - no human types anything. If the exchange can't supply a score for this
   * market, the poller stays quiet (and a manual/HTTP updateScore still works).
   */
  _startPoller(s) {
    this._stopPoller(s.id);
    if (!this.pm.getLiveScore) return;
    const ms = Math.max(1000, (s.pollSec || 3) * 1000);
    const tick = async () => {
      let sc;
      try { sc = await this.pm.getLiveScore(s.tokenId); } catch { return; }
      if (!sc) { this._noteNoScore(s); return; }
      const key = `${sc.gamesA}-${sc.gamesB}:${sc.ptsA}-${sc.ptsB}`;
      if (this._lastScoreKey.get(s.id) === key) return; // unchanged - nothing to do
      this._lastScoreKey.set(s.id, key);
      try { await this.updateScore(s.id, sc); } catch (err) { console.warn(`[pingpong] ${s.id} auto-score failed: ${err.message}`); }
    };
    const t = setInterval(tick, ms);
    if (t.unref) t.unref();
    this._pollTimers.set(s.id, t);
    tick(); // fire immediately so we don't wait a full interval for the first quote
  }

  _stopPoller(id) {
    const t = this._pollTimers.get(id);
    if (t) { clearInterval(t); this._pollTimers.delete(id); }
    this._lastScoreKey.delete(id);
  }

  _noteNoScore(s) {
    if (s._warnedNoScore) return;
    s._warnedNoScore = true;
    this._log(s,
      `Heads up: the exchange isn't returning a live score for this market yet. The strategy is armed and will start quoting automatically the moment a score comes through. ` +
      `If it never does, run the match-data dump so we can point the reader at the right field.`, "warn");
  }

  strategies() { return this.store.state.strategies || (this.store.state.strategies = []); }
  activeStrategies() { return this.strategies().filter((s) => s.status === "active"); }
  getStrategy(id) { return this.strategies().find((s) => s.id === id); }
  listStrategies() { return this.strategies(); }

  _enqueue(id, fn) {
    const prev = this._locks.get(id) || Promise.resolve();
    const next = prev.then(fn).catch((err) => console.error(`[pingpong] ${id} action failed:`, err.message));
    this._locks.set(id, next);
    return next;
  }

  _log(s, text, level = "info") {
    const entry = this.store.addActivity("pingpong", `[${s.id}] ${text}`, { strategyId: s.id, level });
    this.notify(entry);
  }

  /**
   * Create a live-quoting strategy on one match market.
   *   tokenId          - the market's outcome token (its YES = playerA wins).
   *   playerA/playerB  - display names; playerA is the YES side, playerB the NO side.
   *   perTradeUsd      - stake per individual quote (default $0.25).
   *   maxExposureUsd   - hard cap on total money at work in this strategy (default $20).
   *   edgeEarly/Late   - safety discount off fair value, early -> late (0.20 -> 0.10).
   *   orderTtlSec      - seconds an unfilled quote rests before auto-pull (default 10).
   */
  async createStrategy({
    tokenId, marketQuestion, playerA, playerB,
    perTradeUsd = 0.25, maxExposureUsd = 20,
    edgeEarly = 0.20, edgeLate = 0.10, orderTtlSec = 10, pollSec = 3,
  }) {
    if (!tokenId) throw new Error("tokenId (the match market's outcome token) is required.");
    if (!(perTradeUsd > 0)) throw new Error("perTradeUsd must be positive.");
    if (!(maxExposureUsd >= perTradeUsd)) throw new Error("maxExposureUsd must be >= perTradeUsd.");
    if (!(edgeEarly >= 0 && edgeEarly < 1 && edgeLate >= 0 && edgeLate < 1)) throw new Error("edges must be between 0 and 1.");

    // Pin to the canonical tradable id and grab the exchange's real market name.
    if (this.pm.canonicalTokenId) tokenId = await this.pm.canonicalTokenId(tokenId);
    let marketTitle = marketQuestion || tokenId;
    try {
      const book = await this.pm.getOrderBook(tokenId);
      if (book?.tokenId && book.tokenId !== tokenId) tokenId = book.tokenId;
      if (book?.marketTitle) marketTitle = book.marketTitle;
    } catch { /* title is best-effort */ }

    // One strategy per market token.
    const dup = this.activeStrategies().find((s) => s.tokenId === tokenId);
    if (dup) throw new Error(`A live-quoting strategy (${dup.id}) is already running on this market. Update or stop it first.`);

    const s = {
      id: this.store.nextStrategyId(),
      kind: "pingpong",
      tokenId,
      marketTitle,
      playerA: playerA || "Player A (YES)",
      playerB: playerB || "Player B (NO)",
      perTradeUsd, maxExposureUsd, edgeEarly, edgeLate,
      orderTtlSec, pollSec,
      score: null,                 // {gamesA, gamesB, ptsA, ptsB}
      orderId: null,               // current resting quote
      orderSide: null,             // "YES" (backing A) or "NO" (backing B)
      orderPrice: null,
      orderSize: null,
      orderFilledSeen: 0,
      filledUsd: 0,                // stake filled and held to expiry
      openUsd: 0,                  // stake currently resting (unfilled)
      quotesPlaced: 0,
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.strategies().push(s);
    this.store.save();
    this.pm.watchToken?.(tokenId);
    this._startPoller(s); // begin auto-reading the live score immediately
    this._log(s,
      `Live-quoting started on "${marketTitle}" - ${s.playerA} (YES) vs ${s.playerB} (NO). ` +
      `$${perTradeUsd}/quote, $${maxExposureUsd} max exposure, edge ${(edgeEarly * 100).toFixed(0)}%->${(edgeLate * 100).toFixed(0)}%, ` +
      `quotes auto-pull after ${orderTtlSec}s. Auto-reading the score every ${pollSec}s.`);
    return s;
  }

  /**
   * Feed a new live score. This is the heartbeat: pull the old quote and place a
   * fresh edge-discounted one on whichever player the model now favors.
   * whoScored ("A"/"B") is a convenience to increment from the last score.
   */
  async updateScore(id, score) {
    const s = this.getStrategy(id);
    if (!s) throw new Error(`No strategy ${id}.`);
    if (s.status !== "active") throw new Error(`Strategy ${id} is ${s.status}.`);
    const next = this._resolveScore(s, score);
    this._validateScore(next);
    s.score = next;
    s.updatedAt = new Date().toISOString();
    this.store.save();
    return this._enqueue(s.id, () => this._requote(s, `score ${next.gamesA}-${next.gamesB} games, ${next.ptsA}-${next.ptsB} points`));
  }

  _resolveScore(s, score) {
    const cur = s.score || { gamesA: 0, gamesB: 0, ptsA: 0, ptsB: 0 };
    if (score && (score.whoScored === "A" || score.whoScored === "B")) {
      const n = { ...cur };
      if (score.whoScored === "A") n.ptsA += 1; else n.ptsB += 1;
      return this._applyGameRollover(n);
    }
    return {
      gamesA: score.gamesA ?? cur.gamesA,
      gamesB: score.gamesB ?? cur.gamesB,
      ptsA: score.ptsA ?? cur.ptsA,
      ptsB: score.ptsB ?? cur.ptsB,
    };
  }

  /** If a point score completed a game (11+, win by 2), roll it into the game score. */
  _applyGameRollover(n) {
    const { ptsA, ptsB } = n;
    if ((ptsA >= 11 || ptsB >= 11) && Math.abs(ptsA - ptsB) >= 2) {
      if (ptsA > ptsB) n.gamesA += 1; else n.gamesB += 1;
      n.ptsA = 0; n.ptsB = 0;
    }
    return n;
  }

  _validateScore(sc) {
    for (const k of ["gamesA", "gamesB", "ptsA", "ptsB"]) {
      if (!Number.isFinite(sc[k]) || sc[k] < 0) throw new Error(`Invalid score field ${k}=${sc[k]}.`);
    }
    if (sc.gamesA > 3 || sc.gamesB > 3) throw new Error("A best-of-5 match can't have more than 3 games won.");
  }

  /** Core loop: pull the old quote, price the favored side, rest a fresh quote. */
  async _requote(s, reason) {
    if (s.status !== "active") return;
    await this._cancelResting(s);
    if (!s.score) return;

    // If the match is decided, stop quoting (positions ride to settlement).
    if (s.score.gamesA >= 3 || s.score.gamesB >= 3) {
      this._log(s, `Match decided (${s.score.gamesA}-${s.score.gamesB} games). No more quotes; positions ride to settlement.`, "info");
      return;
    }

    const fairA = matchWinProb(s.score);
    const backingA = fairA >= 0.5;
    const side = backingA ? "YES" : "NO";
    const player = backingA ? s.playerA : s.playerB;
    // modelBuyPrice prices "A". For backing B, mirror the score so B is "A".
    const mScore = backingA ? s.score : { gamesA: s.score.gamesB, gamesB: s.score.gamesA, ptsA: s.score.ptsB, ptsB: s.score.ptsA };
    const quote = modelBuyPrice({ ...mScore, edgeEarly: s.edgeEarly, edgeLate: s.edgeLate });
    if (quote.price === null) return; // ~50/50, no favorite -> no edge, sit out

    // Exposure cap: filled (held) stake + this quote must stay within budget.
    const budgetLeft = s.maxExposureUsd - (s.filledUsd || 0);
    if (budgetLeft < 0.01) {
      this._logThrottled(s, "cap", `Max exposure $${s.maxExposureUsd} reached ($${(s.filledUsd || 0).toFixed(2)} filled). Holding - no new quotes until positions settle or you raise the cap.`, "warn");
      return;
    }
    const stake = Math.min(s.perTradeUsd, budgetLeft);
    const size = Math.round((stake / quote.price) * 100) / 100; // shares (2dp) so cost <= stake
    if (size <= 0) return;

    try {
      const resp = await this.pm.placeOrder({ tokenId: s.tokenId, side: "BUY", price: quote.price, size, outcomeSide: side });
      s.orderId = resp.orderID;
      s.orderSide = side;
      s.orderPrice = quote.price;
      s.orderSize = size;
      s.orderFilledSeen = 0;
      s.openUsd = Math.round(size * quote.price * 100) / 100;
      s.quotesPlaced = (s.quotesPlaced || 0) + 1;
      s.updatedAt = new Date().toISOString();
      this._orderIds.add(resp.orderID);
      this.store.save();
      this._armTtl(s);
      this._log(s,
        `Quote: BUY ${size} ${player} @ ${(quote.price * 100).toFixed(0)}¢ ` +
        `(fair ${(quote.fairProb * 100).toFixed(0)}%, edge ${(quote.edge * 100).toFixed(0)}%, ~$${s.openUsd.toFixed(2)}) - ${reason}. Auto-pull in ${s.orderTtlSec}s.`, "success");
    } catch (err) {
      // A model price that would cross the spread is REFUSED by the client - that's
      // fine, it means the market is already at/above our discounted price; we just
      // sit out this point and re-quote on the next score change.
      if (/fill IMMEDIATELY/i.test(err.message)) {
        this._logThrottled(s, "cross", `Model price ${(quote.price * 100).toFixed(0)}¢ for ${player} would cross the spread (market richer than our edge). Sitting out this point.`, "info");
      } else {
        this._logThrottled(s, "err", `Couldn't place quote: ${err.message}`, "warn");
      }
    }
  }

  _armTtl(s) {
    clearTimeout(this._ttlTimers.get(s.id));
    const ms = Math.max(1, (s.orderTtlSec || 10)) * 1000;
    const t = setTimeout(() => {
      this._enqueue(s.id, async () => {
        if (s.status === "active" && s.orderId) {
          await this._cancelResting(s);
          this._log(s, `Quote unfilled after ${s.orderTtlSec}s - pulled. Waiting for the next point.`, "info");
        }
      });
    }, ms);
    if (t.unref) t.unref();
    this._ttlTimers.set(s.id, t);
  }

  /** Cancel the current resting quote (if any) and clear its open stake. */
  async _cancelResting(s) {
    clearTimeout(this._ttlTimers.get(s.id));
    this._ttlTimers.delete(s.id);
    if (!s.orderId) return;
    const orderId = s.orderId;
    s.orderId = null; s.orderSide = null; s.orderPrice = null; s.orderSize = null; s.openUsd = 0;
    this.store.save();
    try { await this.pm.cancelOrder(orderId); } catch (err) {
      console.warn(`[pingpong] cancel ${orderId} failed: ${err.message}`);
    }
  }

  /** Real-time fills: credit filled stake (held to expiry), then re-quote the remainder. */
  _onOrderEvent(evt) {
    const s = this.strategies().find((x) => x.orderId === evt.orderId);
    if (!s) return;
    this._enqueue(s.id, async () => {
      if (s.orderId !== evt.orderId) return;
      if (evt.rejectReason || String(evt.state).includes("REJECT")) {
        s.orderId = null; s.openUsd = 0; this.store.save();
        this._logThrottled(s, "rej", `Quote rejected (${evt.rejectReason || evt.state}). Will re-quote on the next point.`, "warn");
        return;
      }
      const cum = Number(evt.cumQuantity || 0);
      const newly = cum - (s.orderFilledSeen || 0);
      if (newly > 0) {
        s.orderFilledSeen = cum;
        const cost = Math.round(newly * (s.orderPrice || 0) * 100) / 100;
        s.filledUsd = Math.round(((s.filledUsd || 0) + cost) * 100) / 100;
        this.store.save();
        this._log(s, `FILLED ${newly} @ ${((s.orderPrice || 0) * 100).toFixed(0)}¢ (+$${cost.toFixed(2)}, total held $${s.filledUsd.toFixed(2)}/$${s.maxExposureUsd}). Holding to expiry.`, "success");
      }
      if (String(evt.state).includes("FILLED") && !String(evt.state).includes("PARTIALLY")) {
        s.orderId = null; s.openUsd = 0; this.store.save();
      }
    });
  }

  async stopStrategy(id, reason = "stopped by user") {
    const s = this.getStrategy(id);
    if (!s) throw new Error(`No strategy ${id}.`);
    if (s.status !== "active") return s;
    this._stopPoller(s.id);
    await this._cancelResting(s);
    s.status = "stopped";
    s.updatedAt = new Date().toISOString();
    this.store.save();
    this._log(s, `Strategy stopped (${reason}). Any filled positions are held to expiry; no new quotes.`, "warn");
    return s;
  }

  _logThrottled(s, key, text, level) {
    const now = Date.now();
    this._warnTs ||= new Map();
    const k = `${s.id}:${key}`;
    if (now - (this._warnTs.get(k) || 0) > 20000) {
      this._warnTs.set(k, now);
      this._log(s, text, level);
    }
  }
}

/** Split "A vs B" / "A v B" / "A - B" (any casing/separator) into the two names. */
export function parseVersus(title) {
  const t = String(title || "").replace(/\s+/g, " ").trim();
  const m = t.match(/^(.*?)\s+(?:vs?\.?|versus|-|–|—|@)\s+(.*?)$/i);
  if (!m) return { a: null, b: null };
  // Strip trailing qualifiers ("... (Setka Cup)", "... moneyline").
  const clean = (x) => x.replace(/\s*[\(\[].*$/, "").trim();
  return { a: clean(m[1]), b: clean(m[2]) };
}

/** Given the known player (the YES outcome) and the two parsed names, return the other one. */
export function otherName(known, a, b) {
  const k = String(known || "").toLowerCase();
  const na = String(a || "").toLowerCase(), nb = String(b || "").toLowerCase();
  if (na && k.includes(na.split(" ")[0])) return b;
  if (nb && k.includes(nb.split(" ")[0])) return a;
  // Fall back: if known matches a, other is b, else a.
  if (a && na && k && (k.includes(na) || na.includes(k))) return b;
  return b && String(b).toLowerCase() !== k ? b : a;
}
