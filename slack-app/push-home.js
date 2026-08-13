"use strict";

/**
 * Publish the App Home tab straight to Slack using only the bot token.
 *
 * No app-level token and no Socket Mode needed. Socket Mode is only required
 * to RECEIVE things from Slack (button clicks, modal submits, slash commands).
 * Pushing a Block Kit surface INTO Slack needs nothing but chat/views scopes.
 *
 *   node push-home.js
 */

require("dotenv").config();

const { WebClient } = require("@slack/web-api");
const { homeTab } = require("./blocks");

const web = new WebClient(process.env.SLACK_BOT_TOKEN);

const TARGETS = [
  { id: "U0BQQTKLQ1E", name: "Melissa", openTopics: 2, openActions: 1, plans: 1, when: "Thu, Aug 13 at 10:00 AM" },
  { id: "U0BPSUWKGRK", name: "Mel",     openTopics: 2, openActions: 3, plans: 2, when: "Thu, Aug 13 at 10:00 AM" }
];

(async () => {
  for (const t of TARGETS) {
    try {
      const res = await web.views.publish({ user_id: t.id, view: homeTab(t) });
      console.log(`OK   ${t.id} (${t.name}) — Home tab published, view ${res.view.id}`);
    } catch (error) {
      console.log(`FAIL ${t.id} (${t.name}) — ${error.data ? error.data.error : error.message}`);
    }
  }
})();
