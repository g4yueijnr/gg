import "dotenv/config";

function bool(v, def = false) {
  if (v === undefined || v === "") return def;
  return ["1", "true", "yes", "on"].includes(String(v).toLowerCase());
}

export const config = {
  port: Number(process.env.PORT || 3000),

  // --- OpenAI (the chatbot brain) ---
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  model: process.env.OPENAI_MODEL || "gpt-5.1",

  // --- Polymarket credentials ---
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

  // Rules engine tuning
  minRepostIntervalMs: Number(process.env.MIN_REPOST_INTERVAL_MS || 1200),
  reconcileIntervalMs: Number(process.env.RECONCILE_INTERVAL_MS || 15000),

  dryRun: bool(process.env.DRY_RUN, false),
};

export const CLOB_HOST = "https://clob.polymarket.com";
export const CLOB_WS_HOST = "wss://ws-subscriptions-clob.polymarket.com/ws";
export const GAMMA_HOST = "https://gamma-api.polymarket.com";
export const DATA_API_HOST = "https://data-api.polymarket.com";
export const CHAIN_ID = 137; // Polygon
