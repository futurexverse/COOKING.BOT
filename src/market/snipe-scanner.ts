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
  chain: string;
  score: number;
  volume_24h: number;
  liquidity: number;
  holders: number;
  price?: number;
  change_24h?: number;
}

async function fetchHolders(address: string, chain: string): Promise<number> {
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Accept": "application/json",
  };

  if (chain === "robinhood") {
    try {
      const resp = await fetch(
        `https://robinhoodchain.blockscout.com/api/v2/tokens/${address}`,
        { signal: AbortSignal.timeout(8000), headers }
      );
      if (resp.ok) {
        const data = await resp.json() as { holders_count?: number };
        return data.holders_count || 0;
      }
    } catch {}
  }

  if (chain === "solana") {
    try {
      const resp = await fetch(
        `https://public-api.solscan.io/token/holders?token=${address}&limit=1`,
        { signal: AbortSignal.timeout(8000), headers }
      );
      if (resp.ok) {
        const data = await resp.json() as { result?: { total?: number } };
        return data.result?.total || 0;
      }
    } catch {}
    // Fallback: try Dexscreener pair data for txns count as proxy
    try {
      const resp = await fetch(
        `https://api.dexscreener.com/latest/dex/tokens/${address}`,
        { signal: AbortSignal.timeout(8000) }
      );
      if (resp.ok) {
        const data = await resp.json() as { pairs?: Array<{ txns?: { h24?: { buys: number; sells: number } } }> };
        if (data.pairs && data.pairs.length > 0) {
          const txns = data.pairs[0].txns?.h24;
          if (txns) return txns.buys + txns.sells;
        }
      }
    } catch {}
  }

  return 0;
}

export async function scanForSnipes(): Promise<SnipeCandidate[]> {
  console.log("[SnipeScanner] Scanning for snipe opportunities...");

  const allCandidates: SnipeCandidate[] = [];

  // Source 1: Dexscreener boost list (Robinhood + Solana)
  try {
    const resp = await fetch("https://api.dexscreener.com/token-boosts/top/v1");
    if (resp.ok) {
      const data = await resp.json() as Array<{
        chainId: string;
        tokenAddress: string;
      }>;

      const targetTokens = data.filter(t =>
        t.chainId === "robinhood" || t.chainId === "solana"
      );
      console.log(`[SnipeScanner] Found ${targetTokens.length} Robinhood+Solana tokens in Dexscreener boost`);

      for (const token of targetTokens.slice(0, 20)) {
        if (isAlreadySniped(token.tokenAddress)) continue;

        try {
          const chain = token.chainId === "robinhood" ? "robinhood" : "solana";
          const detailResp = await fetch(
            `https://api.dexscreener.com/tokens/v1/${chain}/${token.tokenAddress}`
          );
          if (!detailResp.ok) continue;

          const details = await detailResp.json() as Array<{
            baseToken: { address: string; name: string; symbol: string };
            priceUsd?: string;
            priceChange?: { m5?: number; h1?: number; h24?: number };
            volume?: { m5?: number; h1?: number; h24?: number };
            liquidity?: { usd?: number };
            marketCap?: number;
            fdv?: number;
            pairAddress: string;
          }>;

          if (!details || details.length === 0) continue;

          const pair = details[0];
          const vol = pair.volume?.m5 || pair.volume?.h1 || pair.volume?.h24 || 0;
          const liquidity = pair.liquidity?.usd || 0;
          const mc = pair.marketCap || pair.fdv || 0;
          const priceUsd = pair.priceUsd ? parseFloat(pair.priceUsd) : 0;
          const change5m = pair.priceChange?.m5 || 0;

          if (vol < 1500 || liquidity < 5000) continue;
          if (mc > 500000 || (mc < 10000 && mc > 0) || mc === 0) continue;

          const holders = await fetchHolders(pair.baseToken.address, chain);

          let score = 0;
          if (vol > 50000) score += 25;
          else if (vol > 20000) score += 20;
          else if (vol > 5000) score += 15;
          else if (vol > 1500) score += 10;

          if (liquidity > 50000) score += 25;
          else if (liquidity > 20000) score += 20;
          else if (liquidity > 10000) score += 15;
          else if (liquidity > 5000) score += 10;

          if (change5m > 10) score += 25;
          else if (change5m > 5) score += 20;
          else if (change5m > 0) score += 15;
          else if (change5m > -5) score += 10;

          if (holders > 100) score += 15;
          else if (holders > 50) score += 10;
          else if (holders > 20) score += 5;

          if (score >= 70) {
            allCandidates.push({
              symbol: pair.baseToken.symbol,
              name: pair.baseToken.name,
              address: pair.baseToken.address,
              chain,
              score,
              volume_24h: vol,
              liquidity,
              holders,
              price: priceUsd,
              change_24h: change5m,
            });
          }

          console.log(`[SnipeScanner] ${pair.baseToken.symbol} | Score: ${score} | Liq: $${liquidity} | Vol: $${vol} | Holders: ${holders}`);
        } catch (err) {
          console.error(`[SnipeScanner] Error processing ${token.tokenAddress}:`, err);
        }
      }
    }
  } catch (err) {
    console.error("[SnipeScanner] Dexscreener boost scan error:", err);
  }

  // Source 2: GMGN Robinhood trending
  try {
    const { fetchGmgnTrending } = await import("./sources/gmgn.js");
    const gmgnTokens = await fetchGmgnTrending("robinhood", "5m", 20);

    for (const token of gmgnTokens) {
      if (!token.mint || isAlreadySniped(token.mint)) continue;

      const holders = token.holders || await fetchHolders(token.mint, "robinhood");

      let score = 0;
      const vol = token.volume_24h;
      if (vol > 50000) score += 25;
      else if (vol > 20000) score += 20;
      else if (vol > 5000) score += 15;
      else if (vol > 1500) score += 10;

      if (token.liquidity > 50000) score += 25;
      else if (token.liquidity > 20000) score += 20;
      else if (token.liquidity > 10000) score += 15;
      else if (token.liquidity > 5000) score += 10;

      if (token.change_24h > 10) score += 25;
      else if (token.change_24h > 5) score += 20;
      else if (token.change_24h > 0) score += 15;
      else if (token.change_24h > -5) score += 10;

      if (holders > 100) score += 15;
      else if (holders > 50) score += 10;
      else if (holders > 20) score += 5;

      if (score >= 70) {
        allCandidates.push({
          symbol: token.symbol,
          name: token.name || token.symbol,
          address: token.mint!,
          chain: "robinhood",
          score,
          volume_24h: vol,
          liquidity: token.liquidity,
          holders,
          price: token.price,
          change_24h: token.change_24h,
        });
      }
    }
  } catch (err) {
    console.error("[SnipeScanner] GMGN scan error:", err);
  }

  // Deduplicate by address
  const seen = new Set<string>();
  const unique: SnipeCandidate[] = [];
  for (const c of allCandidates) {
    const key = c.address.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(c);
    }
  }

  unique.sort((a, b) => b.score - a.score);
  return unique;
}

export async function runSnipeScanAndAlert(): Promise<void> {
  const candidates = await scanForSnipes();

  if (candidates.length === 0) {
    console.log("[SnipeScanner] No snipe opportunities found this cycle");
    return;
  }

  const { sendSnipeAlertToTelegram } = await import("../social/telegram-bot.js");

  for (const candidate of candidates.slice(0, 1)) {
    console.log(`[SnipeScanner] Alerting for: ${candidate.symbol} (score: ${candidate.score}%)`);
    await sendSnipeAlertToTelegram(candidate);
    markAsSniped(candidate.address);
  }
}

loadSniped();
