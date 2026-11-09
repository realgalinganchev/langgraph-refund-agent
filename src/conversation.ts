// Conversation layer: an XState machine owns the chat, the LangGraph graph does the work.
//
// Split of responsibilities:
//   XState    -> which events are allowed right now (no "APPROVED" unless an approval is
//                pending), how many clarifying questions we ask, "give me a human" at any time.
//   LangGraph -> the agent run itself: classify, CRM lookup with retries, approval pause, refund.
import { setup, assign, fromPromise } from "xstate";
import { Command } from "@langchain/langgraph";
import { pendingApproval, type Graph, type S } from "./graph.js";

type Ctx = {
  playerId: string;
  lastMessage: string;
  answer: "yes" | "no";
  clarifications: number;
  replies: string[]; // what the player sees, in order
};

type Ev =
  | { type: "PLAYER_MESSAGE"; text: string }
  | { type: "APPROVED" } // a human approved the refund
  | { type: "REJECTED" } // a human rejected it
  | { type: "ASK_FOR_HUMAN" }; // the player wants a person, from any state

type RunResult = { outcome: "unclear" | "needs_approval" | "done"; reply: string };
type ResumeResult = { approved: boolean; reply: string };

// One machine per conversation. threadId = the LangGraph checkpointer thread for this chat.
export function conversationMachine(graph: Graph, playerId: string) {
  const cfg = { configurable: { thread_id: `chat-${playerId}` } };

  return setup({
    types: { context: {} as Ctx, events: {} as Ev },
    actions: {
      // Adds a line to what the player sees.
      say: assign({ replies: ({ context }, params: { text: string }) => [...context.replies, params.text] }),
    },
    actors: {
      // Runs the graph on a player message. The AbortSignal fires if the machine leaves the
      // state first (e.g. ASK_FOR_HUMAN), so the run is cancelled instead of left dangling.
      runGraph: fromPromise<RunResult, { message: string }>(async ({ input, signal }) => {
        const s = (await graph.invoke({ playerId, message: input.message }, { ...cfg, signal })) as S;
        if (await pendingApproval(graph, cfg.configurable.thread_id))
          return { outcome: "needs_approval", reply: "" };
        if (s.intent !== "missing_purchase") return { outcome: "unclear", reply: "" };
        return { outcome: "done", reply: s.reply };
      }),
      // Resumes the paused graph with the human's answer.
      resumeGraph: fromPromise<ResumeResult, { answer: "yes" | "no" }>(async ({ input, signal }) => {
        const s = (await graph.invoke(new Command({ resume: input.answer }), { ...cfg, signal })) as S;
        return { approved: s.decision === "approved", reply: s.reply };
      }),
    },
  }).createMachine({
    id: "conversation",
    initial: "listening",
    context: { playerId, lastMessage: "", answer: "no", clarifications: 0, replies: [] },

    // Root-level: every non-final state handles it.
    on: { ASK_FOR_HUMAN: ".escalated" },

    states: {
      listening: {
        on: {
          PLAYER_MESSAGE: { target: "working", actions: assign({ lastMessage: ({ event }) => event.text }) },
        },
      },
      // While the agent runs, PLAYER_MESSAGE / APPROVED are ignored: no double runs, no early approvals.
      working: {
        invoke: {
          src: "runGraph",
          input: ({ context }) => ({ message: context.lastMessage }),
          onDone: [
            {
              guard: ({ event }) => event.output.outcome === "needs_approval",
              target: "awaitingApproval",
              actions: { type: "say", params: { text: "Checking with a colleague, one moment." } },
            },
            {
              guard: ({ context, event }) => event.output.outcome === "unclear" && context.clarifications < 2, // max 2 questions
              target: "listening",
              actions: [
                assign({ clarifications: ({ context }) => context.clarifications + 1 }),
                { type: "say", params: { text: "Sorry, I didn't get that. What happened with your purchase?" } },
              ],
            },
            { guard: ({ event }) => event.output.outcome === "unclear", target: "escalated" },
            {
              target: "resolved",
              actions: { type: "say", params: ({ event }) => ({ text: event.output.reply }) },
            },
          ],
          // CRM still down after the graph's own retries -> a human takes over.
          onError: { target: "escalated" },
        },
      },
      awaitingApproval: {
        on: {
          APPROVED: { target: "resuming", actions: assign({ answer: "yes" as const }) },
          REJECTED: { target: "resuming", actions: assign({ answer: "no" as const }) },
        },
      },
      resuming: {
        invoke: {
          src: "resumeGraph",
          input: ({ context }) => ({ answer: context.answer }),
          onDone: [
            { guard: ({ event }) => event.output.approved, target: "resolved", actions: { type: "say", params: { text: "Your gems are back. Anything else?" } } },
            { target: "escalated" },
          ],
          onError: { target: "escalated" },
        },
      },
      // Final: the actor stops, so later events (even ASK_FOR_HUMAN) are ignored.
      // A new message after this is a new conversation.
      resolved: { type: "final" },
      escalated: { type: "final", entry: { type: "say", params: { text: "Connecting you to a human agent with a summary of this chat." } } },
    },
  });
}
