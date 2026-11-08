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
npm start
```

## Notes
- `interrupt()` re-runs its node from the top on resume, so no side effects go before it.
- `recursionLimit` counts super-steps including the input step; retries inside a node don't count.
- `STEPS.md` is the step-by-step exercise I followed.
