import assert from "node:assert/strict";
import { test } from "node:test";
import { compareVersions } from "../src/env.mjs";
import { AnswerError, eventTurnId, lastQuestion, reportFromTurn, userInputAnswers } from "../src/turns.mjs";

const req = (...ids) => ({ params: { questions: ids.map((id) => ({ id, question: id })) } });

test("userInputAnswers: plain text answers a single question", () => {
  assert.deepEqual(userInputAnswers(req("a"), " yes \n"), { a: { answers: ["yes"] } });
});

test("userInputAnswers: several questions need JSON with every id", () => {
  assert.deepEqual(userInputAnswers(req("a", "b"), '{"a": "x", "b": ["y", "z"]}'), { a: { answers: ["x"] }, b: { answers: ["y", "z"] } });
  assert.throws(() => userInputAnswers(req("a", "b"), '{"a": "x"}'), AnswerError);
  assert.throws(() => userInputAnswers(req("a", "b"), "x"), AnswerError);
});

test("reportFromTurn prefers review output, then the last final answer, then the last non-commentary message", () => {
  const m = (text, phase) => ({ type: "agentMessage", text, phase });
  assert.equal(reportFromTurn({ items: [m("a", "final_answer"), { type: "exitedReviewMode", review: "r" }] }), "r");
  assert.equal(reportFromTurn({ items: [m("a", "final_answer"), m("b", "commentary"), m("c", null)] }), "a");
  assert.equal(reportFromTurn({ items: [m("a", null), m("b", "commentary")] }), "a");
  assert.equal(reportFromTurn(undefined), "");
});

test("eventTurnId reads turn ids from turn and item events", () => {
  assert.equal(eventTurnId({ method: "turn/completed", params: { turn: { id: "t" } } }), "t");
  assert.equal(eventTurnId({ method: "item/completed", params: { turnId: "u" } }), "u");
  assert.equal(eventTurnId({ method: "thread/status/changed", params: {} }), null);
});

test("compareVersions orders numeric components", () => {
  assert.equal(compareVersions("0.164.0", "0.164.0"), 0);
  assert.equal(compareVersions("0.99.9", "0.164.0"), -1);
  assert.equal(compareVersions("1.0.0-alpha.1", "0.164.0"), 1);
});

test("lastQuestion: a question stays unanswered through later agent messages; any user message answers it", () => {
  const q = (title) => ({ type: "agentMessage", text: title, questions: [{ title }] });
  const u = { type: "userMessage", content: [{ type: "text", text: "yes" }] };
  const m = { type: "agentMessage", text: "working" };
  assert.equal(lastQuestion([{ items: [u, m] }]), null);
  assert.equal(lastQuestion([{ items: [u, q("a"), m] }]).reply, null);
  assert.equal(lastQuestion([{ items: [q("a")] }, { items: [u] }]).reply, u);
  const later = lastQuestion([{ items: [q("a"), u, q("b")] }]);
  assert.equal(later.question.text, "b");
  assert.equal(later.reply, null);
});
