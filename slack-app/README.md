# Performance Pulse — Slack app

Built with Slack's Block Kit, on all three surfaces: **messages**, the **App Home tab**, and a
**modal**. Runs in Socket Mode, so it needs no hosting and no public web address to try out.

## See the Block Kit without any Slack setup

No tokens, no account, no network:

```bash
npm install && npm run preview
```

Prints all seven message layouts, the Home tab, and the modal as JSON. Paste any block into
[app.slack.com/block-kit-builder](https://app.slack.com/block-kit-builder) to watch it render.

## Run it against a real workspace

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**.
   Name it `Performance Pulse` and pick your workspace.
2. **OAuth & Permissions** → Bot Token Scopes → add `chat:write`, `im:write`, `users:read`.
3. **Basic Information** → App-Level Tokens → generate one with `connections:write`.
4. **Socket Mode** → turn it on.
5. **App Home** → turn on the Home Tab.
6. **Slash Commands** → create `/pulse` (description: "Send yourself a test ping").
7. **Install to Workspace**.
8. `cp .env.example .env`, paste both tokens in, then:

```bash
npm start
```

Type `/pulse` in Slack, or click Performance Pulse in your sidebar for the Home tab.

## The rule this code follows

A Slack workspace admin can export DM history. So a ping says only *that* something happened —
never the topic text, the feedback, the concern, or the goal. Counts and dates are fine; anything
one person wrote about another is not.

That restraint is the product's main promise. Keep it when adding pings.

## Files

| File | What it is |
| --- | --- |
| `blocks.js` | Every Block Kit layout. The only file you edit to change how messages look. |
| `app.js` | The Slack connection — Home tab, modal, `/pulse`, and the `notify()` function. |
| `preview.js` | Prints the JSON. No Slack needed. |

## What this is not

It does not yet fire on its own when something happens in `performance-pulse.html`. That needs the
two halves connected, which means performance data leaving the employee's device and living on a
server. See `../SLACK.md` before taking that step — it changes what the product can promise.
