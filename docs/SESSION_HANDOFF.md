# HoneySwing — Session Handoff

_Snapshot: 2026-07-01. Verified against disk (commit, tests, versions, icon). Numbers go stale after real work — re-verify before relying on them._

## 0. ⚠️ Release blocker — read before shipping

**Do NOT cut an App Store build from the current branch.** Work sits on
`refactor/extract-swing-write-path-helpers`, which is **stacked on the unfinished,
parked Apple Watch IMU bundle**. A production build here would ship that half-built
feature *and* the entire stacked bundle to the public App Store.

Before any release: get the intended code onto a **clean branch off `main`**
(rebase/merge the wanted commits) and decide the Watch feature's fate. Only then
run the EAS steps in §6. (Tracked in memory: branch-stack parking.)

## 1. Architecture file

`docs/architecture/ARCHITECTURE_MAP.md` — current and accurate as of 2026-06-30
(full tree, per-area line counts, runtime flow, scoring model, whole-repo size
reconciliation). ⚠️ Goes stale after file moves or test changes — refresh after
real work.

## 2. The 5 audit issues

| # | Issue | Status |
|---|---|---|
| 1 | Test runner only scanned `lib/` (22 domain tests never ran) | ✅ FIXED (`773cabd`) |
| 2 | 5 domain tests misfiled in `lib/` | ✅ FIXED (`55d235c`; moved to `packages/domain/swing/`, fixed 2 latent bugs the move exposed) |
| 3 | `lib/` junk drawer (~8 pure/domain files misfiled) | ❌ NOT DONE |
| 4 | `persistSwing.ts` + `useSwingCapture.ts` do too much | 🟡 PARTIAL (pure row/flow helpers extracted → `swingRowBuilders.ts`, `captureFlow.ts`) |
| 5 | Giant screens — `result.tsx` (850 lines), `settings.tsx` (797 lines) | ❌ NOT DONE |

**Score: 2 fixed · 1 partial · 2 left.**

## 3. Known red tests (pre-existing — accepted as known risk)

`npm test` → 46 files, 43 pass, **3 fail**:
- `lib/tipFrequency.test.ts` — stale expectation (needs domain sign-off)
- `packages/domain/swing/metricDefinitions.test.ts` — stale expectation
- `packages/domain/swing/phaseDetectionDTL.test.ts` — 0 phases; **scoring-critical**; own session

These are pre-existing (surfaced, not caused, by the runner fix). Decision on
record: **ship anyway** — accepted known risk, not a release gate. Triage tracked
in memory.

## 4. Branch note (parked)

Everything sits on `refactor/extract-swing-write-path-helpers`, stacked on the
unfinished Watch bundle (see §0). Next: rebase to a clean branch off `main`, or
decide the Watch feature's fate. Tracked in memory.

## 5. Everything committed & pushed

Nothing lost. Branch `refactor/extract-swing-write-path-helpers` is pushed to
origin. Latest commit: **`121d699`** — "Update ARCHITECTURE_MAP Code size for the
lib/→packages test move". Recent: test move + doc refresh + write-path extraction.

## 6. Ship a new version to the App Store (EAS)

Gated on §0 (resolve the branch first). Verified facts this build relies on:
- `app.json`: `version` **1.10.0**, iOS `buildNumber` **49**, bundle
  `com.honeyswing.honeyswing-v2`, icon `./assets/images/icon.png`.
- **Icon is already correct** — verified a smiley-face golf ball, 1024×1024, no
  alpha. **No icon change needed.**
- `eas.json`: profile **`production`** (build + submit), `ascAppId` `6760777790`,
  and crucially **`appVersionSource: "remote"` + `autoIncrement: true`**.

**Step 0 — resolve the branch (see §0).** Do not proceed on the stacked branch.

**Step 1 — bump the marketing version only.** In `app.json` bump `version`
`1.10.0 → 1.10.1`. **Do NOT hand-edit `buildNumber`** — with `appVersionSource:
"remote"` + `autoIncrement: true`, EAS manages the build number server-side; a
manual bump is ignored/conflicting. Commit "Bump version for App Store release"
(show the diff first). _(Confirm current EAS versioning behavior before relying on it.)_

**Step 2 — icon.** Skip — already the correct smiley golf ball.

**Step 3 — build.** `eas build --platform ios --profile production`
(requires `eas login` + Apple credentials; outward-facing). Paste the build URL.

**Step 4 — submit.** After the build finishes:
`eas submit --platform ios --profile production --latest`. Paste the output.

**Step 5 — App Store Connect (by hand).** appstoreconnect.apple.com → My Apps →
HoneySwing → "+" next to iOS App → new version → enter version → add "What's New"
→ under Build pick the just-uploaded build (~10–15 min to appear) → "Add for
Review" → "Submit for Review." Apple reviews in ~1–2 days.

### Optional: project-instruction trigger
To make "eas build" always run §6, add this line to the project instructions
(via settings/config, not `app.json`):

> When I say "eas build" or "ship a new version": (1) confirm the release branch is
> a clean branch off main (not the stacked Watch bundle), (2) read app.json
> (version/buildNumber/icon) + eas.json (profiles), (3) bump the marketing `version`
> only — buildNumber is remote/autoIncrement — and commit after showing the diff,
> (4) confirm the icon, (5) run `eas build --platform ios --profile production`,
> (6) run `eas submit --platform ios --profile production --latest`, (7) tell me to
> finish in App Store Connect. Show diffs before commits.
