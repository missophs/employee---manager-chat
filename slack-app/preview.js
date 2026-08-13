"use strict";

/**
 * Prints every Block Kit payload as JSON. No Slack account, no tokens, no
 * network — it just builds the objects and shows them.
 *
 *   npm run preview            all of them
 *   npm run preview topic      just one
 *
 * Copy any block of JSON into https://app.slack.com/block-kit-builder
 * to watch it render.
 */

const { build, PINGS, homeTab, addTopicModal } = require("./blocks");

const SAMPLE = {
  topic:       { from: "Alex Kim", openTopics: 2, when: "Thu, Aug 13 at 10:00 AM" },
  upcoming:    { from: "Alex Kim", openTopics: 2, when: "Thu, Aug 13 at 10:00 AM" },
  feedback:    { from: "Alex Kim" },
  request:     { from: "Alex Kim" },
  development: { from: "Alex Kim", plans: 3, direction: "recommended" },
  action:      { open: 2 },
  wrap:        { from: "Alex Kim" }
};

const only = process.argv[2];
const kinds = only ? [only] : Object.keys(PINGS);

if (only && !PINGS[only]) {
  console.error(`Unknown ping "${only}".`);
  console.error(`Try one of: ${Object.keys(PINGS).join(", ")}`);
  process.exit(1);
}

const line = (s) => console.log(`\n${"─".repeat(64)}\n${s}\n${"─".repeat(64)}`);

for (const kind of kinds) {
  line(`MESSAGE · ${kind}`);
  console.log(JSON.stringify(build(kind, SAMPLE[kind] || {}), null, 2));
}

if (!only) {
  line("APP HOME · the tab in the Slack sidebar");
  console.log(JSON.stringify(
    homeTab({ name: "Maya", openTopics: 2, openActions: 2, plans: 3, when: "Thu, Aug 13 at 10:00 AM" }),
    null, 2
  ));

  line("MODAL · the add-a-topic pop-up");
  console.log(JSON.stringify(addTopicModal(), null, 2));
}

console.log("");
