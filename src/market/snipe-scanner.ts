import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, "..", "..");
const SNIPED_TOKENS_FILE = join(ROOT_DIR, "data", "sniped_tokens.json");

function loadSnipedTokens(): string[] {
  try {
    if (existsSync(SNIPED_TOKENS_FILE)) {
      return JSON.parse(readFileSync(SNIPED_TOKENS_FILE, "utf-8"));
    }
  } catch {}
  return [];
}

function saveSnipedTokens(tokens: string[]): void {
  const dir = dirname(SNIPED_TOKENS_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(SNIPED_TOKENS_FILE, JSON.stringify(tokens.slice(-500), null, 2));
}

function isAlreadySniped(address: string): boolean {
  return loadSnipedTokens().includes(address);
}

function markAsSniped(address: string): void {
  const tokens = loadSnipedTokens();
  if (!tokens.includes(address)) {
    tokens.push(address);
    saveSnipedTokens(tokens);
  }
}

// Auto-snipe: scan and alert immediately — no fixed interval waiting
export async function runAutoSnipeScan(): Promise<void> {
  try {
    const { scanAutoSnipe } = await import("./autosnipe.js");
    const { sendAutoSnipeAlertToTelegram } = await import("../social/telegram-bot.js");

    const matches = await scanAutoSnipe();

    for (const match of matches) {
      if (isAlreadySniped(`${match.token.chain}:${match.token.address}`)) continue;

      await sendAutoSnipeAlertToTelegram({
        chatId: match.chatId,
        symbol: match.token.symbol,
        address: match.token.address,
        chain: match.token.chain,
        market_cap: match.token.market_cap,
        volume_5m: match.token.volume_5m,
        liquidity: match.token.liquidity,
        holders: match.token.holders,
        price: match.token.price,
        change_5m: match.token.change_5m,
        change_24h: match.token.change_24h,
        buy_pressure: match.token.buy_pressure,
        dexscreener_url: match.token.dexscreener_url,
      });

      markAsSniped(`${match.token.chain}:${match.token.address}`);
    }

    if (matches.length > 0) {
      console.log(`[AutoSnipe] Sent ${matches.length} alerts`);
    }
  } catch (err) {
    console.error("[AutoSnipe] Scan cycle error:", err);
  }
}

// Migration sniper: deliver one queued alert per cycle (spaced out, not a burst)
export async function runMigrationScan(): Promise<void> {
  try {
    const { scanMigrations, popNextMigration, getMigrationQueueLength } = await import("./autosnipe.js");
    const { sendMigrationAlertToTelegram } = await import("../social/telegram-bot.js");

    // Enqueue any new migrations found
    await scanMigrations();

    const queueLength = getMigrationQueueLength();
    if (queueLength === 0) return;

    // Send exactly ONE migration alert per cycle
    const migration = popNextMigration();
    if (!migration) return;

    const { fetchSolanaHolders } = await import("./autosnipe.js");
    if (migration.holders === null) {
      migration.holders = await fetchSolanaHolders(migration.address);
    }

    if (isAlreadySniped(`solana:${migration.address}`)) {
      console.log(`[MigrationSniper] ${migration.symbol} already sniped, skipping. ${queueLength - 1} remaining`);
      return;
    }

    await sendMigrationAlertToTelegram({
      symbol: migration.symbol,
      address: migration.address,
      market_cap: migration.market_cap,
      volume_24h: migration.volume_24h,
      liquidity: migration.liquidity,
      holders: migration.holders,
      price: migration.price,
      change_24h: migration.change_24h,
      dexscreener_url: migration.dexscreener_url,
      source: migration.source,
    });

    markAsSniped(`solana:${migration.address}`);
    console.log(`[MigrationSniper] Sent alert for $${migration.symbol}. ${queueLength - 1} still queued`);
  } catch (err) {
    console.error("[MigrationSniper] Scan cycle error:", err);
  }
}
