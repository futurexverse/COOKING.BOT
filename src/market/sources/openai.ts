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

const SYSTEM_PROMPT = `You are COOKING, an AI cross-chain meme coin analyst. You analyze trending tokens from multiple blockchains (Solana, Ethereum, Base, BSC, Arbitrum, etc.) to identify the hottest narratives driving the current meme coin market.

You will receive:
- Token data from Pump.fun (Solana memecoin launches) with market caps and holder counts
- Social data from LunarCrush with mention volumes and sentiment

Your job: Identify the TOP 5 trending narratives (themes, memes, sectors) that are HOT right now across all chains.

Return a JSON object with:
- trending_narratives: array of exactly 5 narrative names, ordered by热度 (e.g., ["AI agents", "PolitiFi", "Cat coins", "RWA tokenization", "DePIN"])
- theme_scores: object mapping each narrative to a HOTNESS score 0-100 (100 = extremely hot, everyone talking about it; 0 = dead). Be aggressive - if something is truly trending, score it 80+. If it's meh, score it 30-50.
- reasoning: 2-3 sentences explaining WHY these narratives are hot right now. Reference specific tokens if you see patterns.

ANALYSIS RULES:
1. Look for CLUSTERS - if multiple tokens share a theme (e.g., multiple cat coins, multiple AI tokens), that narrative is hot
2. Social mentions matter more than market cap for identifying trends early
3. New launches (low market cap) with high social buzz = early signal
4. Volume relative to market cap = momentum indicator
5. Don't just list sectors - identify the SPECIFIC memes/trends (e.g., not just "animals" but "cat coins specifically")

Keep reasoning concise. Max 200 words.

IMPORTANT: Return ONLY valid JSON, no markdown, no code blocks, no extra text.`;

export async function analyzeNarrative(
  pumpfunData: Array<{ symbol: string; name?: string; market_cap?: number; holder_count?: number; description?: string }>,
  lunacrushData: Array<{ symbol: string; name?: string; social_sentiment?: number; social_mentions?: number; volume_24h?: number }>
): Promise<NarrativeAnalysis> {
  const apiKey = getApiKey();
  if (!apiKey) {
    console.log("[Gemini] No API key, using fallback analysis");
    return fallbackAnalysis();
  }

  const tokenSummary = pumpfunData.slice(0, 15).map((t) => ({
    symbol: t.symbol,
    name: t.name || "",
    mc: t.market_cap || 0,
    holders: t.holder_count || 0,
  }));

  const socialSummary = lunacrushData.slice(0, 15).map((t) => ({
    symbol: t.symbol,
    name: t.name || "",
    mentions: t.social_mentions || 0,
    vol: t.volume_24h || 0,
  }));

  const userMessage = `Analyze these trending tokens across chains and identify the HOTTEST narratives:

PUMP.FUN DATA (Solana memecoin launches):
${JSON.stringify(tokenSummary, null, 2)}

LUNARCRUSH DATA (Social metrics):
${JSON.stringify(socialSummary, null, 2)}

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
    console.log(`[Gemini] Raw response: ${text.substring(0, 200)}...`);

    const parsed = JSON.parse(text) as NarrativeAnalysis;

    const result: NarrativeAnalysis = {
      trending_narratives: (parsed.trending_narratives || []).slice(0, 5),
      theme_scores: parsed.theme_scores || {},
      reasoning: parsed.reasoning || "Analysis complete.",
      raw_response: text,
    };

    console.log(`[Gemini] Narratives: ${result.trending_narratives.join(", ")}`);
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
    reasoning: "Default analysis. Connect Google AI key for live narrative detection.",
  };
}
