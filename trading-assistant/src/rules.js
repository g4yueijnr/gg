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
    this._expiryTimers = new Map(); // ruleId -> timer for precise timed cancels
  }

  start() {
    this.pm.onBookUpdate((summary) => this._onBook(summary));
    // Real-time fills/cancels/rejects from the exchange's private stream -
    // the primary fill path; reconcile below is the safety net.
    this.pm.onOrderEvent?.((evt) => this._onOrderEvent(evt));
    this.pm.startPrivateFeed?.();

    for (const rule of this.activeRules()) {
      this.pm.watchToken(rule.tokenId);
      this._armExpiry(rule);
      // Repair any rule pinned to a stale market id from an older version.
      if (this.pm.canonicalTokenId) {
        this.pm.canonicalTokenId(rule.tokenId).then((fixed) => {
          if (fixed !== rule.tokenId) {
            this.pm.unwatchToken?.(rule.tokenId);
            rule.tokenId = fixed;
            this.store.save();
            this.pm.watchToken(fixed);
          }
        }).catch(() => {});
      }
    }
    this._reconcileTimer = setInterval(() => {
      this._reconcile().catch((err) => console.error("[rules] reconcile error:", err.message));
    }, config.reconcileIntervalMs);
    // Startup reconciliation: verify tracked orders against the exchange now
    // and surface any orphaned exchange orders no rule knows about.
    setTimeout(() => {
      this._reconcile().catch(() => {});
      this._detectOrphans().catch(() => {});
    }, 1500);
    console.log(`[rules] engine started with ${this.activeRules().length} active rule(s)`);
  }

  stop() {
    clearInterval(this._reconcileTimer);
    for (const t of this._expiryTimers.values()) clearTimeout(t);
    this._expiryTimers.clear();
  }

  /** Emergency stop: cancel every rule and every open order on the account. */
  async emergencyStop() {
    const stopped = [];
    for (const rule of this.store.state.rules) {
      if (rule.status === "active" || rule.status === "capped") {
        rule.status = "cancelled";
        rule.updatedAt = new Date().toISOString();
        stopped.push(rule.id);
        clearTimeout(this._expiryTimers.get(rule.id));
      }
    }
    this.store.save();
    let cancelled = { canceledOrderIds: [] };
    try {
      cancelled = await this.pm.cancelAllOrders();
    } catch (err) {
      this.store.addActivity("system", `EMERGENCY STOP: rules stopped but cancel-all FAILED: ${err.message}. Check open orders manually!`, { level: "warn" });
      throw err;
    }
    const entry = this.store.addActivity("system",
      `EMERGENCY STOP: ${stopped.length} rule(s) stopped, ${(cancelled.canceledOrderIds || []).length} open order(s) cancelled.`, { level: "warn" });
    this.notify(entry);
    return { rulesStopped: stopped, ordersCancelled: cancelled.canceledOrderIds || [] };
  }

  /** Surface exchange orders that no rule is tracking (placed manually or lost). */
  async _detectOrphans() {
    if (this.pm.readonly) return;
    let open;
    try { open = await this.pm.getOpenOrders(); } catch { return; }
    const tracked = new Set(this.store.state.rules.map((r) => r.orderId).filter(Boolean));
    for (const o of open) {
      if (!tracked.has(o.orderId)) {
        this.store.addActivity("system",
          `Found an open order no rule is managing: ${o.side} ${o.size} @ ${fmt(o.price)} on "${o.market}" (${String(o.orderId).slice(0, 12)}...). ` +
          `It rests untouched - ask the assistant to cancel it if unwanted.`, { level: "warn" });
      }
    }
  }

  /** Precise timed cancels: an in-process timer fires within ~1s of expiresAt. */
  _armExpiry(rule) {
    clearTimeout(this._expiryTimers.get(rule.id));
    this._expiryTimers.delete(rule.id);
    if (!rule.expiresAt || rule.status !== "active") return;
    const ms = Date.parse(rule.expiresAt) - Date.now();
    if (ms > 2 ** 31 - 1000) return; // >24 days out: reconcile fallback covers it
    const t = setTimeout(() => {
      this._enqueue(rule.id, () => this._expireIfDue(rule));
    }, Math.max(ms, 0));
    if (t.unref) t.unref();
    this._expiryTimers.set(rule.id, t);
  }

  /**
   * Real-time order event from the exchange's private stream. Applies fill
   * progress instantly (and fires sell-after-fill exits) instead of waiting
   * for the reconcile cycle.
   */
  _onOrderEvent(evt) {
    const rule = this.store.state.rules.find((r) => r.orderId === evt.orderId);
    if (!rule) return;
    this._enqueue(rule.id, async () => {
      if (rule.status !== "active" && rule.status !== "capped") return;
      // Ignore events for an order this rule has already moved past (e.g. the
      // CANCEL for the old order during a cancel-and-replace). Its fills, if
      // any, are reconciled by _captureLateFills; crediting them here against
      // the NEW order's counter would double-count.
      if (rule.orderId !== evt.orderId) return;
      if (evt.rejectReason || String(evt.state).includes("REJECT")) {
        this._log(rule, `Exchange REJECTED my order: ${evt.rejectReason || evt.state}. Rule paused.`, "warn");
        rule.status = "error";
        this.store.save();
        return;
      }
      await this._applyFillProgress(rule, evt.cumQuantity);
      // Fully filled? Kick the completion logic (rest next slice / finish rule) now.
      if (String(evt.state).includes("FILLED") && !String(evt.state).includes("PARTIALLY")) {
        setTimeout(() => this._reconcile().catch(() => {}), 300);
      }
    });
  }

  /** Idempotent fill accounting shared by the private stream and reconcile. */
  async _applyFillProgress(rule, cumQuantity) {
    const seen = rule.orderFilledSeen || 0;
    if (!(cumQuantity > seen)) return;
    const newlyFilled = cumQuantity - seen;
    rule.orderFilledSeen = cumQuantity;
    rule.filledSize = (rule.filledSize || 0) + newlyFilled;
    rule.spentUsd = round2((rule.spentUsd || 0) + newlyFilled * (rule.myPrice || 0));
    this.store.save();
    this._log(rule, `FILL: ${newlyFilled} shares at ${fmt(rule.myPrice)} (${rule.filledSize}/${rule.size} total` +
      `${rule.maxCostUsd ? `, $${rule.spentUsd} of $${rule.maxCostUsd} budget` : ""}).`, "success");
    await this._maybeExit(rule, newlyFilled);
  }

  /** Sell-after-fill: place the configured exit for freshly filled contracts. */
  async _maybeExit(rule, qty) {
    const exit = rule.onFill;
    if (!exit || exit.mode === "none" || qty < 1) return;
    let price = exit.price;
    if (exit.mode === "immediate" || price === undefined || price === null) {
      // Marketable limit: sell into the current best bid on our side of the book.
      const book = this.pm.books.get(rule.tokenId);
      const view = sideView(rule.outcomeSide, book?.bestBid ?? null, book?.bestAsk ?? null);
      price = view.bid;
      if (price === null || price === undefined) {
        // No live bid to hit - rest at our entry price so nothing dumps blindly.
        price = rule.myPrice;
        this._log(rule, `Exit: no live bid to sell ${qty} into - resting a sell at my entry ${fmt(price)} instead.`, "warn");
      }
    }
    try {
      const resp = await this.pm.placeOrder({
        tokenId: rule.tokenId, side: "SELL", price, size: qty, outcomeSide: rule.outcomeSide,
        allowMarketable: true, // exits are meant to execute, not rest
      });
      this._log(rule, `EXIT placed: selling ${qty} at ${fmt(price)} (order ${String(resp.orderID).slice(0, 12)}...).`, "success");
    } catch (err) {
      this._log(rule, `EXIT FAILED for ${qty} filled shares: ${err.message}. Position remains open - tell me how to handle it.`, "warn");
    }
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
  async createAutoOutbid({ tokenId, size, startPrice, maxPrice, marketQuestion, outcome, conditionId, expiresAt, outcomeSide, maxCostUsd, onFill }) {
    // onFill: what to do when contracts fill. {mode:"none"} (default),
    // {mode:"limit", price} (rest a sell at price), or {mode:"immediate"}
    // (marketable sell into the live best bid, per fill).
    if (onFill && onFill.mode && !["none", "limit", "immediate"].includes(onFill.mode)) {
      throw new Error(`Unknown onFill mode "${onFill.mode}" - use none, limit, or immediate.`);
    }
    if (onFill?.mode === "limit" && !(onFill.price > 0 && onFill.price < 1)) {
      throw new Error("onFill.price must be between 0 and 1 (dollars per share) for limit exits.");
    }
    outcomeSide = String(outcomeSide || "YES").toUpperCase() === "NO" ? "NO" : "YES";
    if (outcomeSide === "NO" && this.pm.platform !== "us") {
      throw new Error("On Polymarket global, bid on the No outcome by using its own tokenId - don't pass outcomeSide.");
    }
    if (maxCostUsd !== undefined && maxCostUsd !== null && !(maxCostUsd > 0)) {
      throw new Error("maxCostUsd must be a positive dollar amount.");
    }
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
    // Worst-case exposure = the budget if set, otherwise full size at the cap.
    const worstExposure = maxCostUsd ? Math.min(maxCostUsd, size * maxPrice) : size * maxPrice;
    this.pm.checkLimits({ price: worstExposure / size, size });

    // Pin the rule to the exchange's canonical market id so the 24/7 engine
    // never watches or bids against a stale identifier.
    if (this.pm.canonicalTokenId) {
      tokenId = await this.pm.canonicalTokenId(tokenId);
    }

    const tickSize = await this.pm.getTickSize(tokenId);
    const book = await this.pm.getOrderBook(tokenId);
    // Pin the rule to whichever market id the book actually answered under,
    // so the live feed, polling, and orders all speak the same name.
    if (book.tokenId && book.tokenId !== tokenId) tokenId = book.tokenId;
    // View the book from the side we're bidding on (NO bid = mirror of YES ask).
    const view = sideView(outcomeSide, book.bestBid, book.bestAsk);

    let target;
    if (startPrice === undefined || startPrice === null) {
      // Relative start: one tick above whoever currently leads the book.
      if (view.bid === null) {
        throw new Error(
          `There are no resting ${outcomeSide} bids in this book right now, so 'one tick above the best bid' is undefined. ` +
          "Give an explicit starting price instead.",
        );
      }
      target = Math.min(round(view.bid + tickSize), maxPrice);
    } else {
      target = startPrice;
      // If the market already bids at/above our start price, start by outbidding it (within cap).
      if (view.bid !== null && view.bid >= startPrice) {
        target = Math.min(round(view.bid + tickSize), maxPrice);
      }
    }
    if (view.ask !== null && target >= view.ask) {
      throw new Error(
        `A resting ${outcomeSide} bid at ${fmt(target)} would cross the ${outcomeSide} ask (${fmt(view.ask)}) and fill immediately. ` +
        `Lower the price, or place a normal order instead if immediate fill is wanted.`,
      );
    }

    const rule = {
      id: this.store.nextRuleId(),
      kind: "auto_outbid",
      tokenId,
      conditionId: conditionId || null,
      marketQuestion: marketQuestion || tokenId,
      // The exchange's own name for this market - ground truth for the panel,
      // so a rule can never be mislabeled from a free-text guess.
      marketTitle: book.marketTitle || marketQuestion || tokenId,
      outcome: outcome || book.outcome || "",
      side: "BUY",
      outcomeSide,
      size,
      startPrice: target,
      maxPrice,
      maxCostUsd: maxCostUsd || null,
      onFill: onFill && onFill.mode !== "none" ? onFill : null,
      spentUsd: 0,
      expiresAt: expiryTs ? new Date(expiryTs).toISOString() : null,
      tickSize,
      status: "active",
      orderId: null,
      myPrice: null,
      mySize: null,
      filledSize: 0,       // cumulative across all of this rule's orders
      orderFilledSeen: 0,  // fills already counted for the CURRENT order
      cappedNotified: false,
      budgetNotified: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Budget-capped sizing: never let price x size exceed the budget.
    let initialSize = size;
    if (maxCostUsd) {
      initialSize = Math.min(size, Math.floor(maxCostUsd / target));
      if (initialSize < 1) {
        throw new Error(`A $${maxCostUsd} budget doesn't cover even 1 contract at ${fmt(target)}.`);
      }
    }

    const resp = await this.pm.placeOrder({ tokenId, side: "BUY", price: target, size: initialSize, outcomeSide });
    rule.orderId = resp.orderID;
    rule.myPrice = target;
    rule.mySize = initialSize;
    this.store.state.rules.push(rule);
    this.store.save();

    this.pm.watchToken(tokenId);
    this._armExpiry(rule);
    this._log(rule,
      `Rule created: bidding ${fmt(target)} for ${initialSize} ${outcomeSide === "NO" ? "NO " : ""}shares of "${rule.outcome}" - will auto-outbid up to ${fmt(maxPrice)}` +
      `${rule.maxCostUsd ? `, budget $${rule.maxCostUsd} (size shrinks as price rises)` : ""}` +
      `${rule.onFill ? `, fills auto-sell ${rule.onFill.mode === "limit" ? `at ${fmt(rule.onFill.price)}` : "immediately (marketable)"}` : ""}` +
      `${rule.expiresAt ? `, auto-cancels ${new Date(rule.expiresAt).toUTCString()}` : ""}.`);
    return rule;
  }

  async cancelRule(ruleId, reason = "cancelled by user") {
    const rule = this.getRule(ruleId);
    if (!rule) throw new Error(`No rule with id ${ruleId}`);
    // Already terminated and its order is gone - nothing to do.
    if (rule.status === "cancelled" || rule.status === "expired") return rule;
    // ALWAYS try to pull the resting order, whatever the rule's status. An
    // "error" (or even "filled") rule can still have a live order on the book -
    // that's exactly how the reconcile race used to orphan orders - so cancel
    // it before deactivating, or a "fresh" rule ends up bidding against it.
    if (rule.orderId) {
      try { await this.pm.cancelOrder(rule.orderId); } catch (err) {
        console.warn(`[rules] cancel order ${rule.orderId} failed: ${err.message}`);
      }
    }
    rule.status = "cancelled";
    rule.updatedAt = new Date().toISOString();
    clearTimeout(this._expiryTimers.get(rule.id));
    this.store.save();
    this._log(rule, `Rule cancelled (${reason}). Resting order removed.`);
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
    this._armExpiry(rule);
    this._log(rule, `Rule updated: max price now ${fmt(rule.maxPrice)}, size ${rule.size}.`);
    // Re-evaluate immediately against the latest known book - but never act
    // on stale cached data (fresh events will re-trigger evaluation anyway).
    const book = this.pm.books.get(rule.tokenId);
    if (book && Date.now() - (book.ts || 0) < 30000) {
      this._enqueue(rule.id, () => this._evaluate(rule, book.bestBid, book.bestAsk));
    }
    return rule;
  }

  // ---------- reactions ----------

  _onBook(summary) {
    const { tokenId, bestBid, bestAsk } = summary;
    for (const rule of this.activeRules()) {
      if (rule.tokenId !== tokenId) continue;
      // NO rules react to ask moves, YES rules to bid moves - _evaluate sorts it out.
      this._enqueue(rule.id, () => this._evaluate(rule, bestBid, bestAsk));
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

  async _evaluate(rule, rawBestBid, rawBestAsk = null) {
    if (rule.status !== "active" || rule.myPrice === null) return;
    if (await this._expireIfDue(rule)) return;
    // Convert the market book into the side this rule bids on
    // (for NO rules the best NO bid mirrors the YES ask).
    const view = sideView(rule.outcomeSide, rawBestBid, rawBestAsk);
    const bestBid = view.bid;
    if (bestBid === null || bestBid === undefined) return;
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
    const freshView = latest ? sideView(rule.outcomeSide, latest.bestBid, latest.bestAsk) : view;
    const freshBid = freshView.bid ?? bestBid;
    if (freshBid <= rule.myPrice) return;
    const freshTarget = round(Math.min(freshBid + tick, rule.maxPrice));
    if (freshTarget <= rule.myPrice) return;

    // Don't cross the spread with the repost.
    const ask = freshView.ask ?? view.ask;
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
    // Budget cap: shrink the size as the price rises so spend stays bounded.
    let allowed = rule.size;
    if (rule.maxCostUsd) {
      const budgetLeft = rule.maxCostUsd - (rule.spentUsd || 0);
      allowed = Math.min(allowed, Math.floor(budgetLeft / freshTarget));
    }
    const remaining = Math.max(Math.min(rule.size - (rule.filledSize || 0), allowed), 0);
    if (remaining <= 0) {
      if ((rule.filledSize || 0) >= rule.size) {
        rule.status = "filled";
        this.store.save();
      } else if (rule.maxCostUsd && !rule.budgetNotified) {
        rule.budgetNotified = true;
        this.store.save();
        this._log(rule,
          `Competing at ${fmt(freshTarget)} would blow the $${rule.maxCostUsd} budget - holding my current bid. ` +
          `Raise the budget or cap if you want to keep fighting.`, "warn");
      }
      return;
    }
    // Cancel-then-replace: the new bid is only placed once the old order is
    // confirmed gone, so we can never end up with two resting bids.
    const oldPrice = rule.myPrice;
    const oldSize = rule.mySize;
    const oldOrderId = rule.orderId;
    const oldSeen = rule.orderFilledSeen || 0;
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
      // CRITICAL money-safety: the old order may have FILLED in the instant
      // before it was cancelled. Credit those fills (updates filledSize and
      // spentUsd) BEFORE sizing the replacement, so a fill mid-re-bid can
      // never make us buy past the total size or blow the budget.
      await this._captureLateFills(rule, oldOrderId, oldPrice, oldSeen);
    }
    // Re-size against the freshest fill/budget state now that late fills are in.
    let reAllowed = rule.size;
    if (rule.maxCostUsd) {
      reAllowed = Math.min(reAllowed, Math.floor((rule.maxCostUsd - (rule.spentUsd || 0)) / freshTarget));
    }
    const finalSize = Math.max(Math.min(rule.size - (rule.filledSize || 0), reAllowed), 0);
    if (finalSize <= 0) {
      // The old order filling completed the rule (or exhausted the budget) -
      // don't rest a replacement.
      rule.orderId = null;
      rule.status = "filled";
      rule.updatedAt = new Date().toISOString();
      this.store.save();
      if ((rule.filledSize || 0) >= rule.size - 1e-9) {
        this._log(rule, `Filled ${rule.filledSize}/${rule.size} of "${rule.outcome}" - rule complete, no re-bid needed.`, "success");
      } else {
        this._log(rule,
          `Bought ${rule.filledSize}/${rule.size} of "${rule.outcome}" for $${rule.spentUsd || 0} - the $${rule.maxCostUsd} budget is spent, so I stopped here. ` +
          `Raise the budget if you want the remaining ${rule.size - rule.filledSize}.`, "warn");
      }
      return;
    }
    const resp = await this.pm.placeOrder({ tokenId: rule.tokenId, side: "BUY", price: freshTarget, size: finalSize, outcomeSide: rule.outcomeSide });
    rule.orderId = resp.orderID;
    rule.myPrice = freshTarget;
    rule.mySize = finalSize;
    rule.orderFilledSeen = 0;
    rule.cappedNotified = false;
    rule.budgetNotified = false;
    rule.updatedAt = new Date().toISOString();
    this.store.save();
    const resized = oldSize !== null && oldSize !== finalSize;
    this._log(rule,
      `Outbid detected at ${fmt(freshBid)} - moved my bid ${fmt(oldPrice)} -> ${fmt(freshTarget)} (cap ${fmt(rule.maxPrice)})` +
      `${resized ? `, size ${oldSize} -> ${finalSize} to stay under the $${rule.maxCostUsd} budget` : ""}.`);
  }

  /** Credit fills that landed on a just-cancelled order before it died. */
  async _captureLateFills(rule, orderId, price, alreadySeen) {
    if (!orderId) return;
    try {
      const detail = await this.pm.getOrder(orderId);
      const matched = detail ? Number(detail.size_matched || 0) : 0;
      if (matched > alreadySeen) {
        const newlyFilled = matched - alreadySeen;
        rule.filledSize = (rule.filledSize || 0) + newlyFilled;
        rule.spentUsd = round2((rule.spentUsd || 0) + newlyFilled * (price || 0));
        this.store.save();
        this._log(rule, `${newlyFilled} shares had filled at ${fmt(price)} before the re-bid (${rule.filledSize}/${rule.size} total).`);
        await this._maybeExit(rule, newlyFilled);
      }
    } catch { /* reconcile safety net will catch it */ }
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
      if (matched >= (rule.mySize ?? rule.size) - 1e-9) return true; // order fully filled (reconcile logs it)
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
    // Run each rule's check THROUGH its action lock so it can never interleave
    // with a cancel-and-replace in _evaluate. Without this, reconcile could see
    // the just-cancelled old order missing and wrongly mark a healthy,
    // still-outbidding rule as "error" (which also orphaned its new order).
    await Promise.all(active.map((rule) => {
      const snapOrderId = rule.orderId;
      return new Promise((resolve) => {
        this._enqueue(rule.id, async () => {
          try { await this._reconcileRule(rule, openById, snapOrderId); }
          finally { resolve(); }
        });
      });
    }));
  }

  async _reconcileRule(rule, openById, snapOrderId) {
    if (rule.status !== "active" || !rule.orderId) return;
    // The order was replaced while we were listing open orders - the new one
    // gets checked next cycle; don't judge it against a stale snapshot.
    if (rule.orderId !== snapOrderId) return;

    const o = openById.get(rule.orderId);
    if (o) {
      await this._applyFillProgress(rule, o.filled); // idempotent; exits fire inside
      return;
    }
    // Not in the (possibly stale) open-orders snapshot: verify against the
    // LIVE order before concluding anything.
    let detail;
    try {
      detail = await this.pm.getOrder(rule.orderId);
    } catch {
      return; // transient error - re-check next cycle
    }
    const matched = detail ? Number(detail.size_matched || 0) : null;
    // Credit any fills first (idempotent), then decide the order's fate.
    if (matched !== null) await this._applyFillProgress(rule, matched);
    // Still resting - the snapshot was just stale (common right after a
    // re-bid). Leave the rule active; NEVER error a live order.
    const liveStatus = String(detail?.status || "").toUpperCase();
    if (liveStatus === "LIVE" || liveStatus === "OPEN") return;
    {
      // The order is genuinely gone (filled or cancelled outside the app).
      const orderFullyFilled = matched !== null && matched >= (rule.mySize ?? rule.size) - 1e-9;
      const budgetLeft = rule.maxCostUsd ? rule.maxCostUsd - (rule.spentUsd || 0) : Infinity;
      const wantMore = rule.size - (rule.filledSize || 0);
      const affordable = Math.min(wantMore, Math.floor(budgetLeft / (rule.myPrice || 1)));

      if (orderFullyFilled && wantMore > 1e-9 && affordable >= 1) {
        // A budget-shrunk order filled completely but the rule isn't done -
        // rest the next slice at the same price and keep going.
        try {
          const resp = await this.pm.placeOrder({
            tokenId: rule.tokenId, side: "BUY", price: rule.myPrice,
            size: affordable, outcomeSide: rule.outcomeSide,
          });
          rule.orderId = resp.orderID;
          rule.mySize = affordable;
          rule.orderFilledSeen = 0;
          rule.updatedAt = new Date().toISOString();
          this.store.save();
          this._log(rule, `Order filled (${rule.filledSize}/${rule.size} total, $${rule.spentUsd || 0} spent) - resting the next ${affordable} shares at ${fmt(rule.myPrice)}.`, "success");
        } catch (err) {
          rule.status = "error";
          this.store.save();
          this._log(rule, `Order filled but re-resting the remainder failed: ${err.message}. Rule paused.`, "warn");
        }
      } else if (orderFullyFilled || (rule.filledSize || 0) >= rule.size - 1e-9 || (rule.maxCostUsd && affordable < 1 && matched !== null)) {
        rule.status = "filled";
        rule.updatedAt = new Date().toISOString();
        this.store.save();
        this._log(rule,
          `ORDER FILLED: bought ${rule.filledSize} shares of "${rule.outcome}" (latest at ${fmt(rule.myPrice)}${rule.spentUsd ? `, $${rule.spentUsd} total` : ""}). Rule complete.`, "success");
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
function round2(x) {
  return Math.round(x * 100) / 100;
}

/**
 * View a market's best bid/ask from the side being bid on. For YES it's the
 * book as-is; for NO, prices mirror across $1: the best NO bid is what the
 * best YES ask implies, and vice versa.
 */
function sideView(outcomeSide, bestBid, bestAsk) {
  if (outcomeSide !== "NO") {
    return { bid: bestBid ?? null, ask: bestAsk ?? null };
  }
  return {
    bid: bestAsk !== null && bestAsk !== undefined ? round(1 - bestAsk) : null,
    ask: bestBid !== null && bestBid !== undefined ? round(1 - bestBid) : null,
  };
}
function fmt(p) {
  if (p === null || p === undefined) return "?";
  return `${Math.round(p * 1000) / 10}¢`;
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
