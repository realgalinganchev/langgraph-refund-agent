# Learning steps

Run after each step: `npx tsx src/agent.ts`

## Concepts in one line each
- **State**: one object all nodes share. A node returns a partial update; LangGraph merges it.
- **Node**: an async function `(state) => partialState`.
- **Edge**: fixed "go next to X". **Conditional edge**: a function that looks at state and returns the next node's name.
- **Checkpointer**: saves state after every node, keyed by `thread_id` (= one conversation).
- **interrupt()**: pauses the graph inside a node; resume later with `new Command({ resume: value })`.
- **retryPolicy**: per node, re-runs a failing node with backoff.
- **recursionLimit**: max steps per run; stops runaway loops.

## Step 1: wire the graph
Add all six nodes, the START edge, both conditional edges and the END edges.
Expected: p1 gets 500 gems refunded, p3 gets "nothing to refund".
Ask yourself: where would a real LLM sit in this graph, and which nodes must never be an LLM decision?

## Step 2: human approval
Implement `approve` with `interrupt()`. Route purchases over 5 EUR through it.
Expected: p2 does NOT get refunded yet; the run returns an `__interrupt__` with the purchase.

## Step 3: checkpointer + resume
Compile with `checkpointer: new MemorySaver()`. Invoke p2, print the interrupt, then resume with
`new Command({ resume: "yes" })` on the same `thread_id`. Try `"no"` too.
Expected: after "yes" p2 gets 6500 gems. Without a checkpointer, resume fails. Why?

## Step 4: failures and limits
Set `chaos.failNextCalls = 2` and run p1 on a new thread. It crashes.
Add `{ retryPolicy: { maxAttempts: 3, initialInterval: 0.1 } }` as the 3rd arg of `addNode("lookup", ...)`.
Then pass `recursionLimit: 3` in the config and see what error you get. Set it back to something sane.
Bonus: run p1 again after its refund. Does the idempotency key protect the second refund?
