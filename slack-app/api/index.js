"use strict";

/**
 * Performance Pulse — the cloud version, one serverless function.
 *
 * This is what makes the app installable: it runs on Vercel at a public
 * address, so any Slack workspace can add it with an "Add to Slack" button
 * instead of the code running on one laptop.
 *
 * Same rules as the local version, enforced harder:
 *   - pings carry counts and dates, never content
 *   - nothing anyone writes about performance is stored here (see lib/store)
 *
 * Routes (Bolt provides all of them):
 *   /                      landing page with the Add to Slack button
 *   /slack/install         starts the OAuth install
 *   /slack/oauth_redirect  finishes it
 *   /slack/events          everything Slack sends: events, clicks, /pulse
 */

const { App, LogLevel } = require("@slack/bolt");
const { build, PINGS, homeTab, addTopicModal, checkinModal, talkModal, wrapModal } = require("../blocks");
const store = require("../lib/store");
const { queueFor } = require("../lib/questions");
const { buildExportRows, toCsv } = require("../lib/export");

const APP_URL = process.env.APP_URL || "https://missophs.github.io/employee---manager-chat/";

/* Deploys are allowed to happen before the Slack secrets are configured.
   Without them, serve a page that says exactly what is missing instead of
   crashing — so the very first deploy already shows something helpful. */
const MISSING = ["SLACK_SIGNING_SECRET", "SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET", "SLACK_STATE_SECRET"]
  .filter((k) => !process.env[k]);
if (MISSING.length) {
  module.exports = (req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(
      "<!doctype html><title>Performance Pulse — almost ready</title>" +
      "<body style='font-family:sans-serif;max-width:34em;margin:8vh auto;line-height:1.6;'>" +
      "<h1>Almost ready</h1>" +
      "<p>The app is deployed, but these settings are still missing in " +
      "Vercel &rarr; Project &rarr; Settings &rarr; Environment Variables:</p>" +
      "<ul>" + MISSING.map((k) => "<li><code>" + k + "</code></li>").join("") + "</ul>" +
      "<p><code>SLACK_SIGNING_SECRET</code>, <code>SLACK_CLIENT_ID</code>, and " +
      "<code>SLACK_CLIENT_SECRET</code> come from api.slack.com/apps &rarr; your app " +
      "&rarr; Basic Information. <code>SLACK_STATE_SECRET</code> is any long random " +
      "string you make up yourself &mdash; it protects the install flow. " +
      "After adding them, redeploy.</p></body>"
    );
  };
  return;
}

const app = new App({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  clientId: process.env.SLACK_CLIENT_ID,
  clientSecret: process.env.SLACK_CLIENT_SECRET,
  /* No fallback — a fixed fallback string here would mean the OAuth install
     flow's CSRF protection ran on a secret sitting in the public GitHub
     repo. MISSING above already guarantees this is set by the time the App
     is constructed. */
  stateSecret: process.env.SLACK_STATE_SECRET,
  scopes: ["chat:write", "commands", "users:read", "im:write", "files:write"],
  installationStore: store.installationStore,
  installerOptions: { directInstall: true },
  /* Serverless platforms may freeze the function the moment the response is
     sent, so Bolt must finish the work before acknowledging. */
  processBeforeResponse: true,
  logLevel: LogLevel.WARN,
  customRoutes: [{
    path: "/",
    method: ["GET"],
    handler: (req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        "<!doctype html><title>Performance Pulse</title>" +
        "<body style='font-family:sans-serif;max-width:34em;margin:8vh auto;line-height:1.6;'>" +
        "<h1>Performance Pulse</h1>" +
        "<p>Private 1:1 conversations between a manager and an employee. " +
        "No ratings, no rankings, nothing sent to HR automatically.</p>" +
        "<p><a href='/slack/install'>Add to Slack</a></p></body>"
      );
    }
  }]
});

app.error(async (error) => {
  console.error("Unhandled Bolt error:", error);
});

/* ---------- helpers ---------- */

async function displayName(client, userId) {
  const profile = await client.users.info({ user: userId });
  return profile.user?.profile?.real_name || profile.user?.profile?.first_name || profile.user?.name || "there";
}

/** The Home tab plus the choose-your-partner section the local version
    hardcodes. Pairing is self-serve here: either person picks the other,
    says which side they're on, and both Home tabs update. */
async function publishHome(client, teamId, userId) {
  const [pair, counts, addedQuestions, draft] = await Promise.all([
    store.getPair(teamId, userId),
    store.getCounts(teamId, userId),
    store.getAddedQuestions(teamId, userId),
    store.getCheckin(teamId, userId)
  ]);
  const name = await displayName(client, userId);
  const view = homeTab({
    name: name.split(" ")[0],
    role: pair?.role || "employee",
    openTopics: counts.openTopics,
    openActions: counts.openActions,
    plans: counts.plans,
    when: null,
    addedQuestions,
    checkin: draft ? { step: draft.step, total: draft.queue.length } : null
  });
  const partnerLine = pair
    ? { type: "context", elements: [{ type: "mrkdwn",
        text: "Your 1:1 partner: <@" + pair.partner + "> · you're the " + pair.role +
              ".  Wrong? Pick again below." }] }
    : { type: "section", text: { type: "mrkdwn",
        text: "*First step: say who your 1:1 is with.* Everything stays between the two of you." } };
  view.blocks.splice(1, 0, partnerLine, {
    type: "actions",
    elements: [{
      type: "button",
      text: { type: "plain_text", text: pair ? "Change my 1:1 partner" : "Choose my 1:1 partner", emoji: true },
      action_id: "pick_partner"
    }]
  });
  await client.views.publish({ user_id: userId, view });
}

/* ---------- App Home ---------- */

app.event("app_home_opened", async ({ event, context, client, logger }) => {
  if (event.tab !== "home") return;
  try {
    await publishHome(client, context.teamId, event.user);
  } catch (error) {
    logger.error("Could not publish App Home:", error);
  }
});

/* ---------- pairing ---------- */

app.action("pick_partner", async ({ ack, body, client, logger }) => {
  await ack();
  try {
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: "modal",
        callback_id: "pick_partner_modal",
        title: { type: "plain_text", text: "Your 1:1 partner" },
        submit: { type: "plain_text", text: "Save" },
        close: { type: "plain_text", text: "Cancel" },
        blocks: [
          {
            type: "input", block_id: "partner",
            label: { type: "plain_text", text: "Who do you have 1:1s with?" },
            element: { type: "users_select", action_id: "user",
              placeholder: { type: "plain_text", text: "Pick a person" } }
          },
          {
            type: "input", block_id: "side",
            label: { type: "plain_text", text: "They are my…" },
            element: { type: "radio_buttons", action_id: "value",
              options: [
                { text: { type: "plain_text", text: "Manager (I'm the employee)" }, value: "employee" },
                { text: { type: "plain_text", text: "Employee (I'm the manager)" }, value: "manager" }
              ] }
          },
          { type: "context", elements: [{ type: "mrkdwn",
            text: "This only decides who gets your pings and which questions each of you sees. It is not visible to anyone else." }] }
        ]
      }
    });
  } catch (error) {
    logger.error("Could not open the partner modal:", error);
  }
});

app.view("pick_partner_modal", async ({ ack, view, body, context, client, logger }) => {
  const partner = view.state.values.partner?.user?.selected_user;
  const myRole = view.state.values.side?.value?.selected_option?.value;
  if (!partner || partner === body.user.id) {
    await ack({ response_action: "errors",
      errors: { partner: "Pick the other person in your 1:1 — not yourself." } });
    return;
  }
  await ack();
  try {
    await store.setPair(context.teamId, body.user.id, partner, myRole || "employee");
  } catch (error) {
    logger.error("Could not save the pair:", error);
    return;
  }
  try {
    await publishHome(client, context.teamId, body.user.id);
  } catch (error) {
    logger.error("Pair was saved but the Home tab could not refresh:", error);
  }
  try {
    await client.chat.postMessage({
      channel: body.user.id,
      text: "You're set up. Your 1:1 pings will go between you and <@" + partner + "> only."
    });
  } catch (error) {
    logger.error("Pair was saved but the confirmation message failed to send:", error);
  }
});

/* ---------- the add-a-topic modal ---------- */

app.action("add_topic", async ({ ack, body, client, logger }) => {
  await ack();
  try {
    await client.views.open({ trigger_id: body.trigger_id, view: addTopicModal() });
  } catch (error) {
    logger.error("Could not open the modal:", error);
  }
});

/* Shared by both ways a topic gets added: the "Add a topic" modal (typed,
   with a category) and tapping "Add" on a suggested question (no category —
   it's already one of the app's own prompts). Stores the real topic,
   refreshes the author's Home tab, pings the partner, and confirms — same
   steps either way. */
async function addTopicAndNotify({ client, context, body, category, text, logger }) {
  const topic = await store.addTopic(context.teamId, body.user.id, text, category);
  /* Only the suggested-question path counts toward "Added ✓" — a custom
     typed topic that happens to match a suggestion's wording shouldn't turn
     that button green too. */
  if (category === "Suggested question") await store.addQuestion(context.teamId, body.user.id, text);

  try {
    await publishHome(client, context.teamId, body.user.id);
  } catch (error) {
    logger.error("Topic was saved but the Home tab could not refresh:", error);
  }

  const counts = await store.getCounts(context.teamId, body.user.id);
  const pair = await store.getPair(context.teamId, body.user.id);
  if (pair) {
    try {
      const from = await displayName(client, body.user.id);
      const payload = build("topic", {
        from, openTopics: counts.openTopics, when: "not in the diary yet"
      });
      await client.chat.postMessage({
        channel: pair.partner, text: payload.text, blocks: payload.blocks
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
        { type: "context", elements: [{ type: "mrkdwn",
          text: category + " · only your 1:1 partner is told something was added — never what" }] }
      ]
    });
  } catch (error) {
    /* The topic is saved and the Home tab (if it refreshed above) already
       shows it — this is only the confirmation DM, so log rather than throw. */
    logger.error("Topic was saved but the confirmation message failed to send:", error);
  }
  return topic;
}

app.view("add_topic_modal", async ({ ack, view, body, context, client, logger }) => {
  const text = view.state.values.topic?.text?.value?.trim();
  const category = view.state.values.category?.value?.selected_option?.value;
  if (!text) {
    await ack({ response_action: "errors",
      errors: { topic: "Add a few words about what you want to discuss." } });
    return;
  }
  await ack();
  try {
    await addTopicAndNotify({ client, context, body, category: category || "Other", text, logger });
  } catch (error) {
    logger.error("Could not handle the submission:", error);
  }
});

/* Tapping "Add" next to a suggested question — one click, no modal. */
app.action("add_example", async ({ ack, body, context, client, logger }) => {
  await ack();
  try {
    const question = body.actions[0].value;
    await addTopicAndNotify({ client, context, body, category: "Suggested question", text: question, logger });
  } catch (error) {
    logger.error("Could not add the suggested question:", error);
  }
});

/* The button for a question that's already added. It renders inert (green,
   "Added") so this just has to acknowledge the tap within Slack's 3-second
   window — there's nothing left to do. */
app.action("already_added", async ({ ack }) => { await ack(); });

app.action("open_app", async ({ ack }) => { await ack(); });
app.action("open_handbook", async ({ ack }) => { await ack(); });

/* ---------- the check-in: one question per modal screen ---------- */

app.action("start_checkin", async ({ ack, body, context, client, logger }) => {
  await ack();
  try {
    const pair = await store.getPair(context.teamId, body.user.id);
    const role = pair?.role || "employee";
    const draft = await store.startCheckin(context.teamId, body.user.id, role, queueFor(role));
    await client.views.open({
      trigger_id: body.trigger_id,
      view: checkinModal(draft)
    });
  } catch (error) {
    logger.error("Could not open the check-in:", error);
  }
});

app.action("checkin_back", async ({ ack, body, context, client, logger }) => {
  await ack();
  try {
    const { step } = JSON.parse(body.actions[0].value);
    const draft = await store.goBackCheckin(context.teamId, body.user.id, step);
    if (!draft) return;
    await client.views.update({
      view_id: body.view.id,
      hash: body.view.hash,
      view: checkinModal(draft)
    });
  } catch (error) {
    logger.error("Could not go back a question:", error);
  }
});

app.view("checkin_step_modal", async ({ ack, view, body, context, client, logger }) => {
  let step;
  try {
    ({ step } = JSON.parse(view.private_metadata || "{}"));
  } catch (error) {
    logger.error("Could not parse check-in metadata:", error);
    await ack();
    return;
  }
  const text = view.state.values[`answer_${step}`]?.text?.value?.trim() || "";
  let result;
  try {
    result = await store.submitCheckinAnswer(context.teamId, body.user.id, step, text);
  } catch (error) {
    logger.error("Could not save the check-in step:", error);
    await ack();
    return;
  }
  if (!result) { await ack(); return; }

  if (!result.done) {
    await ack({ response_action: "update", view: checkinModal(result) });
    return;
  }

  await ack();
  try {
    await publishHome(client, context.teamId, body.user.id);
  } catch (error) {
    logger.error("Check-in was saved but the Home tab could not refresh:", error);
  }
  try {
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
    logger.error("Check-in was saved but the confirmation message failed to send:", error);
  }
});

/* ---------- Talk: the live agenda ---------- */

app.action("start_talk", async ({ ack, body, context, client, logger }) => {
  await ack();
  try {
    const topics = await store.getTopics(context.teamId, body.user.id);
    await client.views.open({ trigger_id: body.trigger_id, view: talkModal({ topics }) });
  } catch (error) {
    logger.error("Could not open Talk:", error);
  }
});

app.action("talk_topic_action", async ({ ack, body, context, client, logger }) => {
  await ack();
  try {
    const [kind, idStr] = body.actions[0].selected_option.value.split(":");
    const topicId = Number(idStr);
    if (!Number.isFinite(topicId)) { logger.error("Malformed topic action value:", body.actions[0].selected_option.value); return; }
    const teamId = context.teamId, userId = body.user.id;

    if (kind === "action") {
      const topics = await store.getTopics(teamId, userId);
      const topic = topics.find((t) => t.id === topicId);
      if (topic) await store.addAction(teamId, userId, topic.text);
      await store.setTopicStatus(teamId, userId, topicId, "discussed");
    } else {
      await store.setTopicStatus(teamId, userId, topicId, kind);
    }

    const topics = await store.getTopics(teamId, userId);
    await client.views.update({ view_id: body.view.id, hash: body.view.hash, view: talkModal({ topics }) });
    await publishHome(client, teamId, userId);
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

app.view("wrap_modal", async ({ ack, view, body, context, client, logger }) => {
  const v = view.state.values;
  const val = (blockId) => v[blockId]?.value?.value?.trim() || "";
  const summary = {
    discussed: val("discussed"),
    agreed: val("agreed"),
    revisit: val("revisit"),
    start: val("start"),
    stop: val("stop"),
    cont: val("continue"),
    nextDate: v.nextDate?.value?.selected_date || null
  };
  await ack();
  const teamId = context.teamId, userId = body.user.id;
  try {
    await store.saveWrapUp(teamId, userId, summary);
    const actionText = val("action");
    if (actionText) await store.addAction(teamId, userId, actionText);
  } catch (error) {
    logger.error("Could not save the wrap-up:", error);
    return;
  }

  try {
    await publishHome(client, teamId, userId);
  } catch (error) {
    logger.error("Wrap-up was saved but the Home tab could not refresh:", error);
  }
  try {
    await client.chat.postMessage({
      channel: userId,
      text: "Your 1:1 is wrapped up.",
      blocks: [
        { type: "section", text: { type: "mrkdwn",
          text: ":white_check_mark: Your 1:1 is wrapped up. Discussed topics are filed away; parking lot items stay on the agenda." } }
      ]
    });
  } catch (error) {
    logger.error("Wrap-up was saved but the confirmation message failed to send:", error);
  }

  const pair = await store.getPair(teamId, userId);
  if (pair) {
    try {
      const from = await displayName(client, userId);
      const payload = build("wrap", { from });
      await client.chat.postMessage({ channel: pair.partner, text: payload.text, blocks: payload.blocks });
    } catch (error) {
      logger.error("Could not notify the counterpart:", error);
    }
  }
});

/* ---------- Export: agenda, actions, and history as a CSV file ---------- */

app.action("export_data", async ({ ack, body, context, client, logger }) => {
  await ack();
  const teamId = context.teamId, userId = body.user.id;
  try {
    const [topics, actions, history] = await Promise.all([
      store.getTopics(teamId, userId),
      store.getActions(teamId, userId),
      store.getHistory(teamId, userId)
    ]);
    const csv = toCsv(buildExportRows(topics, actions, history));
    await client.files.uploadV2({
      channel_id: userId,
      filename: "performance-pulse-export.csv",
      content: csv,
      initial_comment: ":lock: Your 1:1 data. Only you have this file — nothing was sent to HR or anyone else."
    });
  } catch (error) {
    logger.error("Could not export:", error);
    try {
      await client.chat.postMessage({ channel: userId, text: "That export didn't work — try again in a minute." });
    } catch (sendError) {
      logger.error("Could not even send the export failure notice:", sendError);
    }
  }
});

/* ---------- /pulse: send yourself any ping, for testing ---------- */

const SAMPLE = {
  topic:       { openTopics: 2, when: "not in the diary yet" },
  upcoming:    { openTopics: 2, when: "soon — set it in the app" },
  feedback:    {},
  request:     {},
  development: { plans: 3 },
  action:      { open: 2 },
  wrap:        {}
};

app.command("/pulse", async ({ command, ack, context, client, respond, logger }) => {
  await ack();
  const kind = (command.text || "").trim() || "topic";
  if (!PINGS[kind]) {
    await respond({ response_type: "ephemeral",
      text: "I don't have a ping called \"" + kind + "\". Try: " + Object.keys(PINGS).join(", ") });
    return;
  }
  try {
    const pair = await store.getPair(context.teamId, command.user_id);
    const from = pair ? await displayName(client, pair.partner) : "Your 1:1 partner";
    const payload = build(kind, { ...(SAMPLE[kind] || {}), from });
    await client.chat.postMessage({
      channel: command.user_id, text: payload.text, blocks: payload.blocks
    });
  } catch (error) {
    logger.error("Could not send the ping:", error);
    await respond({ response_type: "ephemeral", text: "That didn't send. Check the logs." });
  }
});

/* ---------- the Vercel handler ---------- */

/* Bolt throws on paths it doesn't own (a bot probing /wp-admin, a browser
   GETting the events URL) so the wrapper can decide. Answer 404 instead of
   crashing the function. */
module.exports = (req, res) => {
  try {
    app.receiver.requestListener(req, res);
  } catch (error) {
    if (error.code === "slack_bolt_http_receiver_deferred_request_error") {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    } else {
      throw error;
    }
  }
};
