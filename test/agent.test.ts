// Money-path tests. Run: npm test
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Command, GraphRecursionError } from "@langchain/langgraph";
import { buildGraph, pendingApproval } from "../src/graph.js";
import { resetCrm, chaos, getPlayerAccount, issueRefund } from "../src/crm.js";

const msg = "my gems are missing";
const gems = async (pid: string) => {
  const a = await getPlayerAccount(pid);
  assert.equal(a.status, "ok");
  return a.status === "ok" ? a.gems : -1;
};

beforeEach(() => resetCrm());

test("small missing purchase is refunded automatically", async () => {
  const g = buildGraph();
  await g.invoke({ playerId: "p1", message: msg }, { configurable: { thread_id: "t" } });
  assert.equal(await gems("p1"), 620);
});

test("delivered purchase is not refunded", async () => {
  const g = buildGraph();
  const r = await g.invoke({ playerId: "p3", message: msg }, { configurable: { thread_id: "t" } });
  assert.match(r.reply, /nothing to refund/);
  assert.equal(await gems("p3"), 900);
});

test("big refund pauses for approval and pays nothing until a human answers", async () => {
  const g = buildGraph();
  await g.invoke({ playerId: "p2", message: msg }, { configurable: { thread_id: "t" } });
  const req = await pendingApproval(g, "t");
  assert.ok(req);
  assert.match(req.message, /49\.99/);
  assert.equal(await gems("p2"), 40);
});

test('human "yes" pays out once', async () => {
  const g = buildGraph();
  const cfg = { configurable: { thread_id: "t" } };
  await g.invoke({ playerId: "p2", message: msg }, cfg);
  await g.invoke(new Command({ resume: "yes" }), cfg);
  assert.equal(await gems("p2"), 6540);
  assert.equal(await pendingApproval(g, "t"), null);
});

test('human "no" pays nothing', async () => {
  const g = buildGraph();
  const cfg = { configurable: { thread_id: "t" } };
  await g.invoke({ playerId: "p2", message: msg }, cfg);
  const r = await g.invoke(new Command({ resume: "no" }), cfg);
  assert.match(r.reply, /colleague will review/);
  assert.equal(await gems("p2"), 40);
});

test("unexpected approval answer fails closed", async () => {
  const g = buildGraph();
  const cfg = { configurable: { thread_id: "t" } };
  await g.invoke({ playerId: "p2", message: msg }, cfg);
  await g.invoke(new Command({ resume: "maybe" }), cfg);
  assert.equal(await gems("p2"), 40);
});

test("refund is idempotent: the same purchase is credited once", async () => {
  const first = await issueRefund("p1", "pur-101");
  const second = await issueRefund("p1", "pur-101");
  assert.equal(first.status, "ok");
  assert.equal(second.status, "already_done");
  assert.equal(await gems("p1"), 620);
});

test("two CRM timeouts are absorbed by the retry policy", async () => {
  const g = buildGraph();
  chaos.failNextCalls = 2;
  await g.invoke({ playerId: "p1", message: msg }, { configurable: { thread_id: "t" } });
  assert.equal(await gems("p1"), 620);
});

test("recursion limit stops the run", async () => {
  const g = buildGraph();
  await assert.rejects(
    g.invoke({ playerId: "p3", message: msg }, { configurable: { thread_id: "t" }, recursionLimit: 3 }),
    GraphRecursionError,
  );
});
