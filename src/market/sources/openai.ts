const OPENAI_BASE = "https://api.openai.com/v1";

function getApiKey(): string {
  return process.env.OPENAI_API_KEY || "";
}

function getModel(): string {
  return "gpt-5-nano";
}

export interface NarrativeAnalysis {
  trending_narratives: string[];
  theme_scores: Record<string, number>;
  reasoning: string;
}

const NARRATIVE_SCHEMA = {
  type: "object",
  properties: {
    trending_narratives: {
      type: "array",
      items: { type: "string" },
    },
    theme_scores: {
      type: "object",
      additionalProperties: { type: "number" },
    },
    reasoning: { type: "string" },
  },
  required: ["trending_narratives", "theme_scores", "reasoning"],
};

const SYSTEM_PROMPT = `You are COOKING, an AI Solana token launch analyst. Analyze the provided token market data and social metrics to identify trending narratives (themes, memes, sectors) driving the current Solana meme coin market.

Return a JSON object with:
- trending_narratives: array of narrative names (e.g., ["AI agents", "political memes", "cat coins", "Solana phone", "DePIN"])
- theme_scores: object mapping each narrative to a relevance score 0-100 (e.g., {"AI agents": 85, "cat coins": 60})
- reasoning: brief explanation of why these narratives are trending

Focus on:
- What themes are getting the most social attention and new token launches
- Which narratives have momentum (rising mentions, positive sentiment)
- Which narratives are fading

Keep it concise. Max 5 narratives.`;

export async function analyzeNarrative(
  pumpfunData: Array<{ symbol: string; name: string; market_cap: number; holder_count: number; description: string }>,
  lunacrushData: Array<{ symbol: string; name: string; social_sentiment: number; social_mentions: number; volume_24h: number }>
): Promise<NarrativeAnalysis> {
  const apiKey = getApiKey();
  if (!apiKey) {
    return {
      trending_narratives: ["AI agents", "political memes", "cat coins", "DePIN", "gaming tokens"],
      theme_scores: { "AI agents": 60, "political memes": 55, "cat coins": 50, "DePIN": 40, "gaming tokens": 35 },
      reasoning: "OpenAI API key not configured. Using default narratives.",
    };
  }

  const pumpfunSummary = pumpfunData.slice(0, 10).map((t) => ({
    symbol: t.symbol,
    name: t.name,
    mc: t.market_cap,
    holders: t.holder_count,
    desc: t.description?.substring(0, 100) || "",
  }));

  const lunacrushSummary = lunacrushData.slice(0, 10).map((t) => ({
    symbol: t.symbol,
    name: t.name,
    sentiment: t.social_sentiment,
    mentions: t.social_mentions,
    vol: t.volume_24h,
  }));

  const userMessage = `Pump.fun new tokens:\n${JSON.stringify(pumpfunSummary, null, 2)}\n\nLunarCrush social data:\n${JSON.stringify(lunacrushSummary, null, 2)}\n\nIdentify the top trending narratives.`;

  try {
    const resp = await fetch(`${OPENAI_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: getModel(),
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
        temperature: 0.3,
        max_tokens: 500,
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) {
      const err = await resp.text();
      console.error(`[OpenAI] API error ${resp.status}:`, err);
      return fallbackAnalysis();
    }

    const data = (await resp.json()) as {
      choices: Array<{ message: { content: string } }>;
    };

    const content = data.choices?.[0]?.message?.content || "";
    const parsed = JSON.parse(content) as NarrativeAnalysis;

    return {
      trending_narratives: parsed.trending_narratives || [],
      theme_scores: parsed.theme_scores || {},
      reasoning: parsed.reasoning || "Analysis complete.",
    };
  } catch (err) {
    console.error("[OpenAI] narrative analysis failed:", err);
    return fallbackAnalysis();
  }
}

function fallbackAnalysis(): NarrativeAnalysis {
  return {
    trending_narratives: ["AI agents", "political memes", "cat coins", "DePIN", "gaming tokens"],
    theme_scores: { "AI agents": 60, "political memes": 55, "cat coins": 50, "DePIN": 40, "gaming tokens": 35 },
    reasoning: "Analysis failed. Using default trending narratives.",
  };
}
