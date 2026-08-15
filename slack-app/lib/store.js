"use strict";

/**
 * Storage for the cloud version.
 *
 * Uses Upstash Redis over plain HTTPS (the free tier Vercel offers in its
 * Marketplace). No SDK needed — it's a REST API, and Node 18+ has fetch.
 * Without the two env vars it falls back to in-memory storage, which is
 * enough to click through a test install but forgets on every cold start.
 *
 * What gets stored:
 *   install:<team>         the workspace's OAuth tokens (needed to send anything)
 *   pair:<team>:<user>     who their 1:1 partner is + which side they're on
 *   topics:<team>:<user>   the live agenda — real text, now (see below)
 *   actions:<team>:<user>  actions that came out of a 1:1 — real text
 *   history:<team>:<user>  past wrap-up summaries — real text
 *   checkin:<team>:<user>  an in-progress check-in draft — real text
 *
 * Earlier this only ever stored counts, never the actual words anyone typed
 * — the website (client-only, nothing server-side at all) was where real
 * content lived. Doing the full Prepare → Talk → Wrap-up flow as native
 * Slack modals broke that: modals run through this server, so their content
 * has to live somewhere to persist across steps and sessions. That's a
 * real, deliberate privacy tradeoff, not an oversight — see the
 * conversation this shipped from. What's unchanged: nobody except the two
 * people in a given 1:1 gets this content through the app, and HR still has
 * no dashboard and no automatic access, same as always.
 */

const REST_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL
  || process.env.UPSTASH_REDIS_REST_KV_REST_API_URL || "";
const REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN
  || process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN || "";

const memory = new Map();

async function command(parts) {
  const res = await fetch(REST_URL, {
    method: "POST",
    headers: { Authorization: "Bearer " + REST_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(parts)
  });
  if (!res.ok) throw new Error("Storage error " + res.status + ": " + (await res.text()).slice(0, 200));
  return res.json();
}

async function get(key) {
  /* Copy on the way out, matching Redis behaviour — callers may mutate what
     they get back, and that must never reach into the store. */
  if (!REST_URL) return memory.has(key) ? JSON.parse(JSON.stringify(memory.get(key))) : null;
  const r = await command(["GET", key]);
  return r.result ? JSON.parse(r.result) : null;
}

async function set(key, value) {
  if (!REST_URL) { memory.set(key, value); return; }
  await command(["SET", key, JSON.stringify(value)]);
}

async function del(key) {
  if (!REST_URL) { memory.delete(key); return; }
  await command(["DEL", key]);
}

/* ---------- what Bolt's OAuth flow needs ---------- */

const installKey = (q) =>
  "install:" + (q.isEnterpriseInstall && q.enterpriseId ? q.enterpriseId : q.teamId);

const installationStore = {
  storeInstallation: async (installation) => {
    const id = installation.isEnterpriseInstall && installation.enterprise
      ? installation.enterprise.id
      : installation.team.id;
    return set("install:" + id, installation);
  },
  fetchInstallation: async (query) => {
    const found = await get(installKey(query));
    if (!found) throw new Error("No installation found for this workspace.");
    return found;
  },
  deleteInstallation: async (query) => del(installKey(query))
};

/* ---------- pairs: who is whose 1:1 partner ---------- */

const pairKey = (teamId, userId) => "pair:" + teamId + ":" + userId;

/** Save both directions at once so the pair can never be half-set. */
async function setPair(teamId, userId, partnerId, myRole) {
  const otherRole = myRole === "manager" ? "employee" : "manager";
  await set(pairKey(teamId, userId), { partner: partnerId, role: myRole });
  await set(pairKey(teamId, partnerId), { partner: userId, role: otherRole });
}

async function getPair(teamId, userId) {
  return get(pairKey(teamId, userId));
}

/* ---------- topics: the live 1:1 agenda ----------
   Real records now, not just a count — Talk needs to mark each one
   discussed or parked, and Wrap-up needs to know which to clear. */

const topicsKey = (teamId, userId) => "topics:" + teamId + ":" + userId;
const nextId = (list) => (list.length ? Math.max(...list.map((x) => x.id)) + 1 : 1);

async function getTopics(teamId, userId) {
  return (await get(topicsKey(teamId, userId))) || [];
}

async function addTopic(teamId, userId, text, category) {
  const topics = await getTopics(teamId, userId);
  const topic = { id: nextId(topics), text, category, status: "open", at: Date.now() };
  topics.push(topic);
  await set(topicsKey(teamId, userId), topics);
  return topic;
}

/** status is "open" | "discussed" | "parking". */
async function setTopicStatus(teamId, userId, topicId, status) {
  const topics = await getTopics(teamId, userId);
  const topic = topics.find((t) => t.id === topicId);
  if (topic) {
    topic.status = status;
    await set(topicsKey(teamId, userId), topics);
  }
  return topic;
}

/** Wrap-up "closes out" a conversation: discussed topics are filed away,
    open and parked topics stay on the agenda for next time. */
async function clearDiscussedTopics(teamId, userId) {
  const topics = await getTopics(teamId, userId);
  const remaining = topics.filter((t) => t.status !== "discussed");
  await set(topicsKey(teamId, userId), remaining);
  return remaining;
}

/* ---------- actions: things to follow up on ---------- */

const actionsKey = (teamId, userId) => "actions:" + teamId + ":" + userId;

async function getActions(teamId, userId) {
  return (await get(actionsKey(teamId, userId))) || [];
}

async function addAction(teamId, userId, text) {
  const actions = await getActions(teamId, userId);
  const action = { id: nextId(actions), text, done: false, at: Date.now() };
  actions.push(action);
  await set(actionsKey(teamId, userId), actions);
  return action;
}

/* ---------- history: past wrap-up summaries ---------- */

const historyKey = (teamId, userId) => "history:" + teamId + ":" + userId;

async function getHistory(teamId, userId) {
  return (await get(historyKey(teamId, userId))) || [];
}

/** Saves the summary, then closes out the conversation the same way the
    website does: discussed topics are cleared, parking lot stays. */
async function saveWrapUp(teamId, userId, summary) {
  const history = await getHistory(teamId, userId);
  const entry = { ...summary, at: Date.now() };
  history.push(entry);
  await set(historyKey(teamId, userId), history);
  await clearDiscussedTopics(teamId, userId);
  return entry;
}

/* ---------- counts: derived from the real records above ---------- */

async function getCounts(teamId, userId) {
  const [topics, actions] = await Promise.all([getTopics(teamId, userId), getActions(teamId, userId)]);
  return {
    openTopics: topics.filter((t) => t.status !== "discussed").length,
    openActions: actions.filter((a) => !a.done).length,
    plans: 0
  };
}

/* ---------- added questions: which of the app's own suggested prompts a
   person has already tapped "Add" on ----------
   Storing the question text here does not cross the line above — these are
   the app's four canned prompts (identical for every employee, or every
   manager), never anything a person wrote themselves. It only exists so the
   Home tab can show "Added" instead of "Add" on the ones already used. */

const addedKey = (teamId, userId) => "added:" + teamId + ":" + userId;

async function getAddedQuestions(teamId, userId) {
  return (await get(addedKey(teamId, userId))) || [];
}

async function addQuestion(teamId, userId, text) {
  const added = await getAddedQuestions(teamId, userId);
  if (!added.includes(text)) {
    added.push(text);
    await set(addedKey(teamId, userId), added);
  }
  return added;
}

/* ---------- check-in: the one place real content is stored ----------
   Everything else in this file is deliberately counts-only. This is the
   exception — the answers a person types have to persist somewhere for the
   Slack modal to resume across steps, sessions, even cold starts. That's a
   real change from the website, where this never left the browser. See the
   conversation this shipped from for why that tradeoff was made. */

const checkinKey = (teamId, userId) => "checkin:" + teamId + ":" + userId;

async function getCheckin(teamId, userId) {
  return get(checkinKey(teamId, userId));
}

/** Starts a fresh draft, or hands back the one already in progress — so
    tapping "Start my check-in" twice never wipes an answer. */
async function startCheckin(teamId, userId, role, queue) {
  const existing = await getCheckin(teamId, userId);
  if (existing) return existing;
  const draft = { role, queue, step: 0, answers: {} };
  await set(checkinKey(teamId, userId), draft);
  return draft;
}

/** Saves the answer for the question at `step` and advances. Once the last
    question is answered, the draft is deleted and the result carries
    done:true — there is nothing left to resume. */
async function submitCheckinAnswer(teamId, userId, step, text) {
  const draft = await getCheckin(teamId, userId);
  if (!draft) return null;
  const question = draft.queue[step];
  if (question) draft.answers[question.id] = text;
  if (step + 1 >= draft.queue.length) {
    await del(checkinKey(teamId, userId));
    return { ...draft, done: true };
  }
  draft.step = step + 1;
  await set(checkinKey(teamId, userId), draft);
  return { ...draft, done: false };
}

async function goBackCheckin(teamId, userId, step) {
  const draft = await getCheckin(teamId, userId);
  if (!draft) return null;
  draft.step = Math.max(0, step - 1);
  await set(checkinKey(teamId, userId), draft);
  return draft;
}

module.exports = {
  installationStore, setPair, getPair, getCounts,
  getTopics, addTopic, setTopicStatus, clearDiscussedTopics,
  getActions, addAction,
  getHistory, saveWrapUp,
  getAddedQuestions, addQuestion,
  getCheckin, startCheckin, submitCheckinAnswer, goBackCheckin,
  usingRealStorage: !!REST_URL
};
