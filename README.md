# Performance Pulse

A private, interactive performance and 1:1 app for an employee and their direct manager.
Single HTML file, no build step, no dependencies, no backend.

Open [`performance-pulse.html`](performance-pulse.html) in any browser. Works on desktop and
mobile.

Full product spec: [SPEC.md](SPEC.md)

## What it does

**Prepare → Talk → Reflect → Act → Follow Up**

| Section | What's in it |
| --- | --- |
| Dashboard | Next 1:1, open topics, goal progress, actions due, recent conversations, updates |
| My 1:1 | Adaptive check-in, shared agenda, topic statuses, post-meeting wrap-up |
| Performance | Achievements, two-way feedback, manager-only concerns, review prep |
| Goals | Why it matters, success measure, owner, progress, obstacles, support needed |
| Development | 13 activity types, manager support, target date, success measure |
| Career | Role-specific prompts, convertible into a development plan |
| Actions | Owner, due date, status, filters for mine/overdue/done |
| History | Everything in order, searchable and filterable by category |
| Export | Pick what to include, confirm, download as Word / PDF / JSON |

## Privacy model

Only the employee and their manager can see anything here.

- No HR role, no HR dashboard, no HR portal
- Nothing is sent to HR — or anywhere else — automatically
- No ratings, rankings, scores, or company-wide analytics
- Export is the only way information leaves the app, and a confirmation step makes clear the
  user controls who sees the file

## Roles

Toggle between **Employee** (Maya Rivera) and **Manager** (Alex Kim) in the top right. The
role changes check-in questions, career prompts, feedback types, and whether the Concerns tab
is visible — managers only.

## Coaching behaviour

The app nudges toward specific, observable language instead of judgements about character:

- Vague feedback ("Communication needs improvement") is held back until a concrete example is
  added — or the user explicitly chooses to save it as written
- Documented concerns get the same treatment ("They don't care about deadlines" prompts a
  rewrite)
- Saying you're overwhelmed in a check-in triggers follow-ups about which responsibilities are
  heaviest and what would help most
- A goal untouched for three weeks offers to add itself to the next 1:1 agenda

This is rule-based pattern matching in the browser, not a language model. There's no backend
and no network call — which also means no data ever leaves the device.

## Storage

Everything is saved to `localStorage` under `performancePulse.v2`. That means data is
**per-browser and per-device** — your phone and laptop each keep their own copy and do not
sync. Real accounts, sync, and email/calendar/Slack notifications would need a backend.

Use **Export → Download raw data (JSON)** to take a full copy.

## Exports

- **Word** — downloads a `.doc` that opens in Word, Pages, or Google Docs
- **PDF** — opens the print dialog; choose "Save as PDF"
- **JSON** — the complete raw dataset

Every export shows a confirmation first stating that the file is yours to share, and that
nothing is sent anywhere automatically.
