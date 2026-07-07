---
name: run-wacrm
description: Build, run, and drive wacrm (Next.js + Supabase CRM). Use when asked to start the app, log in, screenshot a page, or verify a UI change in the browser.
---

wacrm is a Next.js app backed by Supabase. There's no `chromium-cli` in
this environment, so it's driven with a small Playwright script at
`.claude/skills/run-wacrm/driver.mjs`: it logs in with real Supabase
credentials, navigates to a path, and screenshots the result. All paths
below are relative to the repo root.

## Prerequisites

Node >= 20 (per root `package.json` `engines`). No OS packages needed —
Playwright's bundled Chromium runs headless without `xvfb`.

## Setup

```bash
cd .claude/skills/run-wacrm
npm install                      # installs playwright into this dir only
npx playwright install chromium  # cached at ~/AppData/Local/ms-playwright (or ~/.cache/ms-playwright on Linux) — fast/no-op if already present
```

The driver's `package.json`/`node_modules` are scoped to this skill
directory on purpose — Playwright is not a dependency of the app itself.

Root app env: `.env` at repo root already has the Supabase URL/keys the
dev server needs. Nothing extra to configure there.

The driver needs a **real Supabase user** — this repo has no
seed/test account:

```bash
export WACRM_EMAIL=...      # required — a real user on the connected Supabase project
export WACRM_PASSWORD=...   # required
export WACRM_BASE_URL=http://localhost:3000   # optional, this is the default
```

## Run (agent path)

1. Start the dev server in the background and wait for it to actually serve:

```bash
npm run dev > /tmp/wacrm-dev.log 2>&1 &
echo $! > /tmp/wacrm-dev.pid
timeout 40 bash -c 'until curl -sf http://localhost:3000 >/dev/null; do sleep 1; done'
```

2. Drive it — the one required arg is the path to visit after login
   (defaults to `/dashboard`):

```bash
cd .claude/skills/run-wacrm
WACRM_EMAIL=you@example.com WACRM_PASSWORD='...' node driver.mjs "/settings?tab=whatsapp"
```

It logs in, navigates to the given path, waits for the page to settle,
and writes a full-page screenshot to
`.claude/skills/run-wacrm/screenshots/<slugified-path>.png` (e.g.
`settings-tab-whatsapp.png`). It also prints any browser console errors
— an empty `console errors: []` is the thing to check before declaring
a page healthy.

3. Stop the server when done. On Windows/Git Bash, `kill $(cat
   /tmp/wacrm-dev.pid)` only kills the `npm` wrapper, not the actual
   `next-server` child — it keeps listening on :3000. Kill by port
   instead:

```bash
netstat -ano | grep ':3000' | grep LISTENING   # note the PID in the last column
taskkill //PID <pid> //F
```

On Linux/macOS `kill $(cat /tmp/wacrm-dev.pid)` (or `pkill -f "next dev"`)
is sufficient.

### Settings pages use `?tab=`, not subroutes

There is one `/settings` page; sections are chosen with a query param,
e.g. `/settings?tab=whatsapp`, `/settings?tab=templates`. There is no
`/settings/whatsapp` route — that 404s. See
`src/app/(dashboard)/settings/page.tsx`'s `resolveSection` for the list
of valid `tab` values.

## Run (human path)

`npm run dev` from the repo root, open `http://localhost:3000` in a
real browser, log in. Ctrl-C to stop.

## Test

```bash
npm run typecheck   # tsc --noEmit
```

No browser/e2e test suite exists in this repo yet — this skill's
driver is the only automated way to exercise the UI.

---

## Gotchas

- **First hit of a route on a cold `next dev` server can silently break
  a login/fill flow.** Next compiles routes on demand; if you
  `fill()` the email/password inputs before React finishes hydrating,
  the DOM *looks* filled (screenshot shows the value) but the
  controlled `useState` is still `""`, and submitting sends an empty
  field — Supabase returns `400 missing email or phone` with no toast,
  and the login form silently resets. The driver already waits for
  `networkidle` and then confirms the DOM's live input value equals
  what was just filled (via `waitForFunction`) before continuing — if
  you copy this pattern elsewhere, keep that guard.
- **Don't add Playwright to the app's own `package.json`.** It's only
  a driver dependency; installing it in `.claude/skills/run-wacrm/`
  keeps it out of the app's dependency tree. Its `node_modules` is
  covered by a `.gitignore` inside this skill directory (the root
  `.gitignore` only ignores `/node_modules` at the repo root, not
  nested ones).

## Troubleshooting

- **`Set WACRM_EMAIL and WACRM_PASSWORD...`**: the driver refuses to
  run without real credentials — there's no seeded test user in this
  project to fall back to.
- **Screenshot shows a blank `404` page**: you probably used a
  `/settings/<tab>`-style path. Use `/settings?tab=<name>` instead.
- **Auth network call 400s with `missing email or phone` even though
  the pre-submit screenshot shows the email filled in**: hydration
  race, see Gotchas above — restart the dev server fresh only if you
  suspect stale state; the real fix is already in the driver.
