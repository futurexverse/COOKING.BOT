import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, "..", "..");
const SNIPED_FILE = join(ROOT_DIR, "data", "sniped_tokens.json");

let snipedTokens: string[] = [];

function loadSniped(): void {
  try {
    if (existsSync(SNIPED_FILE)) {
      snipedTokens = JSON.parse(readFileSync(SNIPED_FILE, "utf-8"));
    }
  } catch {}
}

function saveSniped(): void {
  const dir = dirname(SNIPED_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(SNIPED_FILE, JSON.stringify(snipedTokens, null, 2));
}

function isAlreadySniped(address: string): boolean {
  return snipedTokens.includes(address.toLowerCase());
}

function markAsSniped(address: string): void {
  snipedTokens.push(address.toLowerCase());
  saveSniped();
}

interface SnipeCandidate {
  symbol: string;
  name: string;
  address: string;
  score: number;
  volume_24h: number;
  liquidity: number;
  holders: number;
  price?: number;
  change_24h?: number;
}

export async function scanForSnipes(): Promise<SnipeCandidate[]> {
  console.log("[SnipeScanner] Scanning for snipe opportunities on Robinhood Chain...");

  try {
    // Fetch trending tokens from Dexscreener
    const resp = await fetch("https://api.dexscreener.com/token-boosts/top/v1");
    if (!resp.ok) {
      console.error("[SnipeScanner] Dexscreener API error:", resp.status);
      return [];
    }

    const data = await resp.json() as Array<{
      chainId: string;
      tokenAddress: string;
      icon?: string;
      description?: string;
      links?: unknown[];
    }>;

    // Filter for Robinhood Chain only (chain ID 4663)
    const robinhoodTokens = data.filter(t => t.chainId === "robinhoodchain" || t.chainId === "robinhood");
    console.log(`[SnipeScanner] Found ${robinhoodTokens.length} Robinhood Chain tokens in trending`);

    const candidates: SnipeCandidate[] = [];

    for (const token of robinhoodTokens.slice(0, 20)) {
      if (isAlreadySniped(token.tokenAddress)) {
        continue;
      }

      try {
        // Get token details from Dexscreener
        const detailResp = await fetch(`https://api.dexscreener.com/tokens/v1/robinhood/${token.tokenAddress}`);
        if (!detailResp.ok) continue;

        const details = await detailResp.json() as Array<{
          baseToken: { address: string; name: string; symbol: string };
          priceUsd?: string;
          priceChange?: { h24?: number };
          volume?: { h24?: number };
          liquidity?: { usd?: number };
          pairAddress: string;
        }>;

        if (!details || details.length === 0) continue;

        const pair = details[0];
        const volume24h = pair.volume?.h24 || 0;
        const liquidity = pair.liquidity?.usd || 0;
        const priceUsd = pair.priceUsd ? parseFloat(pair.priceUsd) : 0;
        const change24h = pair.priceChange?.h24 || 0;

        // Basic scoring
        let score = 0;

        // Volume score (0-25)
        if (volume24h > 100000) score += 25;
        else if (volume24h > 50000) score += 20;
        else if (volume24h > 10000) score += 15;
        else if (volume24h > 5000) score += 10;

        // Liquidity score (0-25)
        if (liquidity > 100000) score += 25;
        else if (liquidity > 50000) score += 20;
        else if (liquidity > 10000) score += 15;
        else if (liquidity > 5000) score += 10;

        // Momentum score (0-25)
        if (change24h > 20) score += 25;
        else if (change24h > 10) score += 20;
        else if (change24h > 0) score += 15;
        else if (change24h > -10) score += 10;

        // Safety: minimum liquidity threshold
        if (liquidity < 10000) {
          console.log(`[SnipeScanner] Skipping ${pair.baseToken.symbol} - liquidity too low ($${liquidity})`);
          continue;
        }

        candidates.push({
          symbol: pair.baseToken.symbol,
          name: pair.baseToken.name,
          address: pair.baseToken.address,
          score,
          volume_24h: volume24h,
          liquidity,
          holders: 0,
          price: priceUsd,
          change_24h: change24h,
        });

        console.log(`[SnipeScanner] Found: ${pair.baseToken.symbol} | Score: ${score}% | Liq: $${liquidity} | Vol: $${volume24h}`);

      } catch (err) {
        console.error(`[SnipeScanner] Error processing ${token.tokenAddress}:`, err);
      }
    }

    // Sort by score descending
    candidates.sort((a, b) => b.score - a.score);

    return candidates.filter(c => c.score >= 70);

  } catch (err) {
    console.error("[SnipeScanner] Scan error:", err);
    return [];
  }
}

export async function runSnipeScanAndAlert(): Promise<void> {
  const candidates = await scanForSnipes();

  if (candidates.length === 0) {
    console.log("[SnipeScanner] No snipe opportunities found this cycle");
    return;
  }

  const { sendSnipeAlertToTelegram } = await import("../social/telegram-bot.js");

  for (const candidate of candidates.slice(0, 3)) {
    console.log(`[SnipeScanner] Alerting for: ${candidate.symbol} (score: ${candidate.score}%)`);
    await sendSnipeAlertToTelegram(candidate);
    markAsSniped(candidate.address);
  }
}

loadSniped();
