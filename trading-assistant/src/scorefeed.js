import { config } from "./config.js";

// Table-tennis sport id on BetsAPI / b365api.
const TT_SPORT_ID = 92;
const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
};

/**
 * External live table-tennis score feed. Polymarket US does not publish the
 * live point-by-point score, so the ping-pong strategy reads it here. The feed
 * tells us WHICH matches are live and their score; Polymarket is only where
 * orders are placed.
 *
 * Providers:
 *   - "sofascore" (default, FREE, no key): api.sofascore.com public JSON.
 *   - "betsapi"  (optional, needs BETSAPI_TOKEN): covers Setka Cup as league 22307.
 * Sofascore is used automatically unless a BetsAPI token is set.
 */
export class ExternalScoreFeed {
  constructor({ token = config.betsapiToken, betsapiHost = config.betsapiHost, provider, fetchImpl } = {}) {
    this.token = token;
    this.betsapiHost = betsapiHost || "https://api.b365api.com";
    this.provider = provider || (token ? "betsapi" : "sofascore");
    this.fetch = fetchImpl || globalThis.fetch;
    this._cache = null;
    this._cacheAt = 0;
    this._cacheMs = 2500; // don't hammer the API when many strategies poll
  }

  // Sofascore needs no key, so the feed is enabled whenever we have fetch.
  enabled() { return typeof this.fetch === "function" && (this.provider !== "betsapi" || !!this.token); }
  sourceName() { return this.provider === "betsapi" ? "BetsAPI" : "Sofascore (free)"; }

  async _get(url) {
    const res = await this.fetch(url, { headers: BROWSER_HEADERS });
    if (!res || (res.ok === false)) throw new Error(`HTTP ${res?.status}`);
    return res.json();
  }

  /** All live table-tennis matches with a parsed score: [{home, away, league, gamesA, gamesB, ptsA, ptsB}]. */
  async liveMatches() {
    if (!this.enabled()) return [];
    if (this._cache && Date.now() - this._cacheAt < this._cacheMs) return this._cache;
    let out = [];
    try { out = this.provider === "betsapi" ? await this._betsapiLive() : await this._sofascoreLive(); }
    catch { return this._cache || []; }
    this._cache = out;
    this._cacheAt = Date.now();
    return out;
  }

  async _sofascoreLive() {
    const json = await this._get("https://api.sofascore.com/api/v1/sport/table-tennis/events/live");
    const out = [];
    for (const ev of json?.events || []) {
      const parsed = parseSofascore(ev);
      if (!parsed) continue;
      out.push({
        home: ev.homeTeam?.name || null,
        away: ev.awayTeam?.name || null,
        league: ev.tournament?.name || ev.tournament?.category?.name || null,
        eventId: ev.id != null ? String(ev.id) : null,
        ...parsed,
      });
    }
    return out;
  }

  async _betsapiLive() {
    const json = await this._get(`${this.betsapiHost}/v3/events/inplay?sport_id=${TT_SPORT_ID}&token=${encodeURIComponent(this.token)}`);
    const out = [];
    for (const ev of json?.results || json?.data || []) {
      const parsed = parseBetsapi(ev);
      if (!parsed) continue;
      out.push({
        home: ev.home?.name || ev.home || null,
        away: ev.away?.name || ev.away || null,
        league: ev.league?.name || null,
        leagueId: ev.league?.id != null ? String(ev.league.id) : null,
        eventId: ev.id != null ? String(ev.id) : null,
        ...parsed,
      });
    }
    return out;
  }

  /**
   * Live score for the match between two named players, in the caller's A/B
   * orientation (A = playerA). Returns {gamesA, gamesB, ptsA, ptsB} or null.
   */
  async scoreFor(playerA, playerB) {
    const matches = await this.liveMatches();
    const a = normName(playerA), b = normName(playerB);
    for (const m of matches) {
      const h = normName(m.home), w = normName(m.away);
      if (nameMatch(a, h) && nameMatch(b, w)) return { gamesA: m.gamesA, gamesB: m.gamesB, ptsA: m.ptsA, ptsB: m.ptsB, home: m.home, away: m.away };
      if (nameMatch(a, w) && nameMatch(b, h)) return { gamesA: m.gamesB, gamesB: m.gamesA, ptsA: m.ptsB, ptsB: m.ptsA, home: m.home, away: m.away };
    }
    return null;
  }
}

/** Normalize a player name for matching: lowercase, strip punctuation, sort significant tokens. */
function normName(n) {
  return String(n || "").toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter((w) => w.length >= 3).sort();
}
/** Two names match if every significant token of the shorter appears in the longer (prefix-tolerant). */
function nameMatch(a, b) {
  if (!a.length || !b.length) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.every((tok) => long.some((o) => o === tok || o.startsWith(tok) || tok.startsWith(o)));
}

/** Turn a [{home,away},...] per-game array into {gamesA,gamesB,ptsA,ptsB} (A=home). */
function fromGamesArray(periods) {
  let gamesA = 0, gamesB = 0, ptsA = 0, ptsB = 0, saw = false;
  for (const g of periods) {
    const h = Number(g.home), a = Number(g.away);
    if (Number.isNaN(h) || Number.isNaN(a)) continue;
    saw = true;
    const done = (h >= 11 || a >= 11) && Math.abs(h - a) >= 2;
    if (done) { if (h > a) gamesA++; else gamesB++; }
    else { ptsA = h; ptsB = a; } // the unfinished game holds the current points
  }
  return saw ? { gamesA, gamesB, ptsA, ptsB } : null;
}

/** Sofascore live table-tennis event -> score. period1..periodN are the games' points. */
export function parseSofascore(ev) {
  if (!ev) return null;
  const t = ev.status?.type;
  if (t && t !== "inprogress") return null; // only live matches
  const hs = ev.homeScore || {}, as = ev.awayScore || {};
  const periods = [];
  for (let k = 1; k <= 7; k++) {
    const h = hs[`period${k}`], a = as[`period${k}`];
    if (h === undefined && a === undefined) continue;
    periods.push({ home: h ?? 0, away: a ?? 0 });
  }
  let score = periods.length ? fromGamesArray(periods) : null;
  // Fallback: only games-won totals are present.
  if (!score && (hs.current !== undefined || as.current !== undefined)) {
    score = { gamesA: Number(hs.current || 0), gamesB: Number(as.current || 0), ptsA: 0, ptsB: 0 };
  }
  if (!score) return null;
  // If the per-game count disagrees with the reported games-won total, trust the total.
  if (hs.current !== undefined && Number(hs.current) >= score.gamesA) score.gamesA = Number(hs.current);
  if (as.current !== undefined && Number(as.current) >= score.gamesB) score.gamesB = Number(as.current);
  return score;
}

/** BetsAPI in-play table-tennis event -> score (A=home). */
export function parseBetsapi(ev) {
  if (!ev || (ev.time_status && String(ev.time_status) !== "1")) return null;
  const scores = ev.scores || ev.score || null;
  if (scores && typeof scores === "object") {
    const periods = Object.keys(scores).sort((x, y) => Number(x) - Number(y)).map((k) => ({ home: scores[k]?.home, away: scores[k]?.away }));
    const s = fromGamesArray(periods);
    if (s) return s;
  }
  if (typeof ev.ss === "string" && /^\d+\s*-\s*\d+$/.test(ev.ss)) {
    const [h, a] = ev.ss.split("-").map((n) => Number(n.trim()));
    return { gamesA: h, gamesB: a, ptsA: 0, ptsB: 0 };
  }
  return null;
}

// Back-compat alias used by tests.
export const parseTableTennisScore = parseBetsapi;
