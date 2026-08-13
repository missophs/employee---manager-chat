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

/* The bot token is the one that cannot be worked around: without it nothing
   can be sent at all. The app-level token is only needed to RECEIVE — button
   clicks, modal submits, slash commands. Sending the Home tab and the pings
   works on the bot token alone, so a missing app token degrades the app
   rather than killing it. */

if (!BOT_TOKEN) {
  console.error(
    "\nMissing SLACK_BOT_TOKEN — starts with xoxb-, from the OAuth & Permissions page.\n\n" +
    "Copy .env.example to .env, paste it in, then run npm start again.\n" +
    "To see the Block Kit layouts without any of this, run: npm run preview\n"
  );
  process.exit(1);
}

/* Bolt throws while being constructed if socketMode is on without an app
   token, so this has to be checked before the App below is built — not at
   start() time. */
if (!APP_TOKEN) {
  console.error(
    "\nMissing SLACK_APP_TOKEN, so Slack cannot send anything back: buttons,\n" +
    "the modal and /pulse need it. Generate one at Basic Information →\n" +
    "App-Level Tokens with the connections:write scope.\n\n" +
    "Sending does not need it. These work on the bot token alone:\n\n" +
    "  node push-home.js    publish the Home tab\n" +
    "  node send-all.js     send one of every ping\n" +
    "  npm run preview      print the Block Kit JSON, no Slack at all\n"
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

/* Who is paired with whom. A real deployment reads this from the database;
   here it is the one pair in this workspace. Without it nobody can be
   notified, because the app has no idea who anyone's counterpart is. */
const PAIRS = {
  U0BQQTKLQ1E: "U0BPSUWKGRK",
  U0BPSUWKGRK: "U0BQQTKLQ1E"
};

const counterpartOf = (userId) => PAIRS[userId] || null;

/* Which side of the 1:1 each person is on — it decides which example
   questions their Home tab suggests. Swap the values if this is backwards. */
const ROLES = {
  U0BQQTKLQ1E: "employee",  // Melissa Weiss
  U0BPSUWKGRK: "manager"    // Monte Montoya
};

/* Real names for the one pair in this workspace, so nothing ever renders a
   made-up person. The cloud version reads these from Slack profiles. */
const NAMES = {
  U0BQQTKLQ1E: "Melissa Weiss",
  U0BPSUWKGRK: "Monte Montoya"
};

/* Counts for one person only. Anything the other person wrote is theirs, so
   it is filtered out here rather than summed across the workspace. */
const summary = (name, userId) => {
  const mine = (list) => list.filter((item) => item.by === userId);
  return {
    name,
    role: ROLES[userId] || "employee",
    openTopics: mine(state.topics).length,
    openActions: mine(state.actions).length,
    plans: mine(state.plans).length,
    when: null
  };
};

/* ---------- App Home: the tab in the sidebar ---------- */

app.event("app_home_opened", async ({ event, client, logger }) => {
  if (event.tab !== "home") return;   // also fires for the Messages tab
  try {
    const profile = await client.users.info({ user: event.user });
    const name = profile.user?.profile?.first_name || profile.user?.name || "there";
    await client.views.publish({
      user_id: event.user,
      view: homeTab(summary(name, event.user))
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
  const values = view.state.values;
  const text = values.topic?.text?.value?.trim();
  const category = values.category?.value?.selected_option?.value;

  /* Validate before acknowledging. Slack only accepts an error response on
     the first ack, so a blank submission has to be caught here or it closes
     the modal and silently discards what was typed. */
  if (!text) {
    await ack({
      response_action: "errors",
      errors: { topic: "Add a few words about what you want to discuss." }
    });
    return;
  }

  await ack();

  state.topics.push({ text, category, by: body.user.id, at: new Date().toISOString() });

  try {
    /* Refresh their own Home tab. */
    const profile = await client.users.info({ user: body.user.id });
    const name = profile.user?.profile?.first_name || profile.user?.name || "there";
    await client.views.publish({
      user_id: body.user.id,
      view: homeTab(summary(name, body.user.id))
    });

    /* Ping the other person. This is the route: whoever added the topic, the
       counterpart hears about it — employee to manager and manager back the
       other way. The ping carries the count and the date, never the text.

       Kept in its own try: if the counterpart cannot be reached, that must not
       cost the author the confirmation of their own topic below. */
    const other = counterpartOf(body.user.id);
    if (other) {
      try {
        await notify(other, "topic", {
          from: name,
          openTopics: state.topics.filter((t) => t.by === body.user.id).length,
          when: "not in the diary yet"
        });
      } catch (error) {
        logger.error("Could not notify the counterpart:", error);
      }
    }

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
app.action("open_handbook", async ({ ack }) => { await ack(); });

/* ---------- /pulse: send yourself any ping, for testing ---------- */

/* Sample data for /pulse test pings. `from` is filled in at send time with the
   caller's real counterpart, so no invented names appear anywhere. */
const SAMPLE = {
  topic:       { openTopics: 2, when: "Thu, Aug 13 at 10:00 AM" },
  upcoming:    { openTopics: 2, when: "Thu, Aug 13 at 10:00 AM" },
  feedback:    {},
  request:     {},
  development: { plans: 3 },
  action:      { open: 2 },
  wrap:        {}
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
    const other = counterpartOf(command.user_id);
    const from = (other && NAMES[other]) || "Your 1:1 partner";
    const payload = build(kind, { ...(SAMPLE[kind] || {}), from });
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

async function start() {
  await app.start();
  console.log("Performance Pulse is connected to Slack.");
  console.log("Try /pulse in any channel, or click the app in your sidebar for the Home tab.");
  console.log(`Pings available: ${Object.keys(PINGS).join(", ")}`);
}

/* Only connect when run directly. Importing this file for notify() must not
   open a socket as a side effect. */
if (require.main === module) {
  start().catch((error) => {
    const reason = error?.data?.error || error?.message || String(error);
    console.error(`\nCould not connect to Slack: ${reason}`);
    if (reason === "invalid_auth") {
      console.error(
        "That is the app-level token. Regenerate it at Basic Information →\n" +
        "App-Level Tokens with the connections:write scope, and check that\n" +
        "Socket Mode is switched on.\n"
      );
    }
    process.exit(1);
  });
}

module.exports = { app, notify };
