# 📈 Polymarket Trading Assistant

Your personal Polymarket trading chatbot. Tell it what to do in plain English and it does it — including standing instructions it enforces around the clock:

> "Buy 200 shares of YES at 10¢ on the Fed rate cut market. If anyone outbids me, outbid them instantly — but never pay more than 20¢."

The chat is powered by OpenAI (GPT-5.1 by default). The outbidding is **not** — it runs in a background engine wired directly into Polymarket's real-time order feed, so it reacts in milliseconds and keeps working for hours or days, even while you sleep.

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

Open `.env` in any text editor and fill in `OPENAI_API_KEY` ([platform.openai.com/api-keys](https://platform.openai.com/api-keys) — powers the chat), `APP_PASSWORD` (make one up — required if you host online), and **one** of the two Polymarket setups:

**If you use the Polymarket US app (regulated US version):**

| Setting | Where to get it |
|---|---|
| `POLYMARKET_US_KEY_ID` | Verify your identity in the iOS app, then create an API key at [polymarket.us/developer](https://polymarket.us/developer) |
| `POLYMARKET_US_SECRET_KEY` | Shown once when you create the key — copy it immediately |

**If you use the original polymarket.com (non-US):**

| Setting | Where to get it |
|---|---|
| `POLYMARKET_PRIVATE_KEY` | Polymarket site → your profile picture → **Settings** → **Export Private Key** |
| `POLYMARKET_FUNDER_ADDRESS` | The `0x...` wallet address shown on your Polymarket profile |
| `POLYMARKET_SIGNATURE_TYPE` | `1` if you signed up with email (most people), `2` if you signed up with MetaMask |

The app picks the platform automatically from which keys you provide. Note the two platforms are separate exchanges with separate accounts and order books.

> ⚠️ These credentials control your funds. They only ever live in your `.env` file (or your host's encrypted variables) and are used to sign orders. Never share them or commit them anywhere.

**3. Do a safe first run (simulated orders):**

Set `DRY_RUN=true` in `.env`, then:

```bash
npm start
```

Open http://localhost:3000, enter your app password, and try:
*"find the market about the next Fed rate decision"* → *"bid 10c for 50 shares of NO, outbid anyone up to 15c"*.
In dry-run mode it goes through all the motions without sending real orders.

**4. Go live:** set `DRY_RUN=false` and restart.

## Running it 24/7 + using it from your phone

The app can't run *on* a phone (phones sleep). Instead it runs on an always-on cloud server, and your phone opens it like a website — the bot keeps bidding even when your phone is off. Full walkthrough with Railway (~$5/month, no coding):

1. **Get the code on GitHub** (it may already be there if this repo is yours). Railway deploys straight from a GitHub repo.
2. **Sign up at [railway.app](https://railway.app)** using your GitHub account.
3. Click **New Project → Deploy from GitHub repo** and pick this repository.
4. In the service's **Settings**:
   - **Root Directory** → `trading-assistant` (important — the app lives in this subfolder). Railway will auto-detect the Dockerfile.
   - Pick the branch that contains the app.
5. In the **Variables** tab, add your settings (same names as `.env`):
   `OPENAI_API_KEY`, `POLYMARKET_PRIVATE_KEY`, `POLYMARKET_FUNDER_ADDRESS`, `POLYMARKET_SIGNATURE_TYPE`, `APP_PASSWORD` — and set `DRY_RUN` to `true` for your first test.
6. **Add a volume** (right-click the service → Attach Volume) with mount path `/app/data`. This is where your rules and history are saved, so they survive restarts and updates.
7. In **Settings → Networking**, click **Generate Domain**. That URL is your app.
8. **On your phone:** open the URL in Safari/Chrome, enter your `APP_PASSWORD`, then use *Share → Add to Home Screen*. Now it looks and feels like an app.
9. Try it out in dry-run mode, then set `DRY_RUN` to `false` in Variables and redeploy. You're live.

[render.com](https://render.com) works the same way (use a paid instance — the free tier spins down when idle, which would pause your rules — and add a persistent disk at `/app/data`).

⚠️ Since this is on the internet, `APP_PASSWORD` is a must. Your Polymarket private key lives only in the hosting provider's encrypted environment variables.

Other options:

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
│   ├── agent.js       # OpenAI chatbot + its trading tools
│   ├── rules.js       # always-on rules engine (auto-outbid)
│   ├── polymarket.js  # Polymarket REST + WebSocket client
│   ├── store.js       # saves rules/history to data/state.json
│   └── config.js
├── public/index.html  # the chat UI
└── Dockerfile
```
