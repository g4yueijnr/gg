import "dotenv/config";

function bool(v, def = false) {
  if (v === undefined || v === "") return def;
  return ["1", "true", "yes", "on"].includes(String(v).toLowerCase());
}

export const config = {
  port: Number(process.env.PORT || 3000),

  // --- Anthropic / Claude (the chatbot brain) ---
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
  // Haiku is ~3x cheaper than Sonnet and plenty now that the trading logic
  // (pricing, crossing guard, order books) lives in the engine, not the AI -
  // the model just relays correct tool results. Set CLAUDE_MODEL=claude-sonnet-5
  // only if you want a sharper chat and don't mind the cost.
  model: process.env.CLAUDE_MODEL || "claude-haiku-4-5",

  // --- Polymarket US (the regulated US app) ---
  // Get both from https://polymarket.us/developer after verifying your account in the iOS app.
  polymarketUsKeyId: process.env.POLYMARKET_US_KEY_ID || "",
  polymarketUsSecret: process.env.POLYMARKET_US_SECRET_KEY || "",

  // --- External live-score feed (ping-pong strategy) ---
  // Polymarket does NOT expose the live table-tennis score, so the ping-pong
  // strategy reads it from BetsAPI, which covers Setka Cup (league 22307).
  // Get a token at https://betsapi.com (free tier available) and set BETSAPI_TOKEN.
  betsapiToken: process.env.BETSAPI_TOKEN || "",
  betsapiHost: process.env.BETSAPI_HOST || "https://api.b365api.com",

  // --- Polymarket global (polymarket.com) credentials ---
  // Your wallet private key (exported from Polymarket: profile -> settings -> export private key)
  polymarketPrivateKey: process.env.POLYMARKET_PRIVATE_KEY || "",
  // Your Polymarket wallet address (the address shown on your Polymarket profile that holds your USDC)
  polymarketFunderAddress: process.env.POLYMARKET_FUNDER_ADDRESS || "",
  // 0 = plain wallet (EOA), 1 = Polymarket account created with email/Magic, 2 = Polymarket account created with a browser wallet (MetaMask etc.)
  polymarketSignatureType: process.env.POLYMARKET_SIGNATURE_TYPE !== undefined && process.env.POLYMARKET_SIGNATURE_TYPE !== ""
    ? Number(process.env.POLYMARKET_SIGNATURE_TYPE)
    : (process.env.POLYMARKET_FUNDER_ADDRESS ? 1 : 0),

  // --- App ---
  // Optional password protecting the web UI/API. Strongly recommended if you deploy this anywhere public.
  appPassword: process.env.APP_PASSWORD || "",
  dataDir: process.env.DATA_DIR || new URL("../data/", import.meta.url).pathname,

  // Safety limits the assistant/rules engine will refuse to cross.
  maxOrderSizeShares: Number(process.env.MAX_ORDER_SIZE_SHARES || 10000),
  maxOrderCostUsd: Number(process.env.MAX_ORDER_COST_USD || 1000),

  // Rules engine tuning. Reposts are throttled only enough to respect exchange
  // rate limits; fills arrive via the private stream so reconcile is a backstop.
  minRepostIntervalMs: Number(process.env.MIN_REPOST_INTERVAL_MS || 300),
  reconcileIntervalMs: Number(process.env.RECONCILE_INTERVAL_MS || 10000),

  dryRun: bool(process.env.DRY_RUN, false),
};

export const CLOB_HOST = "https://clob.polymarket.com";
export const CLOB_WS_HOST = "wss://ws-subscriptions-clob.polymarket.com/ws";
export const GAMMA_HOST = "https://gamma-api.polymarket.com";
export const DATA_API_HOST = "https://data-api.polymarket.com";
export const CHAIN_ID = 137; // Polygon
