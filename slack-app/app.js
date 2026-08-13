"use strict";

/**
 * Performance Pulse — Slack app.
 *
 * Runs in Socket Mode, which means it needs no public web address and no
 * hosting to try out. That matters: you can run this on your own laptop and
 * see real Slack messages arrive. Hosting only becomes necessary when other
 * companies install it, which is the Marketplace step.
 *
 *   1. cp .env.example .env
 *   2. paste your two tokens into .env
 *   3. npm install
 *   4. npm start
 *
 * Nothing here stores performance data. It sends notices that something
 * happened, and links back to the app where the substance lives.
 */

require("dotenv").config();

const { App } = require("@slack/bolt");
const { build, PINGS, homeTab, addTopicModal } = require("./blocks");

/* ---------- config ---------- */

const BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const APP_TOKEN = process.env.SLACK_APP_TOKEN;

if (!BOT_TOKEN || !APP_TOKEN) {
  console.error(
    "\nMissing tokens.\n\n" +
    "  SLACK_BOT_TOKEN  starts with xoxb-   (OAuth & Permissions page)\n" +
    "  SLACK_APP_TOKEN  starts with xapp-   (Basic Information → App-Level Tokens,\n" +
    "                                        needs the connections:write scope)\n\n" +
    "Copy .env.example to .env, paste both in, then run npm start again.\n" +
    "To see the Block Kit layouts without any of this, run: npm run preview\n"
  );
  process.exit(1);
}

const app = new App({
  token: BOT_TOKEN,
  appToken: APP_TOKEN,
  socketMode: true
});

/* ---------- in-memory demo state ----------
   A real deployment replaces this with a database. Deliberately not written
   to disk here: this is a prototype, and performance data should not pile up
   on a laptop by accident. */

const state = {
  topics: [],
  actions: [],
  plans: []
};

const summary = (name) => ({
  name,
  openTopics: state.topics.length,
  openActions: state.actions.length,
  plans: state.plans.length,
  when: null
});

/* ---------- App Home: the tab in the sidebar ---------- */

app.event("app_home_opened", async ({ event, client, logger }) => {
  try {
    const profile = await client.users.info({ user: event.user });
    const name = profile.user?.profile?.first_name || profile.user?.name || "there";
    await client.views.publish({
      user_id: event.user,
      view: homeTab(summary(name))
    });
  } catch (error) {
    logger.error("Could not publish App Home:", error);
  }
});

/* ---------- the add-a-topic modal ---------- */

app.action("add_topic", async ({ ack, body, client, logger }) => {
  await ack();
  try {
    await client.views.open({
      trigger_id: body.trigger_id,
      view: addTopicModal()
    });
  } catch (error) {
    logger.error("Could not open the modal:", error);
  }
});

app.view("add_topic_modal", async ({ ack, view, body, client, logger }) => {
  await ack();
  const values = view.state.values;
  const text = values.topic?.text?.value?.trim();
  const category = values.category?.value?.selected_option?.value;
  if (!text) return;

  state.topics.push({ text, category, by: body.user.id, at: new Date().toISOString() });

  try {
    /* Refresh their own Home tab. */
    const profile = await client.users.info({ user: body.user.id });
    const name = profile.user?.profile?.first_name || profile.user?.name || "there";
    await client.views.publish({
      user_id: body.user.id,
      view: homeTab(summary(name))
    });

    /* Confirm to the person who added it. Their own text is theirs to see. */
    await client.chat.postMessage({
      channel: body.user.id,
      text: "Added to your 1:1 agenda.",
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: ":white_check_mark: Added to your 1:1 agenda." } },
        { type: "context", elements: [{ type: "mrkdwn", text: `${category || "Other"} · only your manager can see this` }] }
      ]
    });
  } catch (error) {
    logger.error("Could not handle the submission:", error);
  }
});

/* The open-app button is a link. Slack still sends an event; acknowledge it
   so the button does not show a warning triangle. */
app.action("open_app", async ({ ack }) => { await ack(); });

/* ---------- /pulse: send yourself any ping, for testing ---------- */

const SAMPLE = {
  topic:       { from: "Alex Kim", openTopics: 2, when: "Thu, Aug 13 at 10:00 AM" },
  upcoming:    { from: "Alex Kim", openTopics: 2, when: "Thu, Aug 13 at 10:00 AM" },
  feedback:    { from: "Alex Kim" },
  request:     { from: "Alex Kim" },
  development: { from: "Alex Kim", plans: 3 },
  action:      { open: 2 },
  wrap:        { from: "Alex Kim" }
};

app.command("/pulse", async ({ command, ack, client, respond, logger }) => {
  await ack();
  const kind = (command.text || "").trim() || "topic";

  if (!PINGS[kind]) {
    await respond({
      response_type: "ephemeral",
      text: `I don't have a ping called "${kind}". Try: ${Object.keys(PINGS).join(", ")}`
    });
    return;
  }

  try {
    const payload = build(kind, SAMPLE[kind] || {});
    await client.chat.postMessage({
      channel: command.user_id,
      text: payload.text,
      blocks: payload.blocks
    });
  } catch (error) {
    logger.error("Could not send the ping:", error);
    await respond({ response_type: "ephemeral", text: "That didn't send. Check the logs." });
  }
});

/* ---------- the function the rest of the product would call ---------- */

/**
 * Send one ping to one person.
 * @param {string} userId  a Slack user id, e.g. U01234567
 * @param {string} kind    one of the keys in PINGS
 * @param {object} data    values for that ping
 */
async function notify(userId, kind, data = {}) {
  const payload = build(kind, data);
  return app.client.chat.postMessage({
    token: BOT_TOKEN,
    channel: userId,
    text: payload.text,
    blocks: payload.blocks
  });
}

/* ---------- go ---------- */

(async () => {
  await app.start();
  console.log("Performance Pulse is connected to Slack.");
  console.log("Try /pulse in any channel, or click the app in your sidebar for the Home tab.");
  console.log(`Pings available: ${Object.keys(PINGS).join(", ")}`);
})();

module.exports = { app, notify };
