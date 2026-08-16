# Governance for slack-app/

Rules earned from real bugs (silent topic-add failures, Home tab buttons that hung locally,
unescaped link injection, storage races). Follow these on every change here — they exist
because skipping them already broke something once.

## The two entry points must stay in sync

`app.js` (local Socket Mode dev) and `api/index.js` (cloud/Vercel, what's actually live) are
two front doors to the same product. Both import `blocks.js` for UI and `lib/store.js` for
data — that's what keeps them from drifting apart.

**Rule: every `action_id` and `callback_id` referenced in `blocks.js` must have a registered
handler in *both* `app.js` and `api/index.js`**, or be explicitly documented as web-only (see
`APP_URL` fallback in `openButton()`). A button that opens a modal in one and hangs silently
in the other is exactly the bug that started this file.

## No web-version fallback for anything that has a Slack modal

The whole point of this app is that a manager/employee 1:1 lives inside Slack. If you build a
Slack modal for a flow (Prepare, Talk, Wrap-up), the corresponding `PINGS` entry in
`blocks.js` must set `actionId` to route to it — never leave it falling back to `APP_URL`.
`feedback`, `request`, `development`, and `action` still fall back to the web app today only
because those modals don't exist yet — that's a known gap, not a design choice. Building one
of those modals means also flipping its `actionId` in `blocks.js`.

## Storage discipline (`lib/store.js`)

- **`topics:*`, `actions:*`, and `history:*` are shared, not per-user.** They're keyed by
  the employee side of a pair (`sharedOwnerId()`/`topicsOwner()`/`actionsOwner()`/
  `historyOwner()`), and both people in a 1:1 read/write the same bucket. This was a real,
  shipped bug: everything used to be keyed by whoever was acting, so a manager's own Talk
  modal read a completely different, empty bucket than the one their employee had just added
  a topic to — the "shared agenda" didn't actually share anything. **If you add a new data
  type that both people in a pair need to see, key it through the same owner-resolution
  pattern — don't key it by `userId` directly, or you'll reintroduce this bug.** `checkin:*`
  is the one deliberate exception: each person answers their own separate questionnaire
  (employee vs. manager questions), so it stays keyed by whoever is actually typing.
- Any new shared data type also needs a `migrateLegacyOnce`-style one-time merge if it's
  possible for data to already exist under the wrong (non-canonical) key — see how
  `topicsOwner`/`actionsOwner`/`historyOwner` do it. Don't silently drop pre-existing data
  when changing how something is keyed.
- Every read-modify-write on a list/object key (`topics:*`, `actions:*`, `history:*`,
  `checkin:*`, `added:*`) must go through `withLock(key, fn)`. It's cheap and it's what stops
  a fast double-tap from silently dropping data.
- `withLock` only serializes writes *within one warm process* — it does not protect against
  two different Vercel instances racing the same key at the same moment. That would need a
  Redis-side lock (Lua/WATCH), deliberately not implemented because it can't be verified
  without a live Redis instance to test against. If this app ever needs to support more than
  one pair per team, revisit this.
- Any list that grows forever (`history:*`) needs a cap. `HISTORY_LIMIT` in `store.js` is the
  precedent — copy the pattern, don't add an unbounded list.
- If a mutation writes more than one key (see `setPair`), the second write's failure must roll
  back the first. Don't leave half-written state.
- If you add a new Redis env var name Upstash might use, add it to the fallback chain at the
  top of the file — don't replace the existing ones. And keep the console.warn when no env var
  resolves; it's the only thing that made the last "nothing happens" bug visible at all.

## Rendering user-typed text

Anything a person typed (topic text, check-in answers, wrap-up fields) that gets interpolated
into a Block Kit `mrkdwn` field must go through `escapeMrkdwn()` in `blocks.js` first. Slack's
mrkdwn treats `&`, `<`, `>` as syntax — unescaped user text can render as a live link.

## Error handling

- Never call `ack()` and then let a later `await` in the same handler throw unguarded — once
  `ack()` fires, the modal has already closed / the button has already responded, so a later
  failure has no way to reach the user except a log line. Wrap it.
- Prefer several small `try/catch` blocks over one big one around a multi-step handler, so one
  step's failure (e.g. the confirmation DM) doesn't hide that an earlier step (e.g. the actual
  save) already succeeded.
- Both `app.js` and `api/index.js` register a top-level `app.error()` handler. Keep it.

## Before committing

Run:

```bash
npm run check
```

There's no automated test suite yet — before shipping a change to a handler, either exercise
it against a real Slack workspace, or, for pure data-layer logic, write a throwaway
`node -e '...'` script exercising the function directly (see git history for examples against
`lib/store.js` and `blocks.js`). Don't declare a fix done from reading the diff alone.
