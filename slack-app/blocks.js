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

function homeTab({ name = "there", role = "employee", openTopics = 0, openActions = 0, plans = 0, when = null, addedQuestions = [], checkin = null }) {
  const examples = EXAMPLES[role] || EXAMPLES.employee;
  return {
    type: "home",
    blocks: [
      header(),
      section(`Hi ${name}. Here's where things stand.`),
      divider(),
      section("*Performance*"),
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
      section("*My 1:1*\nPrepare, talk, and wrap up — one conversation at a time. Jump to any step."),
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              emoji: true,
              text: checkin ? `Prepare — Continue (${checkin.step + 1}/${checkin.total})` : "1. Prepare"
            },
            style: checkin ? undefined : "primary",
            action_id: "start_checkin"
          },
          { type: "button", text: { type: "plain_text", text: "2. Talk", emoji: true }, action_id: "start_talk" },
          { type: "button", text: { type: "plain_text", text: "3. Wrap up", emoji: true }, action_id: "start_wrap" }
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
      {
        type: "section",
        text: { type: "mrkdwn", text: "*Export*\nYour agenda, actions, and past wrap-up summaries as a spreadsheet — sent to you as a file, right here." },
        accessory: {
          type: "button",
          text: { type: "plain_text", text: "Export", emoji: true },
          action_id: "export_data"
        }
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

/**
 * The check-in modal — one question per screen, submit re-renders itself as
 * the next question via response_action:"update" rather than closing, so it
 * behaves like the website's step flow instead of a normal one-shot form.
 */
function checkinModal({ role, step, queue, answers }) {
  const total = queue.length;
  const question = queue[step];
  const isLast = step === total - 1;

  return {
    type: "modal",
    callback_id: "checkin_step_modal",
    private_metadata: JSON.stringify({ step }),
    title: { type: "plain_text", text: role === "manager" ? "Your prep" : "Your check-in" },
    submit: { type: "plain_text", text: isLast ? "Finish" : "Next" },
    close: { type: "plain_text", text: "Pause for now" },
    blocks: [
      context(`Question ${step + 1} of ${total}`),
      section(`*${question.q}*`),
      {
        type: "input",
        block_id: "answer",
        optional: true,
        label: { type: "plain_text", text: "Your answer" },
        element: {
          type: "plain_text_input",
          action_id: "text",
          multiline: true,
          initial_value: answers[question.id] || "",
          placeholder: { type: "plain_text", text: "Skip this one if you'd rather not answer" }
        }
      },
      ...(step > 0 ? [{
        type: "actions",
        elements: [{
          type: "button",
          text: { type: "plain_text", text: "← Back", emoji: true },
          action_id: "checkin_back",
          value: JSON.stringify({ step })
        }]
      }] : []),
      context(":lock: Only you and your manager can see this. Nothing is sent to HR.")
    ]
  };
}

const textField = (blockId, label, placeholder, multiline = true) => ({
  type: "input",
  block_id: blockId,
  optional: true,
  label: { type: "plain_text", text: label },
  element: {
    type: "plain_text_input",
    action_id: "value",
    multiline,
    placeholder: { type: "plain_text", text: placeholder }
  }
});

/**
 * Talk — the live agenda. Not a form: each topic has an overflow menu to
 * mark it discussed, park it, or turn it into an action, and the modal
 * redraws itself in place (views.update) after every tap so it stays
 * usable through a whole conversation without reopening it.
 */
function talkModal({ topics }) {
  const open = topics.filter((t) => t.status === "open");
  const parked = topics.filter((t) => t.status === "parking");

  const row = (t) => ({
    type: "section",
    text: { type: "mrkdwn", text: t.text + (t.category ? `\n_${t.category}_` : "") },
    accessory: {
      type: "overflow",
      action_id: "talk_topic_action",
      options: [
        { text: { type: "plain_text", text: "Mark discussed" }, value: "discussed:" + t.id },
        { text: { type: "plain_text", text: "Move to parking lot" }, value: "parking:" + t.id },
        { text: { type: "plain_text", text: "Turn into an action" }, value: "action:" + t.id }
      ]
    }
  });

  return {
    type: "modal",
    callback_id: "talk_modal",
    title: { type: "plain_text", text: "Talk" },
    close: { type: "plain_text", text: "Done for now" },
    blocks: [
      context("Mark each topic as you go."),
      ...(open.length ? open.map(row) : [section("_Nothing open on the agenda._")]),
      divider(),
      section("*Parking lot*\nWorth talking about — just not today."),
      ...(parked.length ? parked.map(row) : [section("_Nothing parked._")])
    ]
  };
}

/**
 * Wrap up — closes out the conversation. Saving here is what files
 * discussed topics into history and clears them off the agenda; parked
 * topics carry over to next time. Matches the website's Wrap-up tab, minus
 * its two separate "next conversation" / "90-day check-in" dates (one date
 * field here) and its repeatable action list (one optional action here) —
 * trimmed to fit a single modal.
 */
function wrapModal() {
  return {
    type: "modal",
    callback_id: "wrap_modal",
    title: { type: "plain_text", text: "Wrap up" },
    submit: { type: "plain_text", text: "Save & close out" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      section("A short summary you can both look back on."),
      textField("discussed", "What we discussed", "From this conversation — the headline."),
      textField("agreed", "What we agreed on", "Decisions, expectations, anything you both signed up for."),
      textField("revisit", "Topics to revisit next time", "Anything you ran out of time for."),
      context("Start · Stop · Continue — the only rating here. No numbers, no scores."),
      textField("start", "Start", "One thing to start doing", false),
      textField("stop", "Stop", "One thing to stop doing", false),
      textField("continue", "Continue", "One thing that works — keep doing it", false),
      textField("action", "Action for this conversation (optional)", "Something to follow up on", false),
      {
        type: "input",
        block_id: "nextDate",
        optional: true,
        label: { type: "plain_text", text: "Next conversation" },
        element: {
          type: "datepicker",
          action_id: "value",
          placeholder: { type: "plain_text", text: "Pick a date" }
        }
      },
      context(":lock: Closing out clears discussed topics from the agenda. Parking lot items stay.")
    ]
  };
}

module.exports = { build, PINGS, homeTab, addTopicModal, checkinModal, talkModal, wrapModal, APP_URL };
