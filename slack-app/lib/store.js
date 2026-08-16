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
 *   topics:<team>:<user>   the live agenda — real text, now (see below).
 *                          Always keyed by the EMPLOYEE side of the pair —
 *                          both people read/write the same bucket, resolved
 *                          via sharedOwnerId() below.
 *   actions:<team>:<user>  actions that came out of a 1:1 — real text. Same
 *                          employee-keyed sharing as topics.
 *   history:<team>:<user>  past wrap-up summaries — real text. Same
 *                          employee-keyed sharing as topics.
 *   checkin:<team>:<user>  an in-progress check-in draft — real text. NOT
 *                          shared: each person answers their own separate
 *                          questionnaire (employee vs. manager questions),
 *                          so this stays keyed by whoever is actually typing.
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

if (!REST_URL) {
  console.warn(
    "[store] No Redis env vars found (UPSTASH_REDIS_REST_URL / KV_REST_API_URL) — " +
    "using in-memory storage, which is wiped on every cold start. Data will appear to vanish."
  );
}

const COMMAND_TIMEOUT_MS = 10_000;

async function command(parts) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), COMMAND_TIMEOUT_MS);
  try {
    const res = await fetch(REST_URL, {
      method: "POST",
      headers: { Authorization: "Bearer " + REST_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify(parts),
      signal: controller.signal
    });
    if (!res.ok) throw new Error("Storage error " + res.status + ": " + (await res.text()).slice(0, 200));
    return res.json();
  } catch (error) {
    if (error.name === "AbortError") throw new Error("Storage request timed out after " + COMMAND_TIMEOUT_MS + "ms");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- per-key write serialization ----------
   addTopic/setTopicStatus/etc. are all read-full-list, mutate, write-full-list
   — two calls for the same key in the same warm serverless instance (a fast
   double-tap) can otherwise both read the same snapshot and the second write
   silently drops the first. This serializes same-key writes within one
   process. It does NOT protect against two different Vercel instances
   racing on the same key at the same moment — that needs a Redis-side lock
   (WATCH/MULTI or a Lua script), deliberately not added here since it can't
   be verified without a live Redis instance. Given this app pairs exactly
   two people, same-instance double-taps are the realistic case; cross-instance
   collisions are a known, accepted gap. */
const locks = new Map();

function withLock(key, fn) {
  const prior = locks.get(key) || Promise.resolve();
  const settled = prior.then(fn, fn);
  const cleared = settled.then(() => {}, () => {});
  locks.set(key, cleared);
  /* Free the entry once nothing is queued behind it — otherwise `locks`
     grows by one entry per distinct key for the life of the process, which
     matters in app.js (long-running Socket Mode), not just the short-lived
     serverless instances. Only delete if nothing newer has replaced us. */
  cleared.then(() => { if (locks.get(key) === cleared) locks.delete(key); });
  return settled;
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

/** Save both directions — if the second write fails, roll back the first
    rather than leaving one side pointing at a partner who doesn't point back. */
async function setPair(teamId, userId, partnerId, myRole) {
  const otherRole = myRole === "manager" ? "employee" : "manager";
  const mineKey = pairKey(teamId, userId);
  const previousMine = await get(mineKey);
  await set(mineKey, { partner: partnerId, role: myRole });
  try {
    await set(pairKey(teamId, partnerId), { partner: userId, role: otherRole });
  } catch (error) {
    try {
      if (previousMine) await set(mineKey, previousMine);
      else await del(mineKey);
    } catch (rollbackError) {
      console.error("[store] setPair rollback also failed — pair may be half-set:", rollbackError);
    }
    throw error;
  }
}

async function getPair(teamId, userId) {
  return get(pairKey(teamId, userId));
}

/* ---------- shared ownership: who a pair's agenda/actions/history live under ----------
   Topics, actions, and wrap-up history used to be keyed by whoever was
   acting (body.user.id) — which meant they were never actually shared: an
   employee's topics lived under the employee's own key, a manager's Talk
   modal read the manager's own (different, unrelated) key, and neither
   side could see what the other added. Every pair has exactly one
   employee, so that person's ID is now the single canonical bucket both
   sides read and write. */

async function sharedOwnerId(teamId, userId) {
  const pair = await getPair(teamId, userId);
  return pair && pair.role === "manager" ? pair.partner : userId;
}

/** One-time cleanup for a manager who already saved something under their
    own key before this fix existed: fold it into the canonical (employee)
    bucket instead of leaving it invisible forever. Guarded by a marker key
    so repeated calls (every click) don't re-merge it. No-ops instantly for
    an employee (ownerId === userId) or once nothing legacy is left. */
async function migrateLegacyOnce(teamId, userId, ownerId, keyFn, merge) {
  if (userId === ownerId) return;
  const legacyKey = keyFn(teamId, userId);
  const markerKey = "migrated:" + legacyKey;
  if (await get(markerKey)) return;
  try {
    const legacy = await get(legacyKey);
    if (legacy && legacy.length) {
      const ownerKey = keyFn(teamId, ownerId);
      const canonical = (await get(ownerKey)) || [];
      await set(ownerKey, merge(canonical, legacy));
      console.warn(`[store] Migrated ${legacy.length} legacy entr${legacy.length === 1 ? "y" : "ies"} from ${legacyKey} into ${ownerKey}`);
    }
  } catch (error) {
    console.error("[store] Legacy migration failed for", legacyKey, "— leaving it in place:", error);
    return; // don't set the marker; try again next call rather than giving up silently
  }
  await set(markerKey, true);
}

/* ---------- topics: the live 1:1 agenda ----------
   Real records now, not just a count — Talk needs to mark each one
   discussed or parked, and Wrap-up needs to know which to clear. */

const topicsKey = (teamId, userId) => "topics:" + teamId + ":" + userId;
/* A loop instead of Math.max(...list.map(...)) — spreading a large array
   into Math.max can throw "Maximum call stack size exceeded"; a loop has no
   such limit and returns the same result for every normal-sized list. */
const nextId = (list) => list.reduce((max, x) => Math.max(max, x.id), 0) + 1;

/** Renumbers legacy entries past whatever's already in the canonical list,
    so two people's ids never collide when a manager's stray data merges in. */
const mergeWithFreshIds = (canonical, legacy) => {
  let next = nextId(canonical);
  return canonical.concat(legacy.map((item) => ({ ...item, id: next++ })));
};

async function topicsOwner(teamId, userId) {
  const ownerId = await sharedOwnerId(teamId, userId);
  await migrateLegacyOnce(teamId, userId, ownerId, topicsKey, mergeWithFreshIds);
  return ownerId;
}

async function getTopics(teamId, userId) {
  const ownerId = await topicsOwner(teamId, userId);
  return (await get(topicsKey(teamId, ownerId))) || [];
}

async function addTopic(teamId, userId, text, category) {
  const ownerId = await topicsOwner(teamId, userId);
  return withLock(topicsKey(teamId, ownerId), async () => {
    const topics = (await get(topicsKey(teamId, ownerId))) || [];
    const topic = { id: nextId(topics), text, category, status: "open", at: Date.now() };
    topics.push(topic);
    await set(topicsKey(teamId, ownerId), topics);
    return topic;
  });
}

/** status is "open" | "discussed" | "parking". */
async function setTopicStatus(teamId, userId, topicId, status) {
  const ownerId = await topicsOwner(teamId, userId);
  return withLock(topicsKey(teamId, ownerId), async () => {
    const topics = (await get(topicsKey(teamId, ownerId))) || [];
    const topic = topics.find((t) => t.id === topicId);
    if (topic) {
      topic.status = status;
      await set(topicsKey(teamId, ownerId), topics);
    }
    return topic;
  });
}

/** Wrap-up "closes out" a conversation: discussed topics are filed away,
    open and parked topics stay on the agenda for next time. */
async function clearDiscussedTopics(teamId, userId) {
  const ownerId = await topicsOwner(teamId, userId);
  return withLock(topicsKey(teamId, ownerId), async () => {
    const topics = (await get(topicsKey(teamId, ownerId))) || [];
    const remaining = topics.filter((t) => t.status !== "discussed");
    await set(topicsKey(teamId, ownerId), remaining);
    return remaining;
  });
}

/* ---------- actions: things to follow up on ---------- */

const actionsKey = (teamId, userId) => "actions:" + teamId + ":" + userId;

async function actionsOwner(teamId, userId) {
  const ownerId = await sharedOwnerId(teamId, userId);
  await migrateLegacyOnce(teamId, userId, ownerId, actionsKey, mergeWithFreshIds);
  return ownerId;
}

async function getActions(teamId, userId) {
  const ownerId = await actionsOwner(teamId, userId);
  return (await get(actionsKey(teamId, ownerId))) || [];
}

async function addAction(teamId, userId, text) {
  const ownerId = await actionsOwner(teamId, userId);
  return withLock(actionsKey(teamId, ownerId), async () => {
    const actions = (await get(actionsKey(teamId, ownerId))) || [];
    const action = { id: nextId(actions), text, done: false, at: Date.now() };
    actions.push(action);
    await set(actionsKey(teamId, ownerId), actions);
    return action;
  });
}

/* ---------- history: past wrap-up summaries ---------- */

const historyKey = (teamId, userId) => "history:" + teamId + ":" + userId;
const mergeByAppending = (canonical, legacy) => canonical.concat(legacy);

async function historyOwner(teamId, userId) {
  const ownerId = await sharedOwnerId(teamId, userId);
  await migrateLegacyOnce(teamId, userId, ownerId, historyKey, mergeByAppending);
  return ownerId;
}

async function getHistory(teamId, userId) {
  const ownerId = await historyOwner(teamId, userId);
  return (await get(historyKey(teamId, ownerId))) || [];
}

/** Keeps the most recent summaries only — real Redis values have a size
    limit, and nobody needs to page through years of wrap-ups in a modal. */
const HISTORY_LIMIT = 200;

/** Saves the summary, then closes out the conversation the same way the
    website does: discussed topics are cleared, parking lot stays. */
async function saveWrapUp(teamId, userId, summary) {
  const ownerId = await historyOwner(teamId, userId);
  const entry = await withLock(historyKey(teamId, ownerId), async () => {
    const history = (await get(historyKey(teamId, ownerId))) || [];
    const e = { ...summary, at: Date.now() };
    history.push(e);
    if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT);
    await set(historyKey(teamId, ownerId), history);
    return e;
  });
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
  return withLock(addedKey(teamId, userId), async () => {
    const added = await getAddedQuestions(teamId, userId);
    if (!added.includes(text)) {
      added.push(text);
      await set(addedKey(teamId, userId), added);
    }
    return added;
  });
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
  return withLock(checkinKey(teamId, userId), async () => {
    const existing = await getCheckin(teamId, userId);
    if (existing) return existing;
    const draft = { role, queue, step: 0, answers: {} };
    await set(checkinKey(teamId, userId), draft);
    return draft;
  });
}

/** Saves the answer for the question at `step` and advances. Once the last
    question is answered, the draft is deleted and the result carries
    done:true — there is nothing left to resume. */
async function submitCheckinAnswer(teamId, userId, step, text) {
  return withLock(checkinKey(teamId, userId), async () => {
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
  });
}

async function goBackCheckin(teamId, userId, step) {
  return withLock(checkinKey(teamId, userId), async () => {
    const draft = await getCheckin(teamId, userId);
    if (!draft) return null;
    draft.step = Math.max(0, step - 1);
    await set(checkinKey(teamId, userId), draft);
    return draft;
  });
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
