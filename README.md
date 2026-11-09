# langgraph-refund-agent

A small LangGraph.js agent I built to learn LangGraph hands-on. It handles a support case from a game:
"I bought gems but they never arrived."

![graph](graph.svg)

## What it shows
- **Conditional routing in code**: the intent and the refund threshold are decided by edge functions, not by a model.
- **Human in the loop**: refunds over 5 EUR pause the graph with `interrupt()` and wait for an approval. Only an explicit "yes" pays out (fail closed).
- **Checkpointing + resume**: a `MemorySaver` checkpointer stores the paused state per `thread_id`; `new Command({ resume })` continues it.
- **Retries**: the CRM-reading node has a `retryPolicy` (backoff with jitter) and survives injected timeouts.
- **Recursion limit**: `recursionLimit` stops runaway runs; the error is caught and turned into a hand-off.
- **Idempotent write**: the refund uses the purchase ID as an idempotency key, so a repeated call pays once.

The CRM is a fake in-memory module (`src/crm.ts`), and intent classification is rule-based where a real system would use an LLM.

## Run
```
npm install
npm start       # demo run
npm test        # 9 tests on the money paths
npm run typecheck
```

Sample output of `npm start`:
```
p1: Refund result: {"status":"ok","purchaseId":"pur-101","creditedGems":500,"newBalance":620}
p3: All your purchases were delivered, nothing to refund.
p2: paused -> { playerId: 'p2', message: 'Approve refund of 49.99 EUR?' }
p2: human said yes -> Refund result: {"status":"ok","purchaseId":"pur-202","creditedGems":6500,"newBalance":6540}
Retrying task "lookup" after 541.70ms (attempt 1) after Error: Error: CRM timeout on getPlayerAccount
Retrying task "lookup" after 977.26ms (attempt 2) after Error: Error: CRM timeout on getPlayerAccount
p1 after 2 CRM timeouts: All your purchases were delivered, nothing to refund.
recursion limit hit -> hand off to a human with a summary
```

## Tests
`test/agent.test.ts` covers what must never go wrong with money:
- a small missing purchase is refunded automatically, a delivered one is not
- a big refund pauses and pays nothing until a human answers
- "yes" pays once, "no" pays nothing, anything unexpected fails closed
- the same purchase can't be credited twice (idempotency key)
- CRM timeouts are retried; the recursion limit stops a run

## Layout
- `src/graph.ts`: state, nodes and graph wiring
- `src/crm.ts`: fake in-memory CRM with simulated timeouts
- `src/agent.ts`: demo run
- `test/agent.test.ts`: tests (Node's built-in test runner)

## Notes
- `interrupt()` re-runs its node from the top on resume, so no side effects go before it.
- `recursionLimit` counts super-steps including the input step; retries inside a node don't count.
- `STEPS.md` is the step-by-step exercise I followed.
