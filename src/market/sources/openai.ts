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

You will receive a list of trending tokens with their symbols, names, addresses, chains, volume, market cap, holders, and 24h price change. ALL tokens are already filtered to mid-cap range ($20K-$10M market cap).

Your job: Identify the TOP 5 trending narratives (themes, memes, sectors) that are HOT RIGHT NOW for mid-cap growth.

CRITICAL RULES:
1. MID-CAP FOCUS: These are growth coins — not established giants. Focus on momentum and breakout potential.
2. DIVERSITY: Each narrative must be DISTINCT. No overlapping themes. If you pick "AI agents", don't also pick "AI tokens" or "AI companions".
3. TOKEN EXAMPLES: For each narrative, pick the TOP 2-3 tokens that represent that theme. Use the EXACT contract addresses from the data provided.
4. NO REPETITION: Do not repeat themes. Vary between: memes, DeFi, RWA, gaming, infrastructure, SocialFi, political, animals, culture, L2, restaking.
5. GROWTH SIGNAL: Prioritize tokens with volume spikes, holder growth, and positive price action.
6. USE REAL DATA: Only use tokens from the provided list. Do not make up addresses.

Return a JSON object with this EXACT structure:
{
  "trending_narratives": ["narrative1", "narrative2", "narrative3", "narrative4", "narrative5"],
  "theme_scores": {"narrative1": 85, "narrative2": 72, "narrative3": 68, "narrative4": 55, "narrative5": 48},
  "tokens_per_narrative": {
    "narrative1": [
      {"symbol": "SYM1", "address": "0x...", "chain": "chain", "market_cap": 1234567, "volume_24h": 500000, "change_24h": 15.2, "dexscreener_url": "https://dexscreener.com/chain/0x..."},
      {"symbol": "SYM2", "address": "0x...", "chain": "chain", "market_cap": 2345678, "volume_24h": 300000, "change_24h": 8.1, "dexscreener_url": "https://dexscreener.com/chain/0x..."}
    ]
  },
  "reasoning": "2-3 sentences explaining why these narratives are hot. Reference specific tokens and metrics."
}

IMPORTANT: Return ONLY valid JSON. No markdown, no code blocks, no extra text.`;

function extractJsonFromText(text: string): Record<string, unknown> | null {
  // Try to find JSON in the text (might be wrapped in markdown code blocks)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    return JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }
}

export async function analyzeNarrative(
  tokenData: Array<{ symbol: string; name?: string; address?: string; chain?: string; volume_24h?: number; market_cap?: number; holders?: number; change_24h?: number }>,
  calledTokens: string[] = []
): Promise<NarrativeAnalysis> {
  const apiKey = getApiKey();
  if (!apiKey) {
    console.log("[Groq] No API key, using fallback analysis");
    return fallbackAnalysis();
  }

  console.log(`[Groq] Using key: ${apiKey.substring(0, 7)}...${apiKey.substring(apiKey.length - 4)}`);

  // Filter out already-called tokens
  const availableTokens = tokenData.filter(t => {
    const addr = (t.address || "").toLowerCase();
    return !calledTokens.includes(addr);
  });

  console.log(`[Groq] ${availableTokens.length} tokens available after filtering called tokens`);

  if (availableTokens.length < 5) {
    console.log("[Groq] Too few tokens after filtering, using all tokens");
  }

  const tokensForAnalysis = availableTokens.length >= 5 ? availableTokens : tokenData;

  const tokenSummary = tokensForAnalysis.slice(0, 15).map((t) => ({
    symbol: t.symbol,
    name: t.name || "",
    address: t.address || "",
    chain: t.chain || "unknown",
    vol: t.volume_24h || 0,
    mc: t.market_cap || 0,
    holders: t.holders || 0,
    change_24h: t.change_24h || 0,
  }));

  // Sort by volume for better analysis
  tokenSummary.sort((a, b) => b.vol - a.vol);

  const userMessage = `Analyze these MID-CAP trending tokens ($20K-$10M market cap) and identify the HOTTEST narratives for growth:

${JSON.stringify(tokenSummary, null, 2)}

What are the top 5 diverse narratives RIGHT NOW? For each narrative, pick 2-3 representative tokens with their exact addresses from the data above.`;

  try {
    const url = `${GROQ_BASE}/chat/completions`;
    const body = JSON.stringify({
      model: getModel(),
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
      temperature: 0.4,
        max_tokens: 700,
    });

    let resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body,
      signal: AbortSignal.timeout(30000),
    });

    // Retry once on 429 after 30s
    if (resp.status === 429) {
      console.log("[Groq] 429 rate limit, retrying in 30s...");
      await new Promise(r => setTimeout(r, 30000));
      resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body,
        signal: AbortSignal.timeout(30000),
      });
    }

    if (!resp.ok) {
      const err = await resp.text();
      console.error(`[Groq] API error ${resp.status}:`, err);
      return fallbackAnalysis();
    }

    const data = (await resp.json()) as {
      choices: Array<{ message: { content: string } }>;
    };

    const text = data.choices?.[0]?.message?.content || "";
    console.log(`[Groq] Raw response length: ${text.length}`);

    // Try to parse JSON from response
    let parsed = extractJsonFromText(text);

    if (!parsed) {
      console.error("[Groq] Failed to parse JSON from response");
      console.error(`[Groq] Response: ${text.substring(0, 500)}`);
      return fallbackAnalysis();
    }

    // Build dexscreener URLs and cross-reference market_cap from input data
    const tokensPerNarrative: Record<string, NarrativeToken[]> = {};
    const inputTokenMap = new Map<string, { market_cap: number; volume_24h: number; change_24h: number }>();
    for (const t of tokenSummary) {
      inputTokenMap.set(t.address.toLowerCase(), {
        market_cap: t.mc,
        volume_24h: t.vol,
        change_24h: t.change_24h,
      });
    }

    const rawTokensPerNarrative = (parsed as any).tokens_per_narrative || {};
    for (const [narrative, tokens] of Object.entries(rawTokensPerNarrative)) {
      if (!Array.isArray(tokens)) continue;
      tokensPerNarrative[narrative] = tokens.map((t: any) => {
        const addr = (t.address || "").toLowerCase();
        const inputData = inputTokenMap.get(addr);
        return {
          symbol: t.symbol || "?",
          address: t.address || "",
          chain: t.chain || "unknown",
          market_cap: inputData?.market_cap || t.market_cap || 0,
          volume_24h: inputData?.volume_24h || t.volume_24h || 0,
          change_24h: inputData?.change_24h || t.change_24h || 0,
          dexscreener_url: t.dexscreener_url || `https://dexscreener.com/${t.chain}/${t.address}`,
        };
      });
    }

    const result: NarrativeAnalysis = {
      trending_narratives: ((parsed as any).trending_narratives || []).slice(0, 5),
      theme_scores: (parsed as any).theme_scores || {},
      tokens_per_narrative: tokensPerNarrative,
      reasoning: (parsed as any).reasoning || "Analysis complete.",
      raw_response: text,
    };

    console.log(`[Groq] Narratives: ${result.trending_narratives.join(", ")}`);
    console.log(`[Groq] Scores: ${JSON.stringify(result.theme_scores)}`);
    for (const [narrative, tokens] of Object.entries(result.tokens_per_narrative)) {
      console.log(`[Groq] ${narrative}: ${tokens.map(t => `${t.symbol} (${t.address.slice(0, 8)}...) MC:$${t.market_cap}`).join(", ")}`);
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
