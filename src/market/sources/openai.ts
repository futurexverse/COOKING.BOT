const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

function getApiKey(): string {
  return process.env.GOOGLE_AI_KEY || "";
}

function getModel(): string {
  return "gemini-2.0-flash";
}

export interface NarrativeAnalysis {
  trending_narratives: string[];
  theme_scores: Record<string, number>;
  reasoning: string;
  raw_response?: string;
}

const SYSTEM_PROMPT = `You are COOKING, an AI cross-chain meme coin analyst. You analyze trending tokens from multiple blockchains to identify the hottest narratives driving the current meme coin market.

You will receive a list of trending tokens with their symbols, names, chain, volume, market cap, holders, and 24h price change.

Your job: Identify the TOP 5 trending narratives (themes, memes, sectors) that are HOT right now.

Return a JSON object with:
- trending_narratives: array of exactly 5 narrative names ordered by热度 (e.g., ["AI agents", "PolitiFi", "Cat coins", "RWA tokenization", "DePIN"])
- theme_scores: object mapping each narrative to a HOTNESS score 0-100 (100 = extremely hot; 0 = dead). Be aggressive - score 80+ for truly trending, 30-50 for meh.
- reasoning: 2-3 sentences explaining WHY these narratives are hot. Reference specific tokens.

RULES:
1. Look for CLUSTERS - multiple tokens sharing a theme = that narrative is hot
2. High volume relative to market cap = momentum
3. Tokens with huge 24h gains indicate hot narratives
4. New chains gaining traction = emerging narrative
5. Be SPECIFIC (e.g., "cat coins" not just "animals")

Keep reasoning concise. Max 200 words.

IMPORTANT: Return ONLY valid JSON, no markdown, no code blocks, no extra text.`;

export async function analyzeNarrative(
  tokenData: Array<{ symbol: string; name?: string; chain?: string; volume_24h?: number; market_cap?: number; holders?: number; change_24h?: number }>
): Promise<NarrativeAnalysis> {
  const apiKey = getApiKey();
  if (!apiKey) {
    console.log("[Gemini] No API key, using fallback analysis");
    return fallbackAnalysis();
  }

  const tokenSummary = tokenData.slice(0, 20).map((t) => ({
    symbol: t.symbol,
    name: t.name || "",
    chain: t.chain || "unknown",
    vol: t.volume_24h || 0,
    mc: t.market_cap || 0,
    holders: t.holders || 0,
    change_24h: t.change_24h || 0,
  }));

  const userMessage = `Analyze these trending tokens across chains and identify the HOTTEST narratives:

${JSON.stringify(tokenSummary, null, 2)}

What are the top 5 trending narratives RIGHT NOW? Which themes have momentum?`;

  try {
    const url = `${GEMINI_BASE}/models/${getModel()}:generateContent?key=${apiKey}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ parts: [{ text: userMessage }] }],
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 600,
          responseMimeType: "application/json",
        },
      }),
      signal: AbortSignal.timeout(20000),
    });

    if (!resp.ok) {
      const err = await resp.text();
      console.error(`[Gemini] API error ${resp.status}:`, err);
      return fallbackAnalysis();
    }

    const data = (await resp.json()) as {
      candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
    };

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    console.log(`[Gemini] Raw response: ${text.substring(0, 300)}`);

    const parsed = JSON.parse(text) as NarrativeAnalysis;

    const result: NarrativeAnalysis = {
      trending_narratives: (parsed.trending_narratives || []).slice(0, 5),
      theme_scores: parsed.theme_scores || {},
      reasoning: parsed.reasoning || "Analysis complete.",
      raw_response: text,
    };

    console.log(`[Gemini] Narratives: ${result.trending_narratives.join(", ")}`);
    console.log(`[Gemini] Scores: ${JSON.stringify(result.theme_scores)}`);
    console.log(`[Gemini] Reasoning: ${result.reasoning}`);

    return result;
  } catch (err) {
    console.error("[Gemini] narrative analysis failed:", err);
    return fallbackAnalysis();
  }
}

function fallbackAnalysis(): NarrativeAnalysis {
  return {
    trending_narratives: ["AI agents", "PolitiFi", "Cat coins", "RWA tokenization", "DePIN"],
    theme_scores: { "AI agents": 75, "PolitiFi": 65, "Cat coins": 60, "RWA tokenization": 50, "DePIN": 45 },
    reasoning: "Default analysis — live data unavailable.",
  };
}
