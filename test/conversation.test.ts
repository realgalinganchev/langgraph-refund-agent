// Conversation-layer tests: XState decides what is allowed, LangGraph does the work.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createActor, waitFor } from "xstate";
import { buildGraph } from "../src/graph.js";
import { conversationMachine } from "../src/conversation.js";
import { resetCrm, chaos, getPlayerAccount } from "../src/crm.js";

beforeEach(() => resetCrm());

const gems = async (pid: string) => {
  const a = await getPlayerAccount(pid);
  return a.status === "ok" ? a.gems : -1;
};

function chat(playerId: string) {
  const actor = createActor(conversationMachine(buildGraph(), playerId)).start();
  const settled = () =>
    waitFor(actor, (s) => !s.matches("working") && !s.matches("resuming"), { timeout: 2000 });
  return { actor, settled };
}

test("small missing purchase: resolved, gems credited", async () => {
  const { actor, settled } = chat("p1");
  actor.send({ type: "PLAYER_MESSAGE", text: "my gems are missing" });
  const s = await settled();
  assert.equal(s.value, "resolved");
  assert.equal(await gems("p1"), 620);
});

test("big refund waits for a human; APPROVED pays once", async () => {
  const { actor, settled } = chat("p2");
  actor.send({ type: "PLAYER_MESSAGE", text: "my gems are missing" });
  assert.equal((await settled()).value, "awaitingApproval");
  assert.equal(await gems("p2"), 40);
  actor.send({ type: "APPROVED" });
  assert.equal((await settled()).value, "resolved");
  assert.equal(await gems("p2"), 6540);
});

test("REJECTED escalates and pays nothing", async () => {
  const { actor, settled } = chat("p2");
  actor.send({ type: "PLAYER_MESSAGE", text: "my gems are missing" });
  await settled();
  actor.send({ type: "REJECTED" });
  assert.equal((await settled()).value, "escalated");
  assert.equal(await gems("p2"), 40);
});

test("APPROVED with no pending approval is ignored", async () => {
  const { actor } = chat("p2");
  actor.send({ type: "APPROVED" });
  assert.equal(actor.getSnapshot().value, "listening");
  assert.equal(await gems("p2"), 40);
});

test("unclear message: 2 clarifying questions, then a human", async () => {
  const { actor, settled } = chat("p1");
  for (let i = 0; i < 2; i++) {
    actor.send({ type: "PLAYER_MESSAGE", text: "hello?" });
    assert.equal((await settled()).value, "listening");
  }
  actor.send({ type: "PLAYER_MESSAGE", text: "hello?" });
  const s = await settled();
  assert.equal(s.value, "escalated");
  assert.equal(s.context.clarifications, 2);
});

test("CRM down after the graph's retries: escalated, nothing paid", async () => {
  const { actor, settled } = chat("p1");
  chaos.failNextCalls = 3; // lookup's retryPolicy allows 3 attempts
  actor.send({ type: "PLAYER_MESSAGE", text: "my gems are missing" });
  assert.equal((await settled()).value, "escalated");
  assert.equal(await gems("p1"), 120);
});

test("ASK_FOR_HUMAN works mid-approval, and a finished chat ignores later events", async () => {
  const { actor, settled } = chat("p2");
  actor.send({ type: "PLAYER_MESSAGE", text: "my gems are missing" });
  await settled();
  actor.send({ type: "ASK_FOR_HUMAN" });
  assert.equal(actor.getSnapshot().value, "escalated");
  actor.send({ type: "APPROVED" }); // actor is done: ignored
  assert.equal(actor.getSnapshot().value, "escalated");
  assert.equal(await gems("p2"), 40);
});

test("ASK_FOR_HUMAN mid-run aborts the graph before it refunds", async () => {
  const { actor } = chat("p1");
  actor.send({ type: "PLAYER_MESSAGE", text: "my gems are missing" });
  actor.send({ type: "ASK_FOR_HUMAN" }); // leaving "working" fires the AbortSignal
  assert.equal(actor.getSnapshot().value, "escalated");
  await new Promise((r) => setTimeout(r, 300)); // give a non-cancelled run time to finish
  assert.equal(await gems("p1"), 120);
});
