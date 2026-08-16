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
const { build, PINGS, homeTab, addTopicModal, checkinModal, talkModal, wrapModal } = require("./blocks");
const store = require("./lib/store");
const { queueFor } = require("./lib/questions");

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

app.error(async (error) => {
  console.error("Unhandled Bolt error:", error);
});

/* Storage is the same lib/store.js the cloud version uses — it falls back to
   an in-memory Map automatically when no Redis env vars are set, which is
   exactly right for local testing: real Prepare/Talk/Wrap-up behavior, wiped
   on every restart instead of piling up on a laptop by accident. */
const TEAM_ID = "local";

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

/* Counts for one person only, read from the same store Talk and Wrap-up use
   — so what Home tab shows always matches what those modals actually have. */
async function summary(name, userId) {
  const [counts, addedQuestions, draft] = await Promise.all([
    store.getCounts(TEAM_ID, userId),
    store.getAddedQuestions(TEAM_ID, userId),
    store.getCheckin(TEAM_ID, userId)
  ]);
  return {
    name,
    role: ROLES[userId] || "employee",
    openTopics: counts.openTopics,
    openActions: counts.openActions,
    plans: counts.plans,
    when: null,
    addedQuestions,
    checkin: draft ? { step: draft.step, total: draft.queue.length } : null
  };
}

/* ---------- App Home: the tab in the sidebar ---------- */

app.event("app_home_opened", async ({ event, client, logger }) => {
  if (event.tab !== "home") return;   // also fires for the Messages tab
  try {
    const profile = await client.users.info({ user: event.user });
    const name = profile.user?.profile?.first_name || profile.user?.name || "there";
    await client.views.publish({
      user_id: event.user,
      view: homeTab(await summary(name, event.user))
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

/* Shared by both ways a topic gets added: the "Add a topic" modal (typed,
   with a category) and tapping "Add" on a suggested question (no category —
   it's already one of the app's own prompts). `text` is only set for the
   suggested-question path — it's how the Home tab recognizes which ones to
   render as already added. */
async function addTopicAndNotify(client, body, category, logger, text) {
  await store.addTopic(TEAM_ID, body.user.id, text, category);
  if (category === "Suggested question") await store.addQuestion(TEAM_ID, body.user.id, text);

  const profile = await client.users.info({ user: body.user.id });
  const name = profile.user?.profile?.first_name || profile.user?.name || "there";
  try {
    await client.views.publish({
      user_id: body.user.id,
      view: homeTab(await summary(name, body.user.id))
    });
  } catch (error) {
    logger.error("Topic was saved but the Home tab could not refresh:", error);
  }

  /* Ping the other person. Kept in its own try: if the counterpart cannot be
     reached, that must not cost the author the confirmation below. */
  const other = counterpartOf(body.user.id);
  if (other) {
    try {
      const counts = await store.getCounts(TEAM_ID, body.user.id);
      await notify(other, "topic", {
        from: name,
        openTopics: counts.openTopics,
        when: "not in the diary yet"
      });
    } catch (error) {
      logger.error("Could not notify the counterpart:", error);
    }
  }

  try {
    await client.chat.postMessage({
      channel: body.user.id,
      text: "Added to your 1:1 agenda.",
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: ":white_check_mark: Added to your 1:1 agenda." } },
        { type: "context", elements: [{ type: "mrkdwn", text: `${category} · only your manager can see this` }] }
      ]
    });
  } catch (error) {
    logger.error("Topic was saved but the confirmation message failed to send:", error);
  }
}

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
  try {
    await addTopicAndNotify(client, body, category || "Other", logger, text);
  } catch (error) {
    logger.error("Could not handle the submission:", error);
  }
});

/* Tapping "Add" next to a suggested question — one click, no modal. */
app.action("add_example", async ({ ack, body, client, logger }) => {
  await ack();
  try {
    const question = body.actions[0].value;
    await addTopicAndNotify(client, body, "Suggested question", logger, question);
  } catch (error) {
    logger.error("Could not add the suggested question:", error);
  }
});

/* The button for a question that's already added. It renders inert (green,
   "Added") so this just has to acknowledge the tap — Slack requires that
   within 3 seconds even when there's nothing to do. */
app.action("already_added", async ({ ack }) => { await ack(); });

/* The open-app button is a link. Slack still sends an event; acknowledge it
   so the button does not show a warning triangle. */
app.action("open_app", async ({ ack }) => { await ack(); });
app.action("open_handbook", async ({ ack }) => { await ack(); });

/* ---------- the check-in: one question per modal screen ---------- */

app.action("start_checkin", async ({ ack, body, client, logger }) => {
  await ack();
  try {
    const role = ROLES[body.user.id] || "employee";
    const draft = await store.startCheckin(TEAM_ID, body.user.id, role, queueFor(role));
    await client.views.open({ trigger_id: body.trigger_id, view: checkinModal(draft) });
  } catch (error) {
    logger.error("Could not open the check-in:", error);
  }
});

app.action("checkin_back", async ({ ack, body, client, logger }) => {
  await ack();
  try {
    const { step } = JSON.parse(body.actions[0].value);
    const draft = await store.goBackCheckin(TEAM_ID, body.user.id, step);
    if (!draft) return;
    await client.views.update({ view_id: body.view.id, hash: body.view.hash, view: checkinModal(draft) });
  } catch (error) {
    logger.error("Could not go back a question:", error);
  }
});

app.view("checkin_step_modal", async ({ ack, view, body, client, logger }) => {
  let step;
  try {
    ({ step } = JSON.parse(view.private_metadata || "{}"));
  } catch (error) {
    logger.error("Could not parse check-in metadata:", error);
    await ack();
    return;
  }
  const text = view.state.values[`answer_${step}`]?.text?.value?.trim() || "";
  try {
    const result = await store.submitCheckinAnswer(TEAM_ID, body.user.id, step, text);
    if (!result) { await ack(); return; }

    if (!result.done) {
      await ack({ response_action: "update", view: checkinModal(result) });
      return;
    }

    await ack();
    await client.chat.postMessage({
      channel: body.user.id,
      text: "Check-in saved.",
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: ":white_check_mark: Check-in saved." } },
        { type: "context", elements: [{ type: "mrkdwn",
          text: `${result.queue.length} question${result.queue.length === 1 ? "" : "s"} · only you and your manager could ever see this` }] }
      ]
    });
  } catch (error) {
    logger.error("Could not save the check-in step:", error);
  }
});

/* ---------- Talk: the live agenda ---------- */

app.action("start_talk", async ({ ack, body, client, logger }) => {
  await ack();
  try {
    const topics = await store.getTopics(TEAM_ID, body.user.id);
    await client.views.open({ trigger_id: body.trigger_id, view: talkModal({ topics }) });
  } catch (error) {
    logger.error("Could not open Talk:", error);
  }
});

app.action("talk_topic_action", async ({ ack, body, client, logger }) => {
  await ack();
  try {
    const [kind, idStr] = body.actions[0].selected_option.value.split(":");
    const topicId = Number(idStr);
    if (!Number.isFinite(topicId)) { logger.error("Malformed topic action value:", body.actions[0].selected_option.value); return; }
    const userId = body.user.id;

    if (kind === "action") {
      const topics = await store.getTopics(TEAM_ID, userId);
      const topic = topics.find((t) => t.id === topicId);
      if (topic) await store.addAction(TEAM_ID, userId, topic.text);
      await store.setTopicStatus(TEAM_ID, userId, topicId, "discussed");
    } else {
      await store.setTopicStatus(TEAM_ID, userId, topicId, kind);
    }

    const topics = await store.getTopics(TEAM_ID, userId);
    await client.views.update({ view_id: body.view.id, hash: body.view.hash, view: talkModal({ topics }) });
  } catch (error) {
    logger.error("Could not update the topic:", error);
  }
});

/* ---------- Wrap up: closes out the conversation ---------- */

app.action("start_wrap", async ({ ack, body, client, logger }) => {
  await ack();
  try {
    await client.views.open({ trigger_id: body.trigger_id, view: wrapModal() });
  } catch (error) {
    logger.error("Could not open Wrap up:", error);
  }
});

app.view("wrap_modal", async ({ ack, view, body, client, logger }) => {
  const v = view.state.values;
  const val = (blockId) => v[blockId]?.value?.value?.trim() || "";
  const wrapSummary = {
    discussed: val("discussed"),
    agreed: val("agreed"),
    revisit: val("revisit"),
    start: val("start"),
    stop: val("stop"),
    cont: val("continue"),
    nextDate: v.nextDate?.value?.selected_date || null
  };
  await ack();
  try {
    const userId = body.user.id;
    await store.saveWrapUp(TEAM_ID, userId, wrapSummary);

    const actionText = val("action");
    if (actionText) await store.addAction(TEAM_ID, userId, actionText);

    await client.chat.postMessage({
      channel: userId,
      text: "Your 1:1 is wrapped up.",
      blocks: [
        { type: "section", text: { type: "mrkdwn",
          text: ":white_check_mark: Your 1:1 is wrapped up. Discussed topics are filed away; parking lot items stay on the agenda." } }
      ]
    });

    const other = counterpartOf(userId);
    if (other) {
      try {
        const profile = await client.users.info({ user: userId });
        const from = profile.user?.profile?.first_name || profile.user?.name || "there";
        await notify(other, "wrap", { from });
      } catch (error) {
        logger.error("Could not notify the counterpart:", error);
      }
    }
  } catch (error) {
    logger.error("Could not save the wrap-up:", error);
  }
});

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
