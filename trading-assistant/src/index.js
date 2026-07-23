import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "./config.js";
import { Store } from "./store.js";
import { Polymarket } from "./polymarket.js";
import { PolymarketUSClient } from "./polymarket-us.js";
import { RulesEngine } from "./rules.js";
import { PingPongEngine } from "./pingpong-engine.js";
import { ExternalScoreFeed } from "./scorefeed.js";
import { Agent } from "./agent.js";

const here = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  if (!config.anthropicApiKey) {
    console.warn("[app] ANTHROPIC_API_KEY is not set - the chat will not work until you add it to .env");
  }

  const store = new Store(config.dataDir);
  // A trading-mode choice made from the chat outlives restarts and beats the
  // DRY_RUN env var, so going live never requires touching hosting variables.
  if (typeof store.state.settings?.dryRun === "boolean") {
    config.dryRun = store.state.settings.dryRun;
  }
  // Polymarket US keys present -> US exchange; otherwise the global exchange.
  const useUS = !!(config.polymarketUsKeyId || config.polymarketUsSecret);
  const pm = useUS ? new PolymarketUSClient() : new Polymarket();
  console.log(`[app] platform: Polymarket ${useUS ? "US (regulated app)" : "global (polymarket.com)"}`);
  try {
    await pm.init();
  } catch (err) {
    console.error("[app] Polymarket init failed (continuing in read-only mode):", err.message);
  }

  // Live event fan-out to any open browser tabs.
  const sseClients = new Set();
  const notify = (entry) => {
    const line = `data: ${JSON.stringify(entry)}\n\n`;
    for (const res of sseClients) {
      try { res.write(line); } catch { sseClients.delete(res); }
    }
  };

  const rules = new RulesEngine({ polymarket: pm, store, notify });
  rules.start();
  const scoreFeed = new ExternalScoreFeed({});
  console.log(`[app] ping-pong score feed: ${scoreFeed.enabled() ? "BetsAPI (BETSAPI_TOKEN set)" : "none (set BETSAPI_TOKEN for live scores)"}`);
  const pingpong = new PingPongEngine({ polymarket: pm, store, notify, scoreFeed });
  pingpong.start();
  const agent = new Agent({ polymarket: pm, rules, store, pingpong });

  // Self-report health into the Activity feed so status is visible in the app
  // itself - no log-digging or manual testing needed.
  {
    const parts = [
      `platform: Polymarket ${useUS ? "US" : "global"}`,
      pm.readonly ? "trading: OFF (no exchange keys)" : "trading: ON",
      config.dryRun ? "DRY RUN (orders simulated)" : null,
      pm.apiOk === false ? `⚠ exchange API UNREACHABLE: ${pm.apiError || "unknown"}` : "exchange API: OK",
      config.anthropicApiKey ? "chat: OK" : "⚠ chat: ANTHROPIC_API_KEY missing",
      `${rules.activeRules().length} active rule(s) resumed`,
    ].filter(Boolean);
    store.addActivity("system", `App started - ${parts.join(" · ")}`, {
      level: (pm.apiOk === false || !config.anthropicApiKey) ? "warn" : "info",
    });
  }

  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // Optional password gate (Bearer token). Set APP_PASSWORD in .env to enable.
  app.use((req, res, next) => {
    if (!config.appPassword) return next();
    if (req.path === "/" || req.path.startsWith("/assets")) return next(); // UI shell is public; API is not
    const token = (req.headers.authorization || "").replace(/^Bearer /, "");
    if (token === config.appPassword) return next();
    if (req.query.token === config.appPassword) return next(); // browser-friendly (EventSource, /api/diag)
    res.status(401).json({ error: "unauthorized" });
  });

  app.use(express.static(path.join(here, "../public")));

  // --- chat (streams Server-Sent Events) ---
  app.post("/api/chat", async (req, res) => {
    const text = (req.body?.message || "").trim();
    if (!text) return res.status(400).json({ error: "message required" });
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    try {
      await agent.chat(text, send);
      send({ type: "done" });
    } catch (err) {
      console.error("[chat] error:", err);
      send({ type: "error", message: err.message });
    }
    res.end();
  });

  // --- state for the sidebar ---
  app.get("/api/state", async (req, res) => {
    let openOrders = [];
    if (!pm.readonly) {
      try { openOrders = await pm.getOpenOrders(); } catch { /* transient */ }
    }
    res.json({
      trading: !pm.readonly,
      dryRun: config.dryRun,
      platform: pm.platform,
      wallet: pm.funder,
      rules: rules.listRules().slice().reverse(),
      strategies: pingpong.listStrategies().slice().reverse(),
      openOrders,
      activity: store.state.activity.slice(-100).reverse(),
    });
  });

  // External live-score feed fallback: any score provider can POST the current
  // score here and the ping-pong engine trades on it exactly like the built-in
  // poller. Body: {gamesA,gamesB,ptsA,ptsB} or {whoScored:"A"|"B"}.
  app.post("/api/pingpong/:id/score", async (req, res) => {
    try {
      const s = await pingpong.updateScore(req.params.id, req.body || {});
      res.json({ ok: true, score: s?.score ?? null });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post("/api/pingpong/:id/stop", async (req, res) => {
    try { res.json(await pingpong.stopStrategy(req.params.id)); }
    catch (err) { res.status(400).json({ error: err.message }); }
  });

  // --- live activity stream ---
  app.get("/api/events", (req, res) => {
    // EventSource can't set headers; allow token via query param.
    if (config.appPassword && req.query.token !== config.appPassword) {
      return res.status(401).end();
    }
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.flushHeaders?.();
    res.write(`data: ${JSON.stringify({ kind: "hello" })}\n\n`);
    sseClients.add(res);
    const ping = setInterval(() => {
      try { res.write(": ping\n\n"); } catch { /* closed */ }
    }, 25000);
    req.on("close", () => {
      clearInterval(ping);
      sseClients.delete(res);
    });
  });

  app.post("/api/rules/:id/cancel", async (req, res) => {
    try {
      const rule = await rules.cancelRule(req.params.id);
      res.json(rule);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post("/api/chat/reset", (req, res) => {
    agent.resetHistory();
    res.json({ ok: true });
  });

  // Direct diagnostic: open /api/diag?q=<market text, link, or slug> in a browser
  // (append &token=<APP_PASSWORD> if a password is set).
  app.get("/api/diag", async (req, res) => {
    try {
      const q = String(req.query.q || "").trim() || "test";
      res.json(await pm.diagnose(q));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/health", (req, res) => {
    res.json({ ok: true, trading: !pm.readonly, activeRules: rules.activeRules().length });
  });

  const server = app.listen(config.port, () => {
    console.log(`\n  Polymarket assistant running at http://localhost:${config.port}`);
    console.log(`  Trading: ${pm.readonly ? "DISABLED (set POLYMARKET_PRIVATE_KEY)" : "enabled"}${config.dryRun ? " [DRY RUN]" : ""}\n`);
  });

  const shutdown = () => {
    console.log("\n[app] shutting down...");
    rules.stop();
    pm.stop();
    store.saveNow();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("unhandledRejection", (err) => console.error("[app] unhandled rejection:", err));
}

main().catch((err) => {
  console.error("[app] fatal:", err);
  process.exit(1);
});
