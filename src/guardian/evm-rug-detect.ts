import { checkTokenSafety, fetchTokenHolders } from "../market/sources/blockscout.js";

interface RugCheck {
  is_rug: boolean;
  risk_score: number;
  flags: string[];
  details: {
    has_freeze_authority: boolean;
    has_mint_authority: boolean;
    is_verified: boolean;
    owner_renounced: boolean;
    top_holder_pct: number;
    holder_count: number;
  };
}

export async function checkForRugs(
  tokenAddress: string
): Promise<RugCheck> {
  const defaultResult: RugCheck = {
    is_rug: false,
    risk_score: 0,
    flags: [],
    details: {
      has_freeze_authority: false,
      has_mint_authority: false,
      is_verified: false,
      owner_renounced: false,
      top_holder_pct: 0,
      holder_count: 0,
    },
  };

  try {
    const [safety, holders] = await Promise.allSettled([
      checkTokenSafety(tokenAddress),
      fetchTokenHolders(tokenAddress),
    ]);

    const safetyData = safety.status === "fulfilled" ? safety.value : null;
    const holderData = holders.status === "fulfilled" ? holders.value : null;

    if (!safetyData) return defaultResult;

    let riskScore = 0;
    const flags: string[] = [];

    if (safetyData.has_mint_authority) {
      riskScore += 30;
      flags.push("mint_authority");
    }

    if (safetyData.has_freeze_authority) {
      riskScore += 30;
      flags.push("freeze_authority");
    }

    if (!safetyData.is_verified) {
      riskScore += 10;
      flags.push("unverified");
    }

    if (safetyData.top_holder_pct > 50) {
      riskScore += 25;
      flags.push("concentrated_supply");
    } else if (safetyData.top_holder_pct > 30) {
      riskScore += 15;
      flags.push("moderate_concentration");
    }

    const holderCount = holderData?.count || 0;
    if (holderCount < 10) {
      riskScore += 10;
      flags.push("few_holders");
    }

    return {
      is_rug: riskScore >= 50,
      risk_score: Math.min(100, riskScore),
      flags,
      details: {
        has_freeze_authority: safetyData.has_freeze_authority,
        has_mint_authority: safetyData.has_mint_authority,
        is_verified: safetyData.is_verified,
        owner_renounced: safetyData.owner_renounced,
        top_holder_pct: safetyData.top_holder_pct,
        holder_count: holderCount,
      },
    };
  } catch (err) {
    console.error(`[RugDetect] Error checking ${tokenAddress}:`, err);
    return defaultResult;
  }
}

export function getRiskLabel(score: number): string {
  if (score >= 70) return "HIGH RISK";
  if (score >= 50) return "MEDIUM RISK";
  if (score >= 30) return "LOW RISK";
  return "SAFE";
}
