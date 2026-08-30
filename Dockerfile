# Stage 1: Build
FROM node:20-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

# Stage 2: Runtime (API server)
FROM node:20-slim AS api
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY --from=builder /app/dist ./dist
COPY index.html ./
COPY cooking-logo.png cooking-bg.png ./
COPY src/config/thresholds.json ./src/config/thresholds.json
RUN mkdir -p data

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "require('http').get('http://127.0.0.1:3000/health', (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => process.exit(r.statusCode === 200 ? 0 : 1)); }).on('error', () => process.exit(1))" || exit 1
CMD ["npm", "start"]

# Stage 3: Bot-only (no HTTP server). Build with: docker build --target bot -t cooking-bot .
FROM node:20-slim AS bot
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY --from=builder /app/dist ./dist
COPY src/config/thresholds.json ./src/config/thresholds.json
RUN mkdir -p data
CMD ["node", "dist/bot/index.js"]

# Default target: API server (same as stage 2)
FROM api
