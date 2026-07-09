# 📈 Polymarket Trading Assistant

Your personal Polymarket trading chatbot. Tell it what to do in plain English and it does it — including standing instructions it enforces around the clock:

> "Buy 200 shares of YES at 10¢ on the Fed rate cut market. If anyone outbids me, outbid them instantly — but never pay more than 20¢."

The chat is powered by Claude. The outbidding is **not** — it runs in a background engine wired directly into Polymarket's real-time order feed, so it reacts in milliseconds and keeps working for hours or days, even while you sleep.

## What it can do

- 🔎 Search Polymarket markets and read live order books
- 🛒 Place and cancel limit orders (buy/sell)
- 🤖 **Auto-outbid rules**: keep your bid on top of the book up to a hard price cap, 24/7
- 💼 Show your open orders, positions, P&L, and USDC balance
- 📜 Keep an activity log of everything the engine did while you were away
- 🔒 Built-in safety rails: per-order size and dollar caps, optional dry-run mode, password-protected UI

## Setup (10 minutes, no coding needed)

You need [Node.js](https://nodejs.org) 20+ installed (or use the Docker/Railway options below).

**1. Get the code and install:**

```bash
cd trading-assistant
npm install
```

**2. Create your settings file:**

```bash
cp .env.example .env
```

Open `.env` in any text editor and fill in:

| Setting | Where to get it |
|---|---|
| `ANTHROPIC_API_KEY` | [platform.claude.com](https://platform.claude.com) → API keys. Powers the chat. |
| `POLYMARKET_PRIVATE_KEY` | Polymarket site → your profile picture → **Settings** → **Export Private Key** |
| `POLYMARKET_FUNDER_ADDRESS` | The `0x...` wallet address shown on your Polymarket profile |
| `POLYMARKET_SIGNATURE_TYPE` | `1` if you signed up with email (most people), `2` if you signed up with MetaMask |
| `APP_PASSWORD` | Make one up. Required if you host this online. |

> ⚠️ Your private key controls your funds. It only ever lives in your `.env` file on your own machine/server and is used to sign orders locally. Never share it or commit it anywhere.

**3. Do a safe first run (simulated orders):**

Set `DRY_RUN=true` in `.env`, then:

```bash
npm start
```

Open http://localhost:3000, enter your app password, and try:
*"find the market about the next Fed rate decision"* → *"bid 10c for 50 shares of NO, outbid anyone up to 15c"*.
In dry-run mode it goes through all the motions without sending real orders.

**4. Go live:** set `DRY_RUN=false` and restart.

## Running it for days at a time

The app is a single always-on process. Options, easiest first:

**Railway / Render (recommended if you're not technical).** Push this folder to a GitHub repo, create a new project on [railway.app](https://railway.app) or [render.com](https://render.com) from that repo (both auto-detect the Dockerfile), and add your `.env` values as environment variables in their dashboard. You'll get a private URL you can open from your phone. Make sure `APP_PASSWORD` is set!

**Docker anywhere:**

```bash
docker build -t pm-assistant .
docker run -d --restart=always --env-file .env -p 3000:3000 -v pm_data:/app/data pm-assistant
```

**Plain Node on a VPS / spare computer:**

```bash
npm install -g pm2
pm2 start src/index.js --name polymarket-assistant
pm2 save && pm2 startup   # auto-restart on reboot
```

The engine's rules and history are saved to `data/state.json`, so restarts pick up exactly where it left off (it re-checks your orders on boot).

## How the auto-outbid works (and its limits)

1. You tell the chat your instruction; it creates a **rule** and places your starting bid.
2. The engine subscribes to Polymarket's live market WebSocket for that market.
3. The moment the best bid rises above yours, it cancels your order and re-bids **one tick above the competitor** — capped at your max price. A small throttle (~1.2s between reposts) avoids rate-limit trouble during bidding wars.
4. If the competition goes past your cap, it stops, keeps your last bid resting, and logs a warning — tell the chat a new cap to keep competing.
5. When your order fills, the rule completes and it's logged. Ask the chat *"what happened overnight?"* any time.

Honest limitations:
- If your bid and a competitor's are at the **same price**, the book can't tell you who's first in queue — the engine only reacts when someone bids strictly higher.
- Reposting cancels and re-places your order, so you lose time priority at the old price (unavoidable — that's how order books work).
- If the app is offline, rules aren't enforced (your last resting order stays on Polymarket though). Host it somewhere always-on.

## Safety rails

- `MAX_ORDER_SIZE_SHARES` / `MAX_ORDER_COST_USD` in `.env` are hard caps the assistant cannot cross.
- `DRY_RUN=true` simulates everything.
- The UI/API is password-protected when `APP_PASSWORD` is set.
- This bot trades real money on your account. Start small.

## Project layout

```
trading-assistant/
├── src/
│   ├── index.js       # web server + wiring
│   ├── agent.js       # Claude chatbot + its trading tools
│   ├── rules.js       # always-on rules engine (auto-outbid)
│   ├── polymarket.js  # Polymarket REST + WebSocket client
│   ├── store.js       # saves rules/history to data/state.json
│   └── config.js
├── public/index.html  # the chat UI
└── Dockerfile
```
