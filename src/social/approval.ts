import type { ApprovalRequest } from "../schemas/index.js";

interface PendingEntry {
  decision_id: string;
  proposal: unknown;
  created_at: number;
  status: "pending" | "approved" | "rejected";
}

const pendingApprovals = new Map<string, PendingEntry>();

export function registerProposal(
  decisionId: string,
  proposal: unknown
): void {
  pendingApprovals.set(decisionId, {
    decision_id: decisionId,
    proposal,
    created_at: Date.now(),
    status: "pending",
  });
}

export async function processApproval(
  request: ApprovalRequest
): Promise<{ success: boolean; message: string }> {
  const pending = pendingApprovals.get(request.decision_id);
  if (!pending) {
    return { success: false, message: "No pending proposal with that ID" };
  }

  if (pending.status !== "pending") {
    return {
      success: false,
      message: `Proposal already ${pending.status}`,
    };
  }

  const timeout = parseInt(
    process.env.LAUNCH_APPROVAL_TIMEOUT_SECONDS || "300",
    10
  ) * 1000;

  if (Date.now() - pending.created_at > timeout) {
    pending.status = "rejected";
    return { success: false, message: "Approval window expired" };
  }

  if (request.approved) {
    pending.status = "approved";
    return { success: true, message: "Launch approved — ready to execute" };
  } else {
    pending.status = "rejected";
    return { success: true, message: "Launch rejected" };
  }
}

export function getApprovalStatus(
  decisionId: string
): "pending" | "approved" | "rejected" | "not_found" {
  return pendingApprovals.get(decisionId)?.status || "not_found";
}

export function isApproved(decisionId: string): boolean {
  return pendingApprovals.get(decisionId)?.status === "approved";
}

export function getPendingProposals(): Array<{
  decision_id: string;
  proposal: unknown;
  created_at: number;
  status: "pending" | "approved" | "rejected";
}> {
  return Array.from(pendingApprovals.values());
}

export function getProposalById(decisionId: string): PendingEntry | undefined {
  return pendingApprovals.get(decisionId);
}

const COOLDOWN_MS = 60 * 60 * 1000;

export function hasPendingProposalForSymbol(symbol: string): boolean {
  for (const entry of pendingApprovals.values()) {
    if (entry.status !== "pending") continue;
    const prop = entry.proposal as Record<string, unknown> | undefined;
    const sig = prop?.signal as Record<string, unknown> | undefined;
    const propSymbol = (prop?.symbol as string) || (sig?.symbol as string) || "";
    if (propSymbol.toUpperCase() === symbol.toUpperCase()) return true;
  }
  return false;
}

export function isSymbolOnCooldown(symbol: string): boolean {
  for (const entry of pendingApprovals.values()) {
    const prop = entry.proposal as Record<string, unknown> | undefined;
    const sig = prop?.signal as Record<string, unknown> | undefined;
    const propSymbol = (prop?.symbol as string) || (sig?.symbol as string) || "";
    if (propSymbol.toUpperCase() === symbol.toUpperCase()) {
      if (Date.now() - entry.created_at < COOLDOWN_MS) return true;
    }
  }
  return false;
}
