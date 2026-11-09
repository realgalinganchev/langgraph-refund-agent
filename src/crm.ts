// Fake CRM for the gem-refund agent. No network, no LLM: just data + rules.

export type Purchase = { purchaseId: string; gems: number; priceEur: number; delivered: boolean };
export type Player = { playerId: string; gems: number; banned: boolean; purchases: Purchase[] };

function seed(): Record<string, Player> {
  return {
    // Paid, gems never arrived, small amount -> auto refund
    p1: { playerId: "p1", gems: 120, banned: false, purchases: [{ purchaseId: "pur-101", gems: 500, priceEur: 4.99, delivered: false }] },
    // Paid, gems never arrived, big amount -> needs human approval
    p2: { playerId: "p2", gems: 40, banned: false, purchases: [{ purchaseId: "pur-202", gems: 6500, priceEur: 49.99, delivered: false }] },
    // Gems were delivered -> no refund
    p3: { playerId: "p3", gems: 900, banned: false, purchases: [{ purchaseId: "pur-303", gems: 500, priceEur: 4.99, delivered: true }] },
  };
}

let players = seed();

// Idempotency: purchaseIds we have already refunded.
const refunded = new Set<string>();

// Set to N to make the next N CRM calls fail (simulated timeouts).
export const chaos = { failNextCalls: 0 };

// Fresh data for each test.
export function resetCrm() {
  players = seed();
  refunded.clear();
  chaos.failNextCalls = 0;
}

function maybeFail(op: string) {
  if (chaos.failNextCalls > 0) {
    chaos.failNextCalls--;
    throw new Error(`CRM timeout on ${op}`);
  }
}

export async function getPlayerAccount(playerId: string) {
  maybeFail("getPlayerAccount");
  const p = players[playerId];
  if (!p) return { status: "not_found" as const };
  return { status: "ok" as const, playerId: p.playerId, gems: p.gems, banned: p.banned };
}

export async function getPurchaseHistory(playerId: string) {
  maybeFail("getPurchaseHistory");
  const p = players[playerId];
  if (!p) return { status: "not_found" as const };
  return { status: "ok" as const, purchases: p.purchases };
}

// A WRITE. The purchaseId is the idempotency key: calling twice credits once.
export async function issueRefund(playerId: string, purchaseId: string) {
  if (refunded.has(purchaseId)) return { status: "already_done" as const, purchaseId };
  const p = players[playerId];
  const pur = p?.purchases.find((x) => x.purchaseId === purchaseId);
  if (!p || !pur) return { status: "not_found" as const };
  p.gems += pur.gems;
  pur.delivered = true;
  refunded.add(purchaseId);
  return { status: "ok" as const, purchaseId, creditedGems: pur.gems, newBalance: p.gems };
}
