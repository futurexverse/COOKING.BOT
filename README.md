# oracle-engine

Docker-first TypeScript Node.js service for deployment on Coolify. Signal detection for **Solana memecoins** (Pump.fun, Bonk, main launchpads) with AI-driven persona generation. Data from Jupiter or Dexscreener.

## Features
- **Fastify** framework for high performance.
- **OpenAI Responses API** for JSON-enforced persona generation.
- **Solana-only**: Trending tokens from Jupiter or Dexscreener (Pump.fun, Bonk, launchpads).
- **Signal Scoring**: Weighted algorithms for token detection.
- **Deduplication**: 24h tweet dedupe and reply-once-per-tweet state persisted in `data/` (survives restarts); 10m anchor cooldown and diversity (avoid repeating same symbol in last 2 posts).
- **Dockerized**: Multistage builds for optimized production images.

## Setup

1. Copy `.env.example` to `.env` and set required vars (see that file for all options). Never commit `.env` or put API keys in the repo; use the env example as a template only.
2. Run locally:
   ```bash
   npm install
   npm run dev
   ```
3. Run with Docker:
   ```bash
   docker-compose up --build
   ```

## API usage Examples

### Health Check
```bash
curl http://localhost:3000/health
```

### Scan Signals
```bash
curl -X POST http://localhost:3000/api/scan \
  -H "Content-Type: application/json" \
  -d '{
    "solana_trending": [
      { "symbol": "PEPE", "change_24h": 12, "volume_24h": 500000, "liquidity": 100000 }
    ],
    "oracle_memory_last3": ["prices shifting", "market eyes open"],
    "mode": "aggressive",
    "endingStyle": "paranoid",
    "intensitySpike": true
  }'
```

### Test Tweet Generation
```bash
curl -X POST http://localhost:3000/api/test/tweet \
  -H "Content-Type: application/json" \
  -d '{
    "signal": {
      "type": "solana",
      "symbol": "SOL",
      "change_24h": 15.5,
      "volume_24h": 2000000
    },
    "oracle_memory_last3": []
  }'
```

## Standalone bot

Run the bot (fetches Solana trending, runs scan, posts to X on an interval):

```bash
npm run start:bot
```

Requires in `.env`: `OPENAI_API_KEY`, X OAuth keys (`X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET`). Optional: `ORACLE_TRENDING_SOURCE=jupiter` (default), `dexscreener`, or `pumpfun`; `ORACLE_SCAN_INTERVAL_SECONDS=900`; `JUPITER_API_KEY` for higher rate limits. State is stored in `data/` (`bot_state.json`, `reply_state.json`, `dedupe_state.json`, `oracle_state.json`). **In Docker/Coolify:** set `ORACLE_DATA_DIR` to a mounted volume path (e.g. `/data`) so state persists across restarts; otherwise the bot can re-reply to the same mentions after each restart.

For bot-only Docker deployments (no HTTP API), build with: `docker build --target bot -t oracle-bot .` then run the container; the image runs `node dist/bot/index.js` and has no HEALTHCHECK (no server).

## n8n Integration (optional)

You can drive scans from n8n instead of the standalone bot:

- **Cron node**: Triggers every X minutes.
- **HTTP Request nodes**: Fetch Solana trending tokens (e.g. from Jupiter or Dexscreener), then pass them into `/api/scan`. Send a **diverse** `solana_trending` list; the engine scores all and picks the best.
- **Function node (memory)**: Build `oracle_memory_last3` from your recent posted tweets (e.g. last 10).
- **HTTP Request node (Oracle Engine)**: `POST` to `http://<oracle-engine-host>/api/scan` with body: `solana_trending`, `oracle_memory_last3`, `mode`, `endingStyle`, `intensitySpike`, and optionally `token_mentions` (record of symbol → mention count) for ticker diversity.
- **IF node**: Check `should_post === true`; when true, post `tweet_text` to X.

Oracle Engine prefers actionable Solana signals (scoring + cooldowns). When there is no actionable signal, it may emit fallback content (`market_pulse`, `watchlist`, etc.) and refuses to post if the tweet is too similar to recent ones.
