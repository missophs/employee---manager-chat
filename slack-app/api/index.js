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
const { build, PINGS, homeTab, addTopicModal } = require("../blocks");
const store = require("../lib/store");

const APP_URL = process.env.APP_URL || "https://missophs.github.io/employee---manager-chat/";

/* Deploys are allowed to happen before the Slack secrets are configured.
   Without them, serve a page that says exactly what is missing instead of
   crashing — so the very first deploy already shows something helpful. */
const MISSING = ["SLACK_SIGNING_SECRET", "SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET"]
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
      "<p>They come from api.slack.com/apps &rarr; your app &rarr; Basic Information. " +
      "After adding them, redeploy.</p></body>"
    );
  };
  return;
}

const app = new App({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  clientId: process.env.SLACK_CLIENT_ID,
  clientSecret: process.env.SLACK_CLIENT_SECRET,
  stateSecret: process.env.SLACK_STATE_SECRET || "performance-pulse-install-state",
  scopes: ["chat:write", "commands", "users:read", "im:write"],
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

/* ---------- helpers ---------- */

async function displayName(client, userId) {
  const profile = await client.users.info({ user: userId });
  return profile.user?.profile?.real_name || profile.user?.profile?.first_name || profile.user?.name || "there";
}

/** The Home tab plus the choose-your-partner section the local version
    hardcodes. Pairing is self-serve here: either person picks the other,
    says which side they're on, and both Home tabs update. */
async function publishHome(client, teamId, userId) {
  const [pair, counts, addedQuestions] = await Promise.all([
    store.getPair(teamId, userId),
    store.getCounts(teamId, userId),
    store.getAddedQuestions(teamId, userId)
  ]);
  const name = await displayName(client, userId);
  const view = homeTab({
    name: name.split(" ")[0],
    role: pair?.role || "employee",
    openTopics: counts.openTopics,
    openActions: counts.openActions,
    plans: counts.plans,
    when: null,
    addedQuestions
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
    await publishHome(client, context.teamId, body.user.id);
    await client.chat.postMessage({
      channel: body.user.id,
      text: "You're set up. Your 1:1 pings will go between you and <@" + partner + "> only."
    });
  } catch (error) {
    logger.error("Could not save the pair:", error);
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
   it's already one of the app's own prompts). Bumps the count, refreshes the
   author's Home tab, pings the partner, and confirms — same three steps
   either way. */
async function addTopicAndNotify({ client, context, body, category, logger, text = null }) {
  const counts = await store.bumpTopics(context.teamId, body.user.id);
  if (text) await store.addQuestion(context.teamId, body.user.id, text);
  await publishHome(client, context.teamId, body.user.id);

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

  await client.chat.postMessage({
    channel: body.user.id,
    text: "Added to your 1:1 agenda.",
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: ":white_check_mark: Added to your 1:1 agenda." } },
      { type: "context", elements: [{ type: "mrkdwn",
        text: category + " · only your 1:1 partner is told something was added — never what" }] }
    ]
  });
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
    await addTopicAndNotify({ client, context, body, category: category || "Other", logger });
  } catch (error) {
    logger.error("Could not handle the submission:", error);
  }
});

/* Tapping "Add" next to a suggested question — one click, no modal. */
app.action("add_example", async ({ ack, body, context, client, logger }) => {
  await ack();
  try {
    const question = body.actions[0].value;
    await addTopicAndNotify({ client, context, body, category: "Suggested question", logger, text: question });
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
