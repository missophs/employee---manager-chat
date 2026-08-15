"use strict";

/**
 * Storage for the cloud version.
 *
 * Uses Upstash Redis over plain HTTPS (the free tier Vercel offers in its
 * Marketplace). No SDK needed — it's a REST API, and Node 18+ has fetch.
 * Without the two env vars it falls back to in-memory storage, which is
 * enough to click through a test install but forgets on every cold start.
 *
 * What gets stored, deliberately:
 *   install:<team>        the workspace's OAuth tokens (needed to send anything)
 *   pair:<team>:<user>    who their 1:1 partner is + which side they're on
 *   counts:<team>:<user>  numbers only — open topics, actions, plans
 *
 * What never gets stored here: topic text, feedback, goals, anything a person
 * wrote about their performance. The detail lives in the web app. This
 * database could be dumped in its entirety and reveal only who talks to whom
 * and how often — that is the product's privacy promise, kept at the
 * database layer where it cannot be worked around.
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

/* ---------- counts: numbers only, never content ---------- */

const countsKey = (teamId, userId) => "counts:" + teamId + ":" + userId;

async function getCounts(teamId, userId) {
  return (await get(countsKey(teamId, userId))) || { openTopics: 0, openActions: 0, plans: 0 };
}

async function bumpTopics(teamId, userId) {
  const c = await getCounts(teamId, userId);
  c.openTopics += 1;
  await set(countsKey(teamId, userId), c);
  return c;
}

module.exports = {
  installationStore, setPair, getPair, getCounts, bumpTopics,
  usingRealStorage: !!REST_URL
};
