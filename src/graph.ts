// Gem-refund agent: state, nodes and graph wiring.
import { StateGraph, Annotation, START, END, MemorySaver, interrupt } from "@langchain/langgraph";
import { getPlayerAccount, getPurchaseHistory, issueRefund, type Purchase } from "./crm.js";

// ---- State: the "shared notebook" every node reads from and writes to ----
// A node returns a PARTIAL object; LangGraph merges it into the state.
const State = Annotation.Root({
  playerId: Annotation<string>,
  message: Annotation<string>,
  intent: Annotation<string>,
  missing: Annotation<Purchase | null>,
  decision: Annotation<string>,
  reply: Annotation<string>,
});
export type S = typeof State.State;
export type Graph = ReturnType<typeof buildGraph>;

// ---- Nodes ----

// Stand-in for an LLM call: rule-based intent.
const classify = async (s: S) => ({
  intent: /gems|purchase|bought|missing/i.test(s.message)
    ? "missing_purchase"
    : "other",
});

// READ tools: account + purchase history. Finds the first undelivered purchase.
const lookup = async (s: S) => {
  const acc = await getPlayerAccount(s.playerId);
  if (acc.status !== "ok") return { missing: null };
  const hist = await getPurchaseHistory(s.playerId);
  const missing =
    hist.status === "ok"
      ? (hist.purchases.find((p) => !p.delivered) ?? null)
      : null;
  return { missing };
};

// WRITE tool. Idempotent thanks to purchaseId.
const refund = async (s: S) => {
  if (s.decision === "rejected")
    return { reply: "A colleague will review your case." };
  const r = await issueRefund(s.playerId, s.missing!.purchaseId);
  return { reply: `Refund result: ${JSON.stringify(r)}` };
};

const other = async () => ({ reply: "Handing you to a human agent." });
const noRefund = async () => ({
  reply: "All your purchases were delivered, nothing to refund.",
});

// ---- Human approval node ----
// Pause the graph and ask a human. Use interrupt(payload): it returns whatever
// the human sends back when the graph is resumed. Return { decision: "approved" | "rejected" }.
const approve = async (s: S) => {
  const answer = interrupt({
    playerId: s.playerId,
    message: `Approve refund of ${s.missing!.priceEur} EUR?`,
  });
  return { decision: answer === "yes" ? "approved" : "rejected" };
};

// ---- Graph wiring ----
// Flow: START -> classify -> (missing_purchase ? lookup : other)
//       lookup -> (no missing purchase ? noRefund : price > 5 EUR ? approve : refund)
//       approve -> refund;  refund / other / noRefund -> END
// A new graph (and checkpointer) per call, so tests don't share paused threads.
export function buildGraph() {
  return new StateGraph(State)
    .addNode("classify", classify)
    .addNode("lookup", lookup, {
      retryPolicy: { maxAttempts: 3, initialInterval: 0.1 },
    })
    .addNode("approve", approve)
    .addNode("refund", refund)
    .addNode("other", other)
    .addNode("noRefund", noRefund)
    .addEdge(START, "classify")
    .addConditionalEdges("classify", (s) =>
      s.intent === "missing_purchase" ? "lookup" : "other",
    )
    .addConditionalEdges("lookup", (s) =>
      !s.missing ? "noRefund" : s.missing.priceEur > 5 ? "approve" : "refund",
    )
    .addEdge("approve", "refund")
    .addEdge("refund", END)
    .addEdge("other", END)
    .addEdge("noRefund", END)
    .compile({ checkpointer: new MemorySaver() });
}

export type ApprovalRequest = { playerId: string; message: string };

// Reads the paused thread from the checkpointer: the approval request waiting for a human, if any.
export async function pendingApproval(graph: Graph, threadId: string): Promise<ApprovalRequest | null> {
  const snap = await graph.getState({ configurable: { thread_id: threadId } });
  const req = snap.tasks.flatMap((t) => t.interrupts ?? [])[0];
  return (req?.value as ApprovalRequest | undefined) ?? null;
}
