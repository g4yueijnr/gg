import { config } from "./config.js";

// Table-tennis sport id on BetsAPI / b365api.
const TT_SPORT_ID = 92;

/**
 * External live-score feed for table tennis. Polymarket US does not expose the
 * live point-by-point score, so the ping-pong strategy reads it here. BetsAPI
 * covers Setka Cup (league 22307) with in-play scores; set BETSAPI_TOKEN to
 * enable. The feed tells us WHICH matches are live and their score - Polymarket
 * is only where orders are placed.
 */
export class ExternalScoreFeed {
  constructor({ token = config.betsapiToken, host = config.betsapiHost, fetchImpl } = {}) {
    this.token = token;
    this.host = host || "https://api.b365api.com";
    this.fetch = fetchImpl || globalThis.fetch;
    this._cache = null;
    this._cacheAt = 0;
    this._cacheMs = 2000; // avoid hammering the API when many strategies poll
  }

  enabled() { return !!this.token && typeof this.fetch === "function"; }

  /** All live table-tennis matches with a parsed score: [{home, away, league, gamesA, gamesB, ptsA, ptsB}]. */
  async liveMatches() {
    if (!this.enabled()) return [];
    if (this._cache && Date.now() - this._cacheAt < this._cacheMs) return this._cache;
    const url = `${this.host}/v3/events/inplay?sport_id=${TT_SPORT_ID}&token=${encodeURIComponent(this.token)}`;
    let json;
    try {
      const res = await this.fetch(url);
      json = await res.json();
    } catch {
      return this._cache || [];
    }
    const results = json?.results || json?.data || [];
    const out = [];
    for (const ev of results) {
      const parsed = parseTableTennisScore(ev);
      if (!parsed) continue;
      out.push({
        home: ev.home?.name || ev.home || null,
        away: ev.away?.name || ev.away || null,
        league: ev.league?.name || null,
        leagueId: ev.league?.id != null ? String(ev.league.id) : null,
        eventId: ev.id != null ? String(ev.id) : null,
        ...parsed, // gamesA, gamesB, ptsA, ptsB (A = home)
      });
    }
    this._cache = out;
    this._cacheAt = Date.now();
    return out;
  }

  /**
   * Live score for the match between two named players, in the caller's A/B
   * orientation (A = playerA). Returns {gamesA, gamesB, ptsA, ptsB} or null.
   * Optionally scope to a league (e.g. Setka Cup id "22307").
   */
  async scoreFor(playerA, playerB, { leagueId } = {}) {
    const matches = await this.liveMatches();
    const a = normName(playerA), b = normName(playerB);
    for (const m of matches) {
      if (leagueId && m.leagueId && m.leagueId !== String(leagueId)) continue;
      const h = normName(m.home), w = normName(m.away);
      if (nameMatch(a, h) && nameMatch(b, w)) return { gamesA: m.gamesA, gamesB: m.gamesB, ptsA: m.ptsA, ptsB: m.ptsB, home: m.home, away: m.away, orient: "AB" };
      if (nameMatch(a, w) && nameMatch(b, h)) return { gamesA: m.gamesB, gamesB: m.gamesA, ptsA: m.ptsB, ptsB: m.ptsA, home: m.home, away: m.away, orient: "BA" };
    }
    return null;
  }
}

/** Normalize a player name for matching: lowercase, strip punctuation, sort tokens. */
function normName(n) {
  return String(n || "").toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter((w) => w.length >= 3).sort();
}
/** Two normalized names match if they share every significant token of the shorter one. */
function nameMatch(a, b) {
  if (!a.length || !b.length) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.every((tok) => long.some((o) => o === tok || o.startsWith(tok) || tok.startsWith(o)));
}

/**
 * Parse a BetsAPI in-play table-tennis event into {gamesA, gamesB, ptsA, ptsB},
 * A = home. Uses the per-game `scores` map (each {home, away}); a finished game
 * (11+, win by 2) counts toward games won, the last unfinished game is the
 * current points. Falls back to the `ss` set summary for games if needed.
 */
export function parseTableTennisScore(ev) {
  if (!ev || (ev.time_status && String(ev.time_status) !== "1")) return null; // 1 = in-play
  const scores = ev.scores || ev.score || null;
  let gamesHome = 0, gamesAway = 0, ptsHome = 0, ptsAway = 0, sawAny = false;
  if (scores && typeof scores === "object") {
    const keys = Object.keys(scores).sort((x, y) => Number(x) - Number(y));
    for (const k of keys) {
      const g = scores[k];
      const h = Number(g?.home), a = Number(g?.away);
      if (Number.isNaN(h) || Number.isNaN(a)) continue;
      sawAny = true;
      const done = (h >= 11 || a >= 11) && Math.abs(h - a) >= 2;
      if (done) { if (h > a) gamesHome++; else gamesAway++; }
      else { ptsHome = h; ptsAway = a; } // current (unfinished) game
    }
  }
  // Fallback: derive games won from the "ss" summary ("2-1") if scores were absent.
  if (!sawAny && typeof ev.ss === "string" && /^\d+\s*-\s*\d+$/.test(ev.ss)) {
    const [h, a] = ev.ss.split("-").map((n) => Number(n.trim()));
    gamesHome = h; gamesAway = a;
  } else if (!sawAny) {
    return null;
  }
  return { gamesA: gamesHome, gamesB: gamesAway, ptsA: ptsHome, ptsB: ptsAway };
}
