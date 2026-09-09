const GROQ_BASE = "https://api.groq.com/openai/v1";

function getApiKey(): string {
  return process.env.GROQ_API_KEY || "";
}

function getModel(): string {
  return "qwen/qwen3.8-27b";
}

export interface NarrativeToken {
  symbol: string;
  address: string;
  chain: string;
  market_cap: number;
  volume_24h: number;
  change_24h: number;
  dexscreener_url: string;
}

export interface NarrativeAnalysis {
  trending_narratives: string[];
  theme_scores: Record<string, number>;
  tokens_per_narrative: Record<string, NarrativeToken[]>;
  reasoning: string;
  raw_response?: string;
}

const SYSTEM_PROMPT = `You are COOKING, an AI mid-cap token analyst. You analyze trending MID-CAP tokens across multiple blockchains to identify the hottest narratives for GROWTH opportunities.

You will receive a list of trending tokens with their symbols, names, addresses, chains, volume, market cap, holders, and 24h price change. ALL tokens are already filtered to mid-cap range ($100K-$10M market cap).

Your job: Identify the TOP 5 trending narratives (themes, memes, sectors) that are HOT RIGHT NOW for mid-cap growth.

CRITICAL RULES:
1. MID-CAP FOCUS: These are growth coins — not established giants. Focus on momentum and breakout potential.
2. DIVERSITY: Each narrative must be DISTINCT. No overlapping themes. If you pick "AI agents", don't also pick "AI tokens" or "AI companions".
3. TOKEN EXAMPLES: For each narrative, pick the TOP 2-3 tokens that represent that theme. Include their EXACT contract addresses and chain.
4. NO REPETITION: Do not repeat themes from cycle to cycle. Vary between: memes, DeFi, RWA, gaming, infrastructure, SocialFi, political, animals, culture.
5. GROWTH SIGNAL: Prioritize tokens with volume spikes, holder growth, and positive price action.

Return a JSON object with:
- trending_narratives: array of exactly 5 DISTINCT narrative names (e.g., ["AI agents", "PolitiFi", "Cat coins", "RWA tokenization", "DePIN"])
- theme_scores: object mapping each narrative to a HOTNESS score 0-100 (100 = extremely hot momentum; 0 = dead). Score 80+ for tokens with strong volume/price action.
- tokens_per_narrative: object mapping each narrative to an array of 2-3 tokens. Each token must have:
  - symbol: token symbol
  - address: EXACT contract address from the data
  - chain: blockchain name
  - market_cap: market cap number
  - volume_24h: 24h volume
  - change_24h: 24h price change percentage
  - dexscreener_url: "https://dexscreener.com/{chain}/{address}"
- reasoning: 2-3 sentences explaining WHY these narratives are hot. Reference specific tokens and their metrics.

EXAMPLE FORMAT:
{
  "trending_narratives": ["AI agents", "PolitiFi", "Cat coins", "RWA tokenization", "DePIN"],
  "theme_scores": {"AI agents": 85, "PolitiFi": 72, "Cat coins": 68, "RWA tokenization": 55, "DePIN": 48},
  "tokens_per_narrative": {
    "AI agents": [
      {"symbol": "AIBOT", "address": "0x123...", "chain": "solana", "market_cap": 2500000, "volume_24h": 500000, "change_24h": 15.2, "dexscreener_url": "https://dexscreener.com/solana/0x123..."}
    ]
  },
  "reasoning": "AI agents are surging with AIBOT leading at $2.5M MC and 15% gains..."
}

IMPORTANT: Return ONLY valid JSON, no markdown, no code blocks, no extra text.`;

export async function analyzeNarrative(
  tokenData: Array<{ symbol: string; name?: string; address?: string; chain?: string; volume_24h?: number; market_cap?: number; holders?: number; change_24h?: number }>
): Promise<NarrativeAnalysis> {
  const apiKey = getApiKey();
  if (!apiKey) {
    console.log("[Groq] No API key, using fallback analysis");
    return fallbackAnalysis();
  }

  console.log(`[Groq] Using key: ${apiKey.substring(0, 7)}...${apiKey.substring(apiKey.length - 4)}`);

  const tokenSummary = tokenData.slice(0, 30).map((t) => ({
    symbol: t.symbol,
    name: t.name || "",
    address: t.address || "",
    chain: t.chain || "unknown",
    vol: t.volume_24h || 0,
    mc: t.market_cap || 0,
    holders: t.holders || 0,
    change_24h: t.change_24h || 0,
  }));

  const userMessage = `Analyze these MID-CAP trending tokens ($100K-$10M market cap) and identify the HOTTEST narratives:

${JSON.stringify(tokenSummary, null, 2)}

What are the top 5 diverse narratives RIGHT NOW? For each narrative, pick 2-3 representative tokens with their exact addresses.`;

  try {
    const url = `${GROQ_BASE}/chat/completions`;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: getModel(),
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
        temperature: 0.4,
        max_tokens: 1500,
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(25000),
    });

    if (!resp.ok) {
      const err = await resp.text();
      console.error(`[Groq] API error ${resp.status}:`, err);
      return fallbackAnalysis();
    }

    const data = (await resp.json()) as {
      choices: Array<{ message: { content: string } }>;
    };

    const text = data.choices?.[0]?.message?.content || "";
    console.log(`[Groq] Raw response: ${text.substring(0, 500)}`);

    const parsed = JSON.parse(text) as NarrativeAnalysis;

    // Build dexscreener URLs for any tokens missing them
    const tokensPerNarrative = parsed.tokens_per_narrative || {};
    for (const [narrative, tokens] of Object.entries(tokensPerNarrative)) {
      tokensPerNarrative[narrative] = tokens.map(t => ({
        ...t,
        dexscreener_url: t.dexscreener_url || `https://dexscreener.com/${t.chain}/${t.address}`,
      }));
    }

    const result: NarrativeAnalysis = {
      trending_narratives: (parsed.trending_narratives || []).slice(0, 5),
      theme_scores: parsed.theme_scores || {},
      tokens_per_narrative: tokensPerNarrative,
      reasoning: parsed.reasoning || "Analysis complete.",
      raw_response: text,
    };

    console.log(`[Groq] Narratives: ${result.trending_narratives.join(", ")}`);
    console.log(`[Groq] Scores: ${JSON.stringify(result.theme_scores)}`);
    for (const [narrative, tokens] of Object.entries(result.tokens_per_narrative)) {
      console.log(`[Groq] ${narrative}: ${tokens.map(t => t.symbol).join(", ")}`);
    }
    console.log(`[Groq] Reasoning: ${result.reasoning}`);

    return result;
  } catch (err) {
    console.error("[Groq] narrative analysis failed:", err);
    return fallbackAnalysis();
  }
}

function fallbackAnalysis(): NarrativeAnalysis {
  return {
    trending_narratives: ["AI agents", "PolitiFi", "Cat coins", "RWA tokenization", "DePIN"],
    theme_scores: { "AI agents": 75, "PolitiFi": 65, "Cat coins": 60, "RWA tokenization": 50, "DePIN": 45 },
    tokens_per_narrative: {},
    reasoning: "Default analysis — connect Groq API key for live narrative detection.",
  };
}
