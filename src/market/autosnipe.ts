import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, "..", "..");
const SETTINGS_FILE = join(ROOT_DIR, "data", "autosnipe.json");
const ALERTED_TOKENS_FILE = join(ROOT_DIR, "data", "autosnipe_alerted.json");
const MIGRATIONS_FILE = join(ROOT_DIR, "data", "migrations.json");

export interface AutoSnipeSettings {
  enabled: boolean;
  minMarketCap: number;
  maxMarketCap: number;
  minVolume5m: number;
  minLiquidity: number;
  minHolders: number;
  minBuyPressure: number;
  minPriceChange5m: number;
  chains: string[];
  maxAlertsPerCycle: number;
}

const DEFAULT_SETTINGS: AutoSnipeSettings = {
  enabled: false,
  minMarketCap: 10000,
  maxMarketCap: 500000,
  minVolume5m: 1500,
  minLiquidity: 5000,
  minHolders: 20,
  minBuyPressure: 55,
  minPriceChange5m: 0,
  chains: ["robinhood", "solana"],
  maxAlertsPerCycle: 3,
};

interface AlertedTokens {
  [chatId: string]: string[];
}

function loadSettings(): Record<string, AutoSnipeSettings> {
  try {
    if (existsSync(SETTINGS_FILE)) {
      return JSON.parse(readFileSync(SETTINGS_FILE, "utf-8"));
    }
  } catch {}
  return {};
}

function saveSettings(settings: Record<string, AutoSnipeSettings>): void {
  const dir = dirname(SETTINGS_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

function loadAlertedTokens(): AlertedTokens {
  try {
    if (existsSync(ALERTED_TOKENS_FILE)) {
      return JSON.parse(readFileSync(ALERTED_TOKENS_FILE, "utf-8"));
    }
  } catch {}
  return {};
}

function saveAlertedTokens(data: AlertedTokens): void {
  const dir = dirname(ALERTED_TOKENS_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(ALERTED_TOKENS_FILE, JSON.stringify(data, null, 2));
}

export function getAutoSnipeSettings(chatId: number): AutoSnipeSettings {
  const all = loadSettings();
  return all[String(chatId)] || { ...DEFAULT_SETTINGS };
}

export function setAutoSnipeSettings(chatId: number, settings: AutoSnipeSettings): void {
  const all = loadSettings();
  all[String(chatId)] = settings;
  saveSettings(all);
}

export function toggleAutoSnipe(chatId: number): boolean {
  const all = loadSettings();
  const current = all[String(chatId)] || { ...DEFAULT_SETTINGS };
  current.enabled = !current.enabled;
  all[String(chatId)] = current;
  saveSettings(all);
  return current.enabled;
}

export function getEnabledAutoSnipeChatIds(): string[] {
  const all = loadSettings();
  return Object.entries(all)
    .filter(([_, s]) => s.enabled)
    .map(([chatId]) => chatId);
}

export interface AutoSnipeCandidate {
  symbol: string;
  name: string;
  address: string;
  chain: string;
  market_cap: number;
  volume_5m: number;
  volume_24h: number;
  liquidity: number;
  holders: number;
  price: number;
  change_5m: number;
  change_24h: number;
  buy_pressure: number;
  dexscreener_url: string;
}

export interface AutoSnipeMatch {
  chatId: string;
  token: AutoSnipeCandidate;
}

function passesSettings(token: AutoSnipeCandidate, settings: AutoSnipeSettings): boolean {
  if (!settings.enabled) return false;
  if (!settings.chains.includes(token.chain)) return false;
  if (token.market_cap < settings.minMarketCap || token.market_cap > settings.maxMarketCap) return false;
  if (token.volume_5m < settings.minVolume5m) return false;
  if (token.liquidity < settings.minLiquidity) return false;
  if (token.holders < settings.minHolders) return false;
  if (token.buy_pressure < settings.minBuyPressure) return false;
  if (token.change_5m < settings.minPriceChange5m) return false;
  return true;
}

export async function scanAutoSnipe(): Promise<AutoSnipeMatch[]> {
  const allSettings = loadSettings();
  const enabledUsers = Object.entries(allSettings).filter(([_, s]) => s.enabled);
  if (enabledUsers.length === 0) return [];

  const alerted = loadAlertedTokens();
  const matches: AutoSnipeMatch[] = [];

  try {
    const { fetchDexscreenerRobinhood } = await import("./sources/uniswap.js");
    const { fetchBirdeyeTrending } = await import("./sources/birdeye.js");
    const { fetchPumpFunTrending } = await import("./sources/pumpfun.js");
    const { fetchRaydiumTrending } = await import("./sources/raydium.js");

    const allTokens: AutoSnipeCandidate[] = [];

    // Fetch from all sources in parallel
    const [dexTokens, birdeyeTokens, pumpTokens, raydiumTokens] = await Promise.allSettled([
      fetchDexscreenerRobinhood(),
      Promise.all([
        fetchBirdeyeTrending("robinhood"),
        fetchBirdeyeTrending("solana"),
      ]).then(([a, b]) => [...a, ...b]),
      fetchPumpFunTrending(),
      fetchRaydiumTrending(),
    ]);

    if (dexTokens.status === "fulfilled") {
      for (const t of dexTokens.value) {
        if (t.chain !== "robinhood" && t.chain !== "solana") continue;
        const addr = t.mint || "";
        if (!addr) continue;
        allTokens.push({
          symbol: t.symbol,
          name: t.name || t.symbol,
          address: addr,
          chain: t.chain,
          market_cap: t.market_cap || 0,
          volume_5m: t.volume_1h ? Math.round(t.volume_1h / 12) : 0,
          volume_24h: t.volume_24h || 0,
          liquidity: t.liquidity || 0,
          holders: t.holders || 0,
          price: t.price || 0,
          change_5m: 0,
          change_24h: t.change_24h || 0,
          buy_pressure: 50,
          dexscreener_url: `https://dexscreener.com/${t.chain}/${addr}`,
        });
      }
    }

    if (birdeyeTokens.status === "fulfilled") {
      for (const t of birdeyeTokens.value) {
        if (t.chain !== "robinhood" && t.chain !== "solana") continue;
        const addr = t.mint || "";
        if (!addr) continue;
        allTokens.push({
          symbol: t.symbol,
          name: t.name || t.symbol,
          address: addr,
          chain: t.chain,
          market_cap: t.market_cap || 0,
          volume_5m: t.volume_1h ? Math.round(t.volume_1h / 12) : 0,
          volume_24h: t.volume_24h || 0,
          liquidity: t.liquidity || 0,
          holders: t.holders || 0,
          price: t.price || 0,
          change_5m: t.change_1h || 0,
          change_24h: t.change_24h || 0,
          buy_pressure: 50,
          dexscreener_url: `https://dexscreener.com/${t.chain}/${addr}`,
        });
      }
    }

    if (pumpTokens.status === "fulfilled") {
      for (const t of pumpTokens.value) {
        const addr = t.mint || "";
        if (!addr) continue;
        allTokens.push({
          symbol: t.symbol,
          name: t.name || t.symbol,
          address: addr,
          chain: "solana",
          market_cap: t.market_cap || 0,
          volume_5m: t.volume_1h ? Math.round(t.volume_1h / 12) : 0,
          volume_24h: t.volume_24h || 0,
          liquidity: t.liquidity || 0,
          holders: t.holders || 0,
          price: t.price || 0,
          change_5m: 0,
          change_24h: t.change_24h || 0,
          buy_pressure: 50,
          dexscreener_url: `https://dexscreener.com/solana/${addr}`,
        });
      }
    }

    if (raydiumTokens.status === "fulfilled") {
      for (const t of raydiumTokens.value) {
        const addr = t.mint || "";
        if (!addr) continue;
        allTokens.push({
          symbol: t.symbol,
          name: t.name || t.symbol,
          address: addr,
          chain: "solana",
          market_cap: t.market_cap || 0,
          volume_5m: t.volume_1h ? Math.round(t.volume_1h / 12) : 0,
          volume_24h: t.volume_24h || 0,
          liquidity: t.liquidity || 0,
          holders: t.holders || 0,
          price: t.price || 0,
          change_5m: 0,
          change_24h: t.change_24h || 0,
          buy_pressure: 50,
          dexscreener_url: `https://dexscreener.com/solana/${addr}`,
        });
      }
    }

    // Deduplicate by address
    const seen = new Set<string>();
    const unique = allTokens.filter((t) => {
      const key = `${t.chain}:${t.address}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Match against each user's settings
    for (const [chatId, settings] of enabledUsers) {
      const userAlerted = new Set(alerted[chatId] || []);
      let userAlertCount = 0;

      for (const token of unique) {
        if (userAlertCount >= settings.maxAlertsPerCycle) break;
        if (userAlerted.has(`${token.chain}:${token.address}`)) continue;
        if (!passesSettings(token, settings)) continue;

        matches.push({ chatId, token });
        userAlerted.add(`${token.chain}:${token.address}`);
        userAlertCount++;
      }

      alerted[chatId] = Array.from(userAlerted);
    }

    saveAlertedTokens(alerted);
  } catch (err) {
    console.error("[AutoSnipe] Scan error:", err);
  }

  return matches;
}

// Migration sniper state
interface MigrationState {
  seen: string[];
}

function loadMigrationState(): MigrationState {
  try {
    if (existsSync(MIGRATIONS_FILE)) {
      return JSON.parse(readFileSync(MIGRATIONS_FILE, "utf-8"));
    }
  } catch {}
  return { seen: [] };
}

function saveMigrationState(state: MigrationState): void {
  const dir = dirname(MIGRATIONS_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(MIGRATIONS_FILE, JSON.stringify(state, null, 2));
}

interface PumpFunMigrationCoin {
  name: string;
  symbol: string;
  mint: string;
  usd_market_cap: number;
  price: number;
  holder_count: number;
  complete: boolean;
  website: string;
  twitter: string;
  telegram: string;
}

async function fetchPumpFunMigrations(): Promise<PumpFunMigrationCoin[]> {
  const url = `https://frontend-api-v3.pump.fun/coins?sort=created_timestamp&order=DESC&limit=50&complete=true&includeNsfw=false`;
  const resp = await fetch(url, {
    headers: { "Content-Type": "application/json", "User-Agent": "COOKING-Agent/1.0" },
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) throw new Error(`PumpFun migrations ${resp.status}`);
  return (await resp.json()) as PumpFunMigrationCoin[];
}

export interface MigrationCandidate {
  symbol: string;
  name: string;
  address: string;
  market_cap: number;
  volume_24h: number;
  liquidity: number;
  holders: number;
  price: number;
  change_24h: number;
  dexscreener_url: string;
  source: string;
}

export async function scanMigrations(): Promise<MigrationCandidate[]> {
  const state = loadMigrationState();
  const newMigrations: MigrationCandidate[] = [];

  try {
    const coins = await fetchPumpFunMigrations();

    for (const coin of coins) {
      if (!coin.complete) continue;
      if (state.seen.includes(coin.mint)) continue;

      const mc = coin.usd_market_cap || 0;
      newMigrations.push({
        symbol: coin.symbol?.toUpperCase() || "?",
        name: coin.name || coin.symbol || "Unknown",
        address: coin.mint,
        market_cap: mc,
        volume_24h: mc * 0.3,
        liquidity: mc * 0.15,
        holders: coin.holder_count || 0,
        price: coin.price || 0,
        change_24h: 0,
        dexscreener_url: `https://dexscreener.com/solana/${coin.mint}`,
        source: "Pump.fun → Raydium",
      });

      state.seen.push(coin.mint);
    }

    if (state.seen.length > 500) {
      state.seen = state.seen.slice(-500);
    }

    saveMigrationState(state);
  } catch (err) {
    console.error("[MigrationSniper] Scan error:", err);
  }

  return newMigrations;
}
