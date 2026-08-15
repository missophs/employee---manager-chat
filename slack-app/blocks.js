"use strict";

/**
 * Every Block Kit layout Performance Pulse sends.
 *
 * The rule that governs this whole file: a Slack workspace admin can export
 * DM history. So a ping says only THAT something happened — never the topic
 * text, the feedback, the concern, or the goal. Counts and dates are fine.
 * Anything a person wrote about another person is not.
 *
 * If you add a ping, keep that rule. It is the product's main promise.
 */

const APP_URL = process.env.APP_URL || "https://missophs.github.io/employee---manager-chat/";

/* The employee handbook link. Set in .env — server config, so only whoever
   runs the app (HR) can change where it points. No URL, no button. */
const HANDBOOK_URL = process.env.HANDBOOK_URL || "";

/* ---------- small builders ---------- */

const header = (text = "Performance Pulse") => ({
  type: "header",
  text: { type: "plain_text", text, emoji: true }
});

const section = (markdown) => ({
  type: "section",
  text: { type: "mrkdwn", text: markdown }
});

const context = (markdown) => ({
  type: "context",
  elements: [{ type: "mrkdwn", text: markdown }]
});

const divider = () => ({ type: "divider" });

const openButton = (label = "Open Performance Pulse", url = APP_URL) => ({
  type: "actions",
  elements: [{
    type: "button",
    text: { type: "plain_text", text: label, emoji: true },
    style: "primary",
    url,
    action_id: "open_app"
  }]
});

const privacyFooter = () => context(
  ":lock: Nothing about your performance is in this message. The detail stays in " +
  "the app, visible only to you and your manager."
);

/**
 * Assemble a standard ping.
 * @param {{fallback:string, line:string, meta:string, button:string}} parts
 */
function ping({ fallback, line, meta, button }) {
  return {
    text: fallback,                       // shown in notifications and by screen readers
    blocks: [
      header(),
      section(line),
      context(meta),
      openButton(button),
      divider(),
      privacyFooter()
    ]
  };
}

/* ---------- the seven pings ---------- */

const plural = (n, word) => {
  const count = Number.isFinite(n) ? n : 0;
  return `${count} ${word}${count === 1 ? "" : "s"}`;
};

/* A ping with a missing name would render "*undefined* left you feedback".
   Fall back to something neutral rather than showing that to a person. */
const who = (name) => (typeof name === "string" && name.trim()) || "Someone";

const PINGS = {
  topic: ({ from, openTopics = 0, when = "not in the diary yet" }) => ping({
    fallback: `${who(from)} added a topic to your 1:1 agenda`,
    line: `*${who(from)}* added a topic to your 1:1 agenda.`,
    meta: `${plural(openTopics, "topic")} open  ·  Next 1:1 ${when}`,
    button: "See the agenda"
  }),

  upcoming: ({ from, openTopics = 0, when = "not in the diary yet" }) => ping({
    fallback: `Your 1:1 with ${who(from)} is ${when}`,
    line: `Your 1:1 with *${who(from)}* is *${when}*.`,
    meta: openTopics
      ? `${plural(openTopics, "topic")} waiting  ·  Worth ten minutes of prep`
      : "Nothing on the agenda yet",
    button: "Prepare for it"
  }),

  feedback: ({ from }) => ping({
    fallback: `${who(from)} left you feedback`,
    line: `*${who(from)}* left you feedback.`,
    meta: "Read it when you have a quiet minute, not between meetings.",
    button: "Read it"
  }),

  request: ({ from }) => ping({
    fallback: `${who(from)} asked you for feedback`,
    line: `*${who(from)}* asked you for feedback.`,
    meta: "No deadline. Answer it whenever you're ready.",
    button: "Answer it"
  }),

  development: ({ from, plans = 0, direction = "recommended" }) => ping({
    fallback: `${who(from)} added a development plan`,
    line: `*${who(from)}* ${direction} a development plan for you.`,
    meta: `${plural(plans, "plan")} in the workspace  ·  Nothing is agreed until you both say so`,
    button: "Take a look"
  }),

  action: ({ open = 0 }) => ping({
    fallback: `${plural(open, "action")} assigned to you`,
    line: `You have *${plural(open, "open action")}* from your 1:1s.`,
    meta: "Listed in the app with owners and dates. No nagging, no scores.",
    button: "See what's open"
  }),

  wrap: ({ from }) => ping({
    fallback: `Your 1:1 with ${who(from)} is wrapped up`,
    line: `Your 1:1 with *${who(from)}* is wrapped up.`,
    meta: "What you discussed, what you agreed, and who owns what — all written down.",
    button: "Read the summary"
  })
};

/**
 * Build any ping by name.
 * @param {keyof PINGS} kind
 * @param {object} data
 */
function build(kind, data = {}) {
  const make = PINGS[kind];
  if (!make) throw new Error(`Unknown ping: ${kind}. Known: ${Object.keys(PINGS).join(", ")}`);
  /* Every builder destructures its argument, so an explicit null would throw
     a TypeError rather than the clear error above. */
  return make(data || {});
}

/* ---------- App Home: a Block Kit surface, not a message ---------- */

/**
 * The tab a person sees when they click Performance Pulse in their Slack
 * sidebar. Same restraint applies — counts, never content.
 */
/* Example questions per role, drawn from the same library the web app uses.
   The employee's set leans on performance questions — where do I stand, what's
   expected — so nobody drifts along unaware until review time. */
const EXAMPLES = {
  employee: [
    "Am I meeting expectations? Be straight with me.",
    "What should I follow up on from our last 1:1?",
    "Of everything on my plate, what matters most to you this month?",
    "What would it take to move toward the next step?"
  ],
  manager: [
    "Where do you think you stand right now? Let's compare notes.",
    "What's slowing you down that I could remove?",
    "What did we agree last time, and where did it land?",
    "How is your workload actually feeling — not the tidy answer?"
  ]
};

function homeTab({ name = "there", role = "employee", openTopics = 0, openActions = 0, plans = 0, when = null, addedQuestions = [] }) {
  const examples = EXAMPLES[role] || EXAMPLES.employee;
  return {
    type: "home",
    blocks: [
      header(),
      section(`Hi ${name}. Here's where things stand.`),
      divider(),
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Open topics*\n${openTopics}` },
          { type: "mrkdwn", text: `*Open actions*\n${openActions}` },
          { type: "mrkdwn", text: `*Development plans*\n${plans}` },
          { type: "mrkdwn", text: `*Next 1:1*\n${when || "Not scheduled"}` }
        ]
      },
      divider(),
      section("*Worth asking in your next 1:1*\nTap one to add it straight to the agenda, or write your own below."),
      ...examples.map((q) => {
        const added = addedQuestions.includes(q);
        return {
          type: "section",
          text: { type: "mrkdwn", text: q },
          accessory: added
            ? {
                type: "button",
                text: { type: "plain_text", text: "Added ✓", emoji: true },
                style: "primary",
                action_id: "already_added",
                value: q
              }
            : {
                type: "button",
                text: { type: "plain_text", text: "Add", emoji: true },
                action_id: "add_example",
                value: q
              }
        };
      }),
      divider(),
      section("*Add something to the agenda*\nIt shows up for the other person straight away."),
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Add a topic", emoji: true },
            style: "primary",
            action_id: "add_topic"
          },
          {
            type: "button",
            text: { type: "plain_text", text: "Open the app", emoji: true },
            url: APP_URL,
            action_id: "open_app"
          },
          ...(HANDBOOK_URL ? [{
            type: "button",
            text: { type: "plain_text", text: "Employee handbook", emoji: true },
            url: HANDBOOK_URL,
            action_id: "open_handbook"
          }] : [])
        ]
      },
      divider(),
      privacyFooter()
    ]
  };
}

/**
 * The pop-up for adding a topic. Modals are the third Block Kit surface.
 */
function addTopicModal() {
  return {
    type: "modal",
    callback_id: "add_topic_modal",
    title: { type: "plain_text", text: "Add a topic" },
    submit: { type: "plain_text", text: "Add it" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: "topic",
        label: { type: "plain_text", text: "What do you want to discuss?" },
        element: {
          type: "plain_text_input",
          action_id: "text",
          multiline: true,
          placeholder: { type: "plain_text", text: "I want to discuss…" }
        }
      },
      {
        type: "input",
        block_id: "category",
        label: { type: "plain_text", text: "Category" },
        element: {
          type: "static_select",
          action_id: "value",
          placeholder: { type: "plain_text", text: "Pick one" },
          options: [
            "Wins", "Priorities", "Roadblocks", "Workload", "Feedback",
            "Recognition", "Career", "Development", "Team issues",
            "Questions", "Support needed", "Other"
          ].map((c) => ({ text: { type: "plain_text", text: c }, value: c }))
        }
      },
      context(
        "Only you and your manager can see this. It is not sent to HR, and it is " +
        "not posted in any channel."
      )
    ]
  };
}

module.exports = { build, PINGS, homeTab, addTopicModal, APP_URL };
