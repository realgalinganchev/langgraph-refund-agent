// Demo of the conversation layer: XState runs the chat, LangGraph runs the agent. Run: npm run chat
import { createActor, waitFor } from "xstate";
import { buildGraph } from "./graph.js";
import { conversationMachine } from "./conversation.js";
import { resetCrm } from "./crm.js";

type Step = { type: "PLAYER_MESSAGE"; text: string } | { type: "APPROVED" } | { type: "REJECTED" } | { type: "ASK_FOR_HUMAN" };

async function chat(name: string, playerId: string, steps: Step[]) {
  resetCrm(); // fresh fake CRM per scenario
  const actor = createActor(conversationMachine(buildGraph(), playerId)).start();
  const path = [String(actor.getSnapshot().value)];
  for (const e of steps) {
    actor.send(e);
    const s = await waitFor(actor, (s) => !s.matches("working") && !s.matches("resuming"));
    path.push(String(s.value));
  }
  console.log(`${name}\n  states:  ${path.join(" -> ")}`);
  for (const r of actor.getSnapshot().context.replies) console.log(`  agent:   ${r}`);
}

const msg = { type: "PLAYER_MESSAGE", text: "my gems are missing" } as const;

await chat("small refund (p1)", "p1", [msg]);
await chat("big refund, human approves (p2)", "p2", [msg, { type: "APPROVED" }]);
await chat("APPROVED before anything is pending is ignored (p2)", "p2", [{ type: "APPROVED" }]);
await chat("unclear x3 (p1)", "p1", [
  { type: "PLAYER_MESSAGE", text: "hello?" },
  { type: "PLAYER_MESSAGE", text: "hello?" },
  { type: "PLAYER_MESSAGE", text: "hello?" },
]);
await chat("player asks for a human mid-approval (p2)", "p2", [msg, { type: "ASK_FOR_HUMAN" }]);
