// Gem-refund agent in LangGraph.js. Run: npx tsx src/agent.ts
// Learning project: a small refund agent showing conditional routing, human approval (interrupt),
// checkpointing + resume, per-node retries and a recursion limit. See STEPS.md and graph.svg.
import {
  StateGraph,
  Annotation,
  START,
  END,
  MemorySaver,
  interrupt,
  Command,
  GraphRecursionError,
} from "@langchain/langgraph";
import {
  getPlayerAccount,
  getPurchaseHistory,
  issueRefund,
  chaos,
  type Purchase,
} from "./crm.js";

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
type S = typeof State.State;

// ---- Nodes (given) ----

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
// API: new StateGraph(State).addNode(name, fn).addEdge(from, to)
//      .addConditionalEdges(from, (s) => "nextNodeName").compile(...)
const graph = new StateGraph(State)
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

// ---- Runs ----
async function main() {
  // STEP 1: p1 (small, auto refund) and p3 (already delivered)
  for (const pid of ["p1", "p3"]) {
    const r = await graph.invoke(
      { playerId: pid, message: "my gems are missing" },
      { configurable: { thread_id: pid } },
    );
    console.log(pid, "->", r.reply);
  }

  // STEP 2 + 3: p2 (49.99 EUR) should PAUSE, then resume with a human decision.
  const res = await graph.invoke(
    { playerId: "p2", message: "my gems are missing" },
    { configurable: { thread_id: "p2" } },
  );
  console.log("Init pause", (res as any).__interrupt__);
  const resumed = await graph.invoke(new Command({ resume: "yes" }), {
    configurable: { thread_id: "p2" },
  });
  console.log(" Resume", resumed.reply);

  // STEP 4: retries + loop limit.
  // Two CRM timeouts: lookup's retryPolicy absorbs them.
  chaos.failNextCalls = 2;
  const r = await graph.invoke(
    { playerId: "p1", message: "my gems are missing" },
    { configurable: { thread_id: "p1-retry" }, recursionLimit: 10 },
  );
  console.log("Retry", r.reply);

  // recursionLimit counts super-steps (incl. the input step). 3 is too low for this path:
  // catch it and hand off instead of crashing.
  try {
    await graph.invoke(
      { playerId: "p3", message: "my gems are missing" },
      { configurable: { thread_id: "p3-limit" }, recursionLimit: 3 },
    );
  } catch (e) {
    if (e instanceof GraphRecursionError) console.log("Limit hit -> hand off to a human with a summary");
    else throw e;
  }
}

main();
