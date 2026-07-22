// Ping-pong (table tennis) match win-probability model.
//
// Assumptions baked into the cheat sheet this reproduces:
//   - Best of 5 games; first to 3 game wins takes the match.
//   - Each game is first to 11 points, win by 2.
//   - Every point is a 50/50 coin flip (players assumed equal).
//
// From those, the probability of the leader winning the MATCH given the live
// score (games won + current-game points) is exact and computable - no lookup
// table needed, and it extends to any deuce score (10-10, 11-11, ...). Verified
// against the user's cheat sheet to the last decimal (see test-pingpong.mjs).

const GAME_TARGET = 11;
const GAMES_TO_WIN = 3;

/**
 * Probability the server-agnostic "player A" wins ONE game, racing to `target`
 * (win by 2) from the current point score a-b, with per-point win prob p.
 * Deuce (both >= target-1) is closed-form so recursion always terminates.
 */
export function gameWinProb(a, b, p = 0.5, target = GAME_TARGET) {
  const q = 1 - p;
  const memo = new Map();
  const rec = (x, y) => {
    // Someone has already won (reached target AND leads by >= 2).
    if (x >= target && x - y >= 2) return 1;
    if (y >= target && y - x >= 2) return 0;
    // Deuce zone: both within one point of target -> collapse by lead only.
    if (x >= target - 1 && y >= target - 1) {
      const d = x - y;
      if (d >= 2) return 1;
      if (d <= -2) return 0;
      const pDeuce = (p * p) / (p * p + q * q); // from 10-10 (tie)
      if (d === 0) return pDeuce;
      if (d === 1) return p + q * pDeuce;        // ahead by one
      return p * pDeuce;                          // behind by one (d === -1)
    }
    const key = x * 100 + y;
    if (memo.has(key)) return memo.get(key);
    const v = p * rec(x + 1, y) + q * rec(x, y + 1);
    memo.set(key, v);
    return v;
  };
  return rec(a, b);
}

/** Probability A wins the match from a pure GAME score, every game a 50/50 (fresh 0-0). */
function matchFromGames(gamesA, gamesB, pGame = 0.5) {
  const q = 1 - pGame;
  const memo = new Map();
  const rec = (ga, gb) => {
    if (ga >= GAMES_TO_WIN) return 1;
    if (gb >= GAMES_TO_WIN) return 0;
    const key = ga * 10 + gb;
    if (memo.has(key)) return memo.get(key);
    const v = pGame * rec(ga + 1, gb) + q * rec(ga, gb + 1);
    memo.set(key, v);
    return v;
  };
  return rec(gamesA, gamesB);
}

/**
 * Probability player A wins the MATCH given the full live score:
 *   gamesA-gamesB  = games already won by each (0..2)
 *   ptsA-ptsB      = points in the CURRENT game
 * `p` is A's per-point win probability (0.5 = the cheat-sheet baseline).
 * Future (not-yet-started) games are always assumed fresh at 50/50 per the
 * cheat sheet's model; only the current game uses the live point score.
 */
export function matchWinProb({ gamesA = 0, gamesB = 0, ptsA = 0, ptsB = 0, p = 0.5 }) {
  if (gamesA >= GAMES_TO_WIN) return 1;
  if (gamesB >= GAMES_TO_WIN) return 0;
  const g = gameWinProb(ptsA, ptsB, p);
  // Current game resolves first, then fresh 50/50 games decide the rest.
  return g * matchFromGames(gamesA + 1, gamesB, 0.5) +
    (1 - g) * matchFromGames(gamesA, gamesB + 1, 0.5);
}

/**
 * How far through the match are we, 0 (very start) .. 1 (match point)? Used to
 * scale the safety edge: bigger discount early (more uncertainty about who's
 * actually the stronger player), smaller late (the score has spoken).
 */
export function matchProgress({ gamesA = 0, gamesB = 0, ptsA = 0, ptsB = 0 }) {
  const gamesDecided = gamesA + gamesB;                 // 0..4
  const ptsInGame = Math.max(ptsA, ptsB);               // rough progress in current game
  const gameFrac = Math.min(ptsInGame / GAME_TARGET, 1);
  // A match is at most 5 games; treat (decided games + fraction of current) / 5.
  return Math.min((gamesDecided + gameFrac) / 5, 1);
}

/**
 * Fair, edge-adjusted BUY limit price for backing `side` (the player) at the
 * live score. The cheat-sheet probability assumes equal players; we shade the
 * price DOWN by a safety edge to (a) demand a margin and (b) hedge that the
 * scoreline leader may not truly be the stronger player. The edge is largest
 * early and shrinks toward the endgame.
 *
 *   price = fairProb * (1 - edge),  edge linearly from edgeEarly -> edgeLate
 *
 * Returns { fairProb, edge, price } with price rounded to the cent and clamped
 * to a sane tradable band. `favoredOnly` (default) yields null when the side is
 * not the favorite (fairProb <= 0.5) - we only back the leader at a discount.
 */
export function modelBuyPrice({
  gamesA = 0, gamesB = 0, ptsA = 0, ptsB = 0,
  edgeEarly = 0.20, edgeLate = 0.10,
  minPrice = 0.02, maxPrice = 0.97, favoredOnly = true,
}) {
  const fairProb = matchWinProb({ gamesA, gamesB, ptsA, ptsB });
  if (favoredOnly && fairProb <= 0.5) {
    return { fairProb, edge: null, price: null, reason: "not the favorite - we only back the scoreline leader at a discount" };
  }
  const progress = matchProgress({ gamesA, gamesB, ptsA, ptsB });
  const edge = edgeEarly + (edgeLate - edgeEarly) * progress; // early -> late
  let price = fairProb * (1 - edge);
  price = Math.round(price * 100) / 100;
  price = Math.max(minPrice, Math.min(maxPrice, price));
  return { fairProb, edge, price, progress };
}
