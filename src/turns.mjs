// Pure helpers over app-server turn items and question payloads.

export class AnswerError extends Error {}

// The last user-visible message of a turn, if it is an unanswered question
export function pendingQuestion(turn) {
  const last = [...(turn?.items || [])].reverse().find((it) => it.type === "agentMessage" || it.type === "userMessage") || {};
  return last.type === "agentMessage" && last.questions?.length ? last : null;
}

// Final report of a completed turn read back with thread/read: review output, else the final answer,
// else the last agent message not marked as commentary
export function reportFromTurn(turn) {
  const items = turn?.items || [];
  const review = items.filter((it) => it.type === "exitedReviewMode").at(-1);
  if (review) return review.review || "";
  const msgs = items.filter((it) => it.type === "agentMessage");
  const final = msgs.filter((it) => it.phase === "final_answer").at(-1) || msgs.filter((it) => it.phase !== "commentary").at(-1);
  return final?.text || "";
}

// Blocking questions in the same title/options shape as async questions, keeping ids for the answer
export function userInputQuestions(req) {
  return (req.params.questions || []).map((q) => ({
    id: q.id,
    title: q.header && q.header !== q.question ? `${q.header}: ${q.question}` : q.question,
    options: (q.options || []).map((o) => (o.description ? `${o.label} (${o.description})` : o.label)),
    allowOther: Boolean(q.isOther),
  }));
}

// Answer file: the answer itself for a single question; JSON {"<question id>": "answer" | ["answer", ...]} for several
export function userInputAnswers(req, text) {
  const qs = req.params.questions || [];
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {}
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const missing = qs.filter((q) => !(q.id in parsed)).map((q) => q.id);
    if (missing.length) throw new AnswerError(`answer JSON is missing question ids: ${missing.join(", ")} (Codex is still waiting; fix the file and --answer again)`);
    return Object.fromEntries(qs.map((q) => [q.id, { answers: [].concat(parsed[q.id]).map(String) }]));
  }
  if (qs.length !== 1) {
    throw new AnswerError(`there are ${qs.length} questions; write the answer file as JSON {"<question id>": "answer"} (ids are in the previous output or questions.json; Codex is still waiting)`);
  }
  return { [qs[0].id]: { answers: [text.trim()] } };
}

// Turn id an event belongs to, if the event carries one
export function eventTurnId(m) {
  const p = m.params || {};
  if (m.method === "turn/started" || m.method === "turn/completed") return p.turn?.id ?? null;
  return p.turnId ?? null;
}

export function reviewTarget({ base, commit }, focus) {
  if (focus) {
    const scope = base ? `changes relative to ${base} (git diff ${base}...HEAD)`
      : commit ? `the changes introduced by commit ${commit}` : "uncommitted changes (git diff HEAD plus untracked files)";
    return { type: "custom", instructions: `Review scope: ${scope}.\n\n${focus}` };
  }
  if (base) return { type: "baseBranch", branch: base };
  if (commit) return { type: "commit", sha: commit };
  return { type: "uncommittedChanges" };
}
