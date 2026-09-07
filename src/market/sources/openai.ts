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
}

const SYSTEM_PROMPT = `You are COOKING, an AI Robinhood Chain token launch analyst. Analyze the provided token market data and social metrics to identify trending narratives (themes, memes, sectors) driving the current Robinhood Chain meme coin market.

Return a JSON object with:
- trending_narratives: array of narrative names (e.g., ["AI agents", "political memes", "cat coins", "tokenized stocks", "DePIN"])
- theme_scores: object mapping each narrative to a relevance score 0-100 (e.g., {"AI agents": 85, "cat coins": 60})
- reasoning: brief explanation of why these narratives are trending

Focus on:
- What themes are getting the most social attention and new token launches
- Which narratives have momentum (rising mentions, positive sentiment)
- Which narratives are fading

Keep it concise. Max 5 narratives.

IMPORTANT: Return ONLY valid JSON, no markdown, no code blocks.`;

export async function analyzeNarrative(
  pumpfunData: Array<{ symbol: string; name?: string; market_cap?: number; holder_count?: number; description?: string }>,
  lunacrushData: Array<{ symbol: string; name?: string; social_sentiment?: number; social_mentions?: number; volume_24h?: number }>
): Promise<NarrativeAnalysis> {
  const apiKey = getApiKey();
  if (!apiKey) {
    return fallbackAnalysis();
  }

  const tokenSummary = pumpfunData.slice(0, 10).map((t) => ({
    symbol: t.symbol,
    name: t.name || "",
    mc: t.market_cap || 0,
    holders: t.holder_count || 0,
  }));

  const socialSummary = lunacrushData.slice(0, 10).map((t) => ({
    symbol: t.symbol,
    name: t.name || "",
    mentions: t.social_mentions || 0,
    vol: t.volume_24h || 0,
  }));

  const userMessage = `Token data:\n${JSON.stringify(tokenSummary, null, 2)}\n\nSocial data:\n${JSON.stringify(socialSummary, null, 2)}\n\nIdentify the top trending narratives on Robinhood Chain.`;

  try {
    const url = `${GEMINI_BASE}/models/${getModel()}:generateContent?key=${apiKey}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ parts: [{ text: userMessage }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 500,
          responseMimeType: "application/json",
        },
      }),
      signal: AbortSignal.timeout(15000),
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
    const parsed = JSON.parse(text) as NarrativeAnalysis;

    return {
      trending_narratives: parsed.trending_narratives || [],
      theme_scores: parsed.theme_scores || {},
      reasoning: parsed.reasoning || "Analysis complete.",
    };
  } catch (err) {
    console.error("[Gemini] narrative analysis failed:", err);
    return fallbackAnalysis();
  }
}

function fallbackAnalysis(): NarrativeAnalysis {
  return {
    trending_narratives: ["AI agents", "tokenized stocks", "cat coins", "DePIN", "political memes"],
    theme_scores: { "AI agents": 60, "tokenized stocks": 55, "cat coins": 50, "DePIN": 40, "political memes": 35 },
    reasoning: "Analysis unavailable. Using default trending narratives.",
  };
}
