"use strict";

/**
 * Send one of every ping to both people in the pair, so the layouts can be
 * checked in a real Slack client rather than in Block Kit Builder.
 *
 * Bot token only. Does not need Socket Mode or an app-level token.
 *
 *   node send-all.js
 */

require("dotenv").config();

const { WebClient } = require("@slack/web-api");
const { build, PINGS } = require("./blocks");

const web = new WebClient(process.env.SLACK_BOT_TOKEN);

const PEOPLE = {
  U0BQQTKLQ1E: { name: "Melissa Weiss", from: "Monte Montoya" },
  U0BPSUWKGRK: { name: "Monte Montoya", from: "Melissa Weiss" }
};

const WHEN = "Thu, Aug 13 at 10:00 AM";

/* Counts and dates only. No topic text, no feedback, no goal — a workspace
   admin can export DM history, so nothing about a person goes in here. */
const data = (from) => ({
  topic:       { from, openTopics: 2, when: WHEN },
  upcoming:    { from, openTopics: 2, when: WHEN },
  feedback:    { from },
  request:     { from },
  development: { from, plans: 3 },
  action:      { open: 2 },
  wrap:        { from }
});

(async () => {
  let sent = 0;
  let failed = 0;

  for (const [userId, person] of Object.entries(PEOPLE)) {
    const payloads = data(person.from);
    for (const kind of Object.keys(PINGS)) {
      try {
        const payload = build(kind, payloads[kind]);
        await web.chat.postMessage({
          channel: userId,
          text: payload.text,
          blocks: payload.blocks
        });
        console.log(`OK   ${person.name.padEnd(8)} ${kind}`);
        sent++;
      } catch (error) {
        console.log(`FAIL ${person.name.padEnd(8)} ${kind} — ${error.data ? error.data.error : error.message}`);
        failed++;
      }
    }
  }

  console.log(`\n${sent} sent, ${failed} failed`);
})();
