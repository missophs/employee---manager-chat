"use strict";

/**
 * The check-in questions, ported from the website's EMP_Q / MGR_Q so the
 * Slack modal asks the same things. The website is a separate, client-only
 * file — nothing imports across that boundary, so keep the two lists in
 * sync by hand if either changes.
 */

const EMP_Q = [
  { id: "proud",   q: "What are you most proud of since your last check-in?" },
  { id: "going",   q: "What's going well right now?" },
  { id: "blocked", q: "What's getting in your way?" },
  { id: "support", q: "Where do you need more support?" },
  { id: "next",    q: "What would you like to accomplish next?" },
  { id: "discuss", q: "Anything you want to make sure you discuss with your manager?" },
  { id: "other",   q: "Other — anything at all that's on your mind?" }
];

const MGR_Q = [
  { id: "well",     q: "What is this person doing particularly well?" },
  { id: "impact",   q: "What impact are they having?" },
  { id: "continue", q: "What should they keep doing?" },
  { id: "improve",  q: "Where could they improve?" },
  { id: "examples", q: "What specific examples support that?" },
  { id: "support",  q: "What support can you provide?" },
  { id: "clear",    q: "Are expectations clear? What might not be landing?" },
  { id: "skills",   q: "What skills could they build next?" },
  { id: "stretch",  q: "Is there a stretch assignment that would grow them?" },
  { id: "other",    q: "Other — anything at all that's on your mind?" }
];

const queueFor = (role) => (role === "manager" ? MGR_Q : EMP_Q).slice();

module.exports = { EMP_Q, MGR_Q, queueFor };
