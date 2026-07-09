import { config } from "./config.js";

/**
 * The rules engine holds "standing instructions" and executes them against the
 * live market feed - independently of the chatbot, so reactions are instant
 * (no AI in the hot path).
 *
 * Currently supported rule kind: auto_outbid
 *   "Keep a BUY order resting at `startPrice`. If someone outbids me, outbid
 *    them by one tick, but never pay more than `maxPrice`."
 */
export class RulesEngine {
  constructor({ polymarket, store, notify }) {
    this.pm = polymarket;
    this.store = store;
    this.notify = notify || (() => {});
    this._locks = new Map();   // ruleId -> promise chain (serialize actions per rule)
    this._lastAction = new Map(); // ruleId -> ts of last repost (throttle)
    this._reconcileTimer = null;
  }

  start() {
    this.pm.onBookUpdate((summary) => this._onBook(summary));
    for (const rule of this.activeRules()) {
      this.pm.watchToken(rule.tokenId);
    }
    this._reconcileTimer = setInterval(() => {
      this._reconcile().catch((err) => console.error("[rules] reconcile error:", err.message));
    }, config.reconcileIntervalMs);
    console.log(`[rules] engine started with ${this.activeRules().length} active rule(s)`);
  }

  stop() {
    clearInterval(this._reconcileTimer);
  }

  activeRules() {
    return this.store.state.rules.filter((r) => r.status === "active");
  }

  getRule(id) {
    return this.store.state.rules.find((r) => r.id === id);
  }

  listRules() {
    return this.store.state.rules;
  }

  /**
   * Create an auto-outbid rule and place its initial order.
   * startPrice may be omitted -> start one tick above the current best bid.
   * expiresAt (ISO datetime) may be set -> rule auto-cancels at that time.
   */
  async createAutoOutbid({ tokenId, size, startPrice, maxPrice, marketQuestion, outcome, conditionId, expiresAt }) {
    if (!(maxPrice > 0 && maxPrice < 1)) throw new Error("maxPrice must be between 0 and 1 (dollars per share).");
    if (startPrice !== undefined && startPrice !== null && !(startPrice > 0 && startPrice <= maxPrice)) {
      throw new Error("startPrice must be > 0 and <= maxPrice.");
    }
    let expiryTs = null;
    if (expiresAt) {
      expiryTs = Date.parse(expiresAt);
      if (Number.isNaN(expiryTs)) throw new Error(`Couldn't parse expiresAt "${expiresAt}" - use ISO format like 2026-07-12T21:00:00Z.`);
      if (expiryTs <= Date.now()) throw new Error(`expiresAt (${expiresAt}) is in the past.`);
    }
    this.pm.checkLimits({ price: maxPrice, size });

    const tickSize = await this.pm.getTickSize(tokenId);
    const book = await this.pm.getOrderBook(tokenId);

    let target;
    if (startPrice === undefined || startPrice === null) {
      // Relative start: one tick above whoever currently leads the book.
      if (book.bestBid === null) {
        throw new Error(
          "There are no bids in this book right now, so 'one tick above the best bid' is undefined. " +
          "Give an explicit starting price instead.",
        );
      }
      target = Math.min(round(book.bestBid + tickSize), maxPrice);
    } else {
      target = startPrice;
      // If the market already bids at/above our start price, start by outbidding it (within cap).
      if (book.bestBid !== null && book.bestBid >= startPrice) {
        target = Math.min(round(book.bestBid + tickSize), maxPrice);
      }
    }
    if (book.bestAsk !== null && target >= book.bestAsk) {
      throw new Error(
        `A resting bid at ${fmt(target)} would cross the ask (${fmt(book.bestAsk)}) and fill immediately. ` +
        `Lower the price, or place a normal order instead if immediate fill is wanted.`,
      );
    }

    const rule = {
      id: this.store.nextRuleId(),
      kind: "auto_outbid",
      tokenId,
      conditionId: conditionId || null,
      marketQuestion: marketQuestion || tokenId,
      outcome: outcome || "",
      side: "BUY",
      size,
      startPrice: target,
      maxPrice,
      expiresAt: expiryTs ? new Date(expiryTs).toISOString() : null,
      tickSize,
      status: "active",
      orderId: null,
      myPrice: null,
      filledSize: 0,
      cappedNotified: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const resp = await this.pm.placeOrder({ tokenId, side: "BUY", price: target, size });
    rule.orderId = resp.orderID;
    rule.myPrice = target;
    this.store.state.rules.push(rule);
    this.store.save();

    this.pm.watchToken(tokenId);
    this._log(rule,
      `Rule created: bidding ${fmt(target)} for ${size} shares of "${rule.outcome}" - will auto-outbid up to ${fmt(maxPrice)}` +
      `${rule.expiresAt ? `, auto-cancels ${new Date(rule.expiresAt).toUTCString()}` : ""}.`);
    return rule;
  }

  async cancelRule(ruleId, reason = "cancelled by user") {
    const rule = this.getRule(ruleId);
    if (!rule) throw new Error(`No rule with id ${ruleId}`);
    if (rule.status === "active" || rule.status === "capped") {
      if (rule.orderId) {
        try { await this.pm.cancelOrder(rule.orderId); } catch (err) {
          console.warn(`[rules] cancel order ${rule.orderId} failed: ${err.message}`);
        }
      }
      rule.status = "cancelled";
      rule.updatedAt = new Date().toISOString();
      this.store.save();
      this._log(rule, `Rule cancelled (${reason}). Resting order removed.`);
    }
    return rule;
  }

  async updateRule(ruleId, { maxPrice, size, expiresAt }) {
    const rule = this.getRule(ruleId);
    if (!rule) throw new Error(`No rule with id ${ruleId}`);
    if (expiresAt !== undefined) {
      if (expiresAt === null || expiresAt === "") {
        rule.expiresAt = null;
      } else {
        const ts = Date.parse(expiresAt);
        if (Number.isNaN(ts)) throw new Error(`Couldn't parse expiresAt "${expiresAt}".`);
        if (ts <= Date.now()) throw new Error(`expiresAt (${expiresAt}) is in the past.`);
        rule.expiresAt = new Date(ts).toISOString();
      }
    }
    if (maxPrice !== undefined) {
      if (!(maxPrice > 0 && maxPrice < 1)) throw new Error("maxPrice must be between 0 and 1.");
      rule.maxPrice = maxPrice;
      if (rule.status === "capped" && rule.maxPrice > (rule.myPrice ?? 0)) {
        rule.status = "active";
        rule.cappedNotified = false;
      }
    }
    if (size !== undefined) rule.size = size;
    rule.updatedAt = new Date().toISOString();
    this.store.save();
    this._log(rule, `Rule updated: max price now ${fmt(rule.maxPrice)}, size ${rule.size}.`);
    // Re-evaluate immediately against the latest known book
    const book = this.pm.books.get(rule.tokenId);
    if (book && book.bestBid !== null) {
      this._enqueue(rule.id, () => this._evaluate(rule, book.bestBid));
    }
    return rule;
  }

  // ---------- reactions ----------

  _onBook(summary) {
    const { tokenId, bestBid } = summary;
    if (bestBid === null || bestBid === undefined) return;
    for (const rule of this.activeRules()) {
      if (rule.tokenId !== tokenId) continue;
      this._enqueue(rule.id, () => this._evaluate(rule, bestBid, summary.bestAsk));
    }
  }

  _enqueue(ruleId, fn) {
    const prev = this._locks.get(ruleId) || Promise.resolve();
    const next = prev.then(fn).catch((err) => {
      console.error(`[rules] ${ruleId} action failed:`, err.message);
    });
    this._locks.set(ruleId, next);
  }

  /** Auto-cancel a rule whose expiry time has passed. Returns true if it expired. */
  async _expireIfDue(rule) {
    if (!rule.expiresAt || rule.status !== "active") return false;
    if (Date.now() < Date.parse(rule.expiresAt)) return false;
    if (rule.orderId) {
      try { await this.pm.cancelOrder(rule.orderId); } catch (err) {
        console.warn(`[rules] ${rule.id} expiry cancel failed: ${err.message}`);
      }
    }
    rule.status = "expired";
    rule.updatedAt = new Date().toISOString();
    this.store.save();
    this._log(rule, `Rule expired (${new Date(rule.expiresAt).toUTCString()}) - resting order cancelled as instructed.`, "warn");
    return true;
  }

  async _evaluate(rule, bestBid, bestAsk = null) {
    if (rule.status !== "active" || rule.myPrice === null) return;
    if (await this._expireIfDue(rule)) return;
    if (bestBid <= rule.myPrice) return; // we're still on top (or tied at our own level)

    // Someone outbid us.
    const tick = rule.tickSize || 0.01;
    const target = round(Math.min(bestBid + tick, rule.maxPrice));

    if (target <= rule.myPrice || bestBid >= rule.maxPrice) {
      // Can't go any higher without breaking the cap.
      if (!rule.cappedNotified) {
        rule.cappedNotified = true;
        rule.updatedAt = new Date().toISOString();
        this.store.save();
        this._log(rule,
          `Outbid at ${fmt(bestBid)} but my cap is ${fmt(rule.maxPrice)} - staying at ${fmt(rule.myPrice)}. ` +
          `Tell me a new max if you want to keep competing.`, "warn");
      }
      return;
    }

    // Throttle reposts so a bidding war doesn't spam the API.
    const last = this._lastAction.get(rule.id) || 0;
    const wait = config.minRepostIntervalMs - (Date.now() - last);
    if (wait > 0) await sleep(wait);
    if (rule.status !== "active") return;

    // Re-check the freshest book we have before acting.
    const latest = this.pm.books.get(rule.tokenId);
    const freshBid = latest?.bestBid ?? bestBid;
    if (freshBid <= rule.myPrice) return;
    const freshTarget = round(Math.min(freshBid + tick, rule.maxPrice));
    if (freshTarget <= rule.myPrice) return;

    // Don't cross the spread with the repost.
    const ask = latest?.bestAsk ?? bestAsk;
    if (ask !== null && ask !== undefined && freshTarget >= ask) {
      if (!rule.cappedNotified) {
        rule.cappedNotified = true;
        this.store.save();
        this._log(rule,
          `Outbidding to ${fmt(freshTarget)} would cross the ask (${fmt(ask)}). Holding at ${fmt(rule.myPrice)}.`, "warn");
      }
      return;
    }

    this._lastAction.set(rule.id, Date.now());

    // Cancel old order, place new one a tick above the competition.
    const remaining = Math.max(rule.size - (rule.filledSize || 0), 0);
    if (remaining <= 0) {
      rule.status = "filled";
      this.store.save();
      return;
    }
    // Cancel-then-replace: the new bid is only placed once the old order is
    // confirmed gone, so we can never end up with two resting bids.
    if (rule.orderId) {
      const gone = await this._ensureCancelled(rule);
      if (!gone) {
        const lastWarn = this._cancelWarnTs?.get(rule.id) || 0;
        if (Date.now() - lastWarn > 30000) {
          (this._cancelWarnTs ||= new Map()).set(rule.id, Date.now());
          this._log(rule,
            `Couldn't confirm my old ${fmt(rule.myPrice)} order was cancelled - holding off on the re-bid to avoid doubling up. Will retry.`, "warn");
        }
        return; // retry on the next book update
      }
    }
    const resp = await this.pm.placeOrder({ tokenId: rule.tokenId, side: "BUY", price: freshTarget, size: remaining });
    const oldPrice = rule.myPrice;
    rule.orderId = resp.orderID;
    rule.myPrice = freshTarget;
    rule.cappedNotified = false;
    rule.updatedAt = new Date().toISOString();
    this.store.save();
    this._log(rule, `Outbid detected at ${fmt(freshBid)} - moved my bid ${fmt(oldPrice)} -> ${fmt(freshTarget)} (cap ${fmt(rule.maxPrice)}).`);
  }

  /**
   * Cancel a rule's current order and confirm it is actually gone (cancelled
   * or fully filled). Returns false when we can't be sure - in that case the
   * caller must NOT place a replacement bid.
   */
  async _ensureCancelled(rule) {
    let cancelErr = null;
    try {
      const resp = await this.pm.cancelOrder(rule.orderId);
      const notCanceled = resp?.not_canceled ?? resp?.notCanceled;
      const failed = notCanceled && Object.prototype.hasOwnProperty.call(notCanceled, rule.orderId);
      if (!failed) return true;
      cancelErr = new Error(`exchange refused: ${JSON.stringify(notCanceled[rule.orderId])}`);
    } catch (err) {
      cancelErr = err;
    }
    // Cancel didn't clearly succeed - check the order's actual state.
    try {
      const detail = await this.pm.getOrder(rule.orderId);
      if (!detail) return true; // no record -> gone
      const status = String(detail.status || "").toUpperCase();
      const matched = Number(detail.size_matched || 0);
      if (status !== "LIVE" && status !== "OPEN") return true;   // cancelled/matched
      if (matched >= rule.size - 1e-9) return true;              // fully filled (reconcile logs it)
    } catch {
      // Can't verify either - assume it may still be resting.
    }
    console.warn(`[rules] ${rule.id} cancel unconfirmed: ${cancelErr?.message}`);
    return false;
  }

  /**
   * Periodic safety net: detect fills/cancellations that the websocket missed.
   */
  async _reconcile() {
    // Expiries fire from here too, so rules lapse on time even in a quiet market.
    for (const rule of this.activeRules()) {
      await this._expireIfDue(rule);
    }
    const active = this.activeRules().filter((r) => r.orderId);
    if (active.length === 0 || this.pm.readonly) return;
    let open;
    try {
      open = await this.pm.getOpenOrders();
    } catch {
      return; // transient
    }
    const openById = new Map(open.map((o) => [o.orderId, o]));
    for (const rule of active) {
      const o = openById.get(rule.orderId);
      if (o) {
        if (o.filled > (rule.filledSize || 0)) {
          rule.filledSize = o.filled;
          this.store.save();
          this._log(rule, `Partial fill: ${o.filled}/${rule.size} shares bought at ${fmt(rule.myPrice)}.`);
        }
        continue;
      }
      // Order no longer open: either fully filled or cancelled externally.
      let detail;
      try {
        detail = await this.pm.getOrder(rule.orderId);
      } catch {
        continue; // transient error - re-check next cycle
      }
      const matched = detail ? Number(detail.size_matched || 0) : null;
      if (matched !== null && matched >= rule.size - 1e-9) {
        rule.status = "filled";
        rule.filledSize = matched;
        rule.updatedAt = new Date().toISOString();
        this.store.save();
        this._log(rule, `ORDER FILLED: bought ${matched} shares of "${rule.outcome}" at ${fmt(rule.myPrice)}. Rule complete.`, "success");
      } else {
        rule.status = "error";
        rule.updatedAt = new Date().toISOString();
        this.store.save();
        this._log(rule,
          `My resting order disappeared (cancelled outside the app${matched ? `, ${matched} filled` : ""}). Rule paused - recreate it if still wanted.`, "warn");
      }
    }
  }

  _log(rule, text, level = "info") {
    const entry = this.store.addActivity("rule", `[${rule.id}] ${text}`, { ruleId: rule.id, level });
    this.notify(entry);
  }
}

function round(p) {
  return Math.round(p * 1000) / 1000;
}
function fmt(p) {
  if (p === null || p === undefined) return "?";
  return `${Math.round(p * 1000) / 10}¢`;
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
