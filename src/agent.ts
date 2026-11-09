// Demo run of the gem-refund agent. Run: npm start
import { Command, GraphRecursionError } from "@langchain/langgraph";
import { buildGraph, pendingApproval } from "./graph.js";
import { chaos } from "./crm.js";

const graph = buildGraph();
const msg = "my gems are missing";

async function main() {
  // Small missing purchase -> auto refund; delivered purchase -> nothing to refund.
  for (const pid of ["p1", "p3"]) {
    const r = await graph.invoke({ playerId: pid, message: msg }, { configurable: { thread_id: pid } });
    console.log(`${pid}: ${r.reply}`);
  }

  // 49.99 EUR -> the graph pauses at the approval node; the checkpointer holds the thread.
  const cfg = { configurable: { thread_id: "p2" } };
  await graph.invoke({ playerId: "p2", message: msg }, cfg);
  console.log("p2: paused ->", await pendingApproval(graph, "p2"));
  const resumed = await graph.invoke(new Command({ resume: "yes" }), cfg);
  console.log(`p2: human said yes -> ${resumed.reply}`);

  // Two CRM timeouts: lookup's retryPolicy absorbs them.
  chaos.failNextCalls = 2;
  const r = await graph.invoke(
    { playerId: "p1", message: msg },
    { configurable: { thread_id: "p1-retry" }, recursionLimit: 10 },
  );
  console.log(`p1 after 2 CRM timeouts: ${r.reply}`);

  // recursionLimit counts super-steps (incl. the input step). 3 is too low for this path:
  // catch it and hand off instead of crashing.
  try {
    await graph.invoke({ playerId: "p3", message: msg }, { configurable: { thread_id: "p3-limit" }, recursionLimit: 3 });
  } catch (e) {
    if (e instanceof GraphRecursionError) console.log("recursion limit hit -> hand off to a human with a summary");
    else throw e;
  }
}

main();
