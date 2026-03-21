# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install dependencies
npm install

# Compile TypeScript to JavaScript (required before running)
npm run tsc

# Run the app (requires BINANCE_APIKEY, BINANCE_API_SECRET, APP_PORT env vars)
npm start

# Run in read-only mode (requires BINANCE_READONLY_APIKEY, BINANCE_READONLY_API_SECRET, APP_PORT env vars)
npm run start:readonly
```

After starting, open `http://localhost:5001/` in a browser.

There are no automated tests in this project.

## Architecture

This is a single-process Node.js app (`App.ts`) that serves a browser-based trading UI and bridges it to the Binance API via REST and WebSocket.

**Backend (`App.ts`)** — Express HTTP server + Socket.io server in one process:
- Serves `index.html` and static assets via `express.static`
- Opens two Binance connections at startup: `MainClient` (REST) for orders/balances, `WebsocketClient` for real-time price streams
- Subscribes to Binance aggregate trade WebSocket (`subscribeSpotAggregateTrades`) and 24hr mini ticker per symbol on startup, based on `tickerWatchlist` in `appData.json`
- Broadcasts price/trade/balance updates to all connected browser clients via Socket.io events

**Frontend (`index.html`)** — single HTML file with inline JavaScript, no build step:
- Fetches `appData.json` on load to get the ticker watchlist, then dynamically builds the main table
- Communicates exclusively with the backend via Socket.io (no direct Binance API calls from the browser)
- Uses Howler.js for sound effects on alerts and order fills

**Key source files:**
- `App.ts` — main entry point, all server-side logic
- `AppUtils.ts` — `OrderManager`, `OrderUtils`, `CoinUtils`, `Logger` utility classes
- `typeGuards.ts` — TypeScript type guards for discriminating Binance WebSocket message types
- `resources/appData.json` — ticker watchlist, account currency, total funding (for PnL calc)
- `resources/upAlerts.json` / `resources/downAlerts.json` — persisted price alerts (auto-written at runtime)

**Socket.io event contract** (frontend emits → backend handles):
- `prices:subscribe` — subscribe to a new ticker's price stream
- `balances:requestSingle` — request balance for a coin
- `orders:new-market-order` / `orders:new-limitbook-order` — place orders
- `orders:cancel-orders` — cancel all open orders for a ticker
- `alerts:new-alert` / `alerts:cancel-alerts` — manage price alerts

Backend emits to frontend: `prices:update`, `balances:singleTicker`, `tradeStats:update`, `tradeVolStats:update`, `24hrStats:update`, `orders:fill`.

**Ticker format convention:** The app uses `COIN/USDT` internally (e.g. `BTC/USDT`); `CoinUtils` converts to/from Binance's format (`BTCUSDT`) at the boundary.

**Limit orders** use "limit book" style: the backend fetches the current order book and places at the 3rd best bid/ask price rather than requiring the user to specify a price.

## Configuration

- `resources/appData.json`: set `tickerWatchlist` to control which symbols appear at startup; set `totalFunding` to your account's total deposited USD for accurate PnL display.
- TypeScript compiles in-place (no `outDir`), so `.js` and `.js.map` files are generated alongside `.ts` sources.
- API keys are passed as environment variables (`APIKEY`, `APISECRET`), never stored in the repo.
