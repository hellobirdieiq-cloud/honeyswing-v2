# HoneySwing — Backlog Brief (self-contained session-starter)

**Date:** 2026-07-16 · **HEAD = origin/main = `1de3912`** (verified `git log`/`git status` this date)
**Counts: 56 done · 3 partial · 6 deferred · 17 decision-queue · 18 open = 100 items** (98 original + T4-99 + T7-100).
Status source: `~/.claude/plans/honeyswing-99-item-scorecard.md` (through `1de3912`); item specs: `~/.claude/plans/implementation-plan-jolly-moonbeam.md` (canonical, wins on conflict).
⚠️ **Source disagreement, not silently resolved:** `docs/TODO_READABLE.md` header still reads 52/99 — it predates the Batch-6 subset and T7-100 and **needs regeneration**; this brief cites the scorecard.
DB claims below were verified live 2026-07-16 via Supabase MCP (advisors + catalog queries); each is tagged `[DB]`.

---

## 1. Full table (100 items)

| ID | Title | Status | Source |
|---|---|---|---|
| T1-1 | Record-Again mid-insert video loss/swap (capture-generation guard) | ✅ | 4012fa9 |
| T1-2 | Blur-mid-capture double-persist + video loss | ✅ | 4012fa9 |
| T1-3 | Legacy detector dead `===6` branch → silent null scores | ✅ | 714ebae |
| T1-4 | Face-on finish window breaks at 120fps (even rolling window) | ✅ | 714ebae |
| T1-5 | Sign-in verify bricks screen on throw | ✅ | 98dfa7d |
| T1-6 | REVOKE EXECUTE on `rls_auto_enable()` from anon/authenticated/public | ✅ | remote mig 20260708155325; mirror 1de3912; grants verified [DB] |
| T1-7 | Version stamps derived from expo-constants | ✅ | bdd7458 |
| T1-88 | Transient persist-insert failure permanently deletes the durable outbox clip | 🟡 | card below |
| T2-8 | Own-history views pollute Today's Focus / session stats / old rows | ✅ | d60a789 |
| T2-9 | Swing limit: counter + enforcement semantics | 🔶 | card below |
| T2-10 | DTL swing-start structurally can't fire ≤48fps | ✅ | 318e0d3 |
| T2-11 | Positive praise card unreachable (0–1 vs 75 threshold) | ✅ | 974e90e |
| T2-12 | Stale failure `.then` hijacks later capture's navigation | ✅ | 4012fa9 |
| T2-13 | Watch IMU late-join batches swallowed after refused/failed start | ✅ | fa39b14 (device-owed, T8-69) |
| T2-14 | Paywall infinite spinner offline | ✅ | 1c78a09 |
| T2-15 | Grip flow: worklet rebuild / unbounded nav stack / Use This disabled | ✅ | 214601d |
| T2-16 | History profile tabs stale (mount-only fetch) | ✅ | b4806f7 |
| T2-17 | Gallery cells permanently blank after one failed batch fetch | ✅ | b4806f7 |
| T2-18 | MediaPipe cleanup: dead pose plugins + 9MB model out of the build | ✅ | 3bf0f14 + 12eca28 (build-owed, T8-69) |
| T2-19 | `@supabase/supabase-js` devDependencies → dependencies | ✅ | 5d89769 |
| T2-20 | npm audit crit/highs via Clerk bump 3.2.8→3.7.1 | ✅ | ca6f028 (🔴 auth smoke device-owed, T8-69) |
| T2-21 | iOS mic/photo purpose strings | 🟡 | card below |
| T2-22 | Outbox missed-wakeup for entries eligible mid-drain | ✅ | 9fe37fc |
| T2-80 | Hung-persist spinner (failure-path nav ungated) | ✅ | 0534232 |
| T2-81 | Degenerate-timestamp floor lets sub-second captures through | 🟡 | card below |
| T2-89 | SimCC keypoint confidence max→min of per-axis peaks | ✅ | b243a60 (distribution review device-owed) |
| T2-90 | Withheld score renders literal "0" instead of em-dash | ✅ | 519d3f7 |
| T2-91 | Record-screen setup has no error path (bricked on throw) | ✅ | 519d3f7 |
| T2-94 | Session-insights engine half-dead (keys/trend/tempo/reset) | 🔶 | card below |
| T2-95 | OTA runtimeVersion pinned "1.0.0" + unconditional reload | 🟡 | card below |
| T3-23 | Covering index on `swings.user_id` | ✅ | 1de3912; index verified [DB] |
| T3-24 | RLS initplan: wrap `auth.uid()` → `(select auth.uid())` across policies | ⬜ | card below |
| T3-25 | `merge_swing_debug` SET search_path = '' | ✅ | remote mig 20260708160117; mirror 1de3912; proconfig verified [DB] |
| T3-26 | Consolidate permissive policies + review anon UPDATE on profiles | 🟡 | card below |
| T3-27 | `get_coach_by_code` SECURITY DEFINER anon-callable | 🟡 | card below |
| T3-28 | Verify-then-drop 3 unused indexes | ✅ | 1de3912; idx_scan=0 lifetime verified [DB] |
| T4-29 | D5 lowerBodyIdentity re-application idempotency | ✅ | 542b9c7 |
| T4-30 | D6 address-window `+9` literal → ms-derived | ✅ | 974e90e |
| T4-31 | D7 worstRatio never computed | ✅ | 974e90e |
| T4-32 | D8 inert suppression + mismatched hipSpread keys | ✅ | 974e90e |
| T4-33 | D9 fallback-phase index collisions on short captures | ✅ | 714ebae |
| T4-34 | D10 legacy trail-vs-frame index-space drift | ✅ | 974e90e |
| T4-35 | G7 increment-throw converts successful insert into abandon | ✅ | 548bba2 |
| T4-36 | G8 eventBus init clobber + signed-out drain scoping | ✅ | 8f8e3b5 |
| T4-37 | G9 outbox zero-row backoff frozen | ✅ | 9fe37fc |
| T4-38 | U9 liveSwingId subscribe gap | ✅ | 4012fa9 |
| T4-39 | U10 duplicate phase-chip row in no-video view | ✅ | d60a789 |
| T4-40 | U11 gallery heart clobbered mid-toggle | ✅ | b4806f7 |
| T4-41 | U13 grip overlays ignore cover-crop transform | ⏸️ | deferred — device tuning |
| T4-92 | DTL detector mixes frame-space and trail-space indices | ✅ | 1186ac1 |
| T4-96 | eventBus delivery holes (anon drain + trigger wiring) | ✅ | 8f8e3b5 + f35589d |
| T4-97 | Video-less skeleton replay blanks on one bad first frame | ✅ | 7144d5e |
| T4-98 | SwingArtCard impact glow drifts on trimmed trails | ✅ | 37022ba (operator's Swing Art V2) |
| T4-99 | Same-launch account-switch shares one eventBus sessionId | 🟡 | card below |
| T5-42 | extractPoseFromVideo coverage | ⏸️ | program-dropped 2026-07-07 |
| T5-43 | captureProcessing seams | ⏸️ | program-dropped |
| T5-44 | persistSwing real canary | ⏸️ | program-dropped |
| T5-45 | cameraAngle domain suite | ⏸️ | program-dropped |
| T5-46 | referralAttribution guard | ⏸️ | program-dropped |
| T5-47 | Hook-render test infra | 🟡 | card below |
| T5-48 | D1 regression test | ✅ | 714ebae |
| T6-49 | CLAUDE.md scoring/module/pipeline-order claims | ✅ | b0e5c19 |
| T6-50 | README paths/scoring/module claims | ✅ | b0e5c19 |
| T6-51 | ARCHITECTURE_MAP post-N1/post-5c sweep + sizes | ✅ | 95034b7 |
| T6-52 | Phase_Detection_Rules shadow-as-live inversion | ✅ | 3a628a6 |
| T6-53 | APP_STORE_READINESS coach-pivot cluster | ✅ | c0e2cee |
| T6-54 | Health-report measured baseline delta | ✅ | 5b3413a |
| T6-55 | In-code stale comments (faceOn top labels, captureProcessing header) | ✅ | fe7a543 |
| T6-56 | iOS deployment target 16.0 → 17.0 | ✅ | b0e5c19 |
| T7-57 | Crash reporting (none exists) | 🟡 | card below |
| T7-58 | ~592 ungated console.logs / gated-logger decision | 🟡 | card below |
| T7-59 | Grip tab is a dev-tools hub reachable in shipped builds | 🟡 | card below |
| T7-60 | Inert camera-guidance chain: kill or revive | 🟡 | card below |
| T7-61 | result.tsx vanished features: ship or delete | 🟡 | card below |
| T7-62 | Watch-IMU keep/delete | 🟡 | card below |
| T7-63 | Dead clinic builders in swingRowBuilders | ✅ | 01194c2 |
| T7-64 | Orphan VisualCoachCard + GripHistoryRow components | ✅ | 01194c2 |
| T7-65 | Anon key hardcoded in script → .env | ✅ | 5d89769 (leak ACCEPTED as risk 2026-07-08 → spawned T7-100) |
| T7-79 | no-swing navigation gated on stub insert (offline strands) | ✅ | 0534232 |
| T7-82 | player_profiles server mirror decision | 🟡 | card below — ⚠️ premise changed [DB] |
| T7-83 | Two stashes: inspect, apply-or-drop | ⬜ | card below |
| T7-84 | Refactor-branch delete decision | ⬜ | card below — ⚠️ target ambiguous |
| T7-85 | Watchlist swing df3f4a76 (only if anomaly repeats) | ⬜ | card below |
| T7-86 | reliability.impact written, read by nothing | ⬜ | card below |
| T7-93 | Android 100% broken end-to-end: gate/port/drop | 🟡 | card below |
| T7-100 | Migrate to `sb_publishable` API-key system (coexistence rotation) | 🟡 | card below |
| T8-66 | One instrumented device swing → extraction_breakdown ranking | ⬜ | card below |
| T8-67 | Extraction progress UI | ⬜ | card below |
| T8-68 | BBox-crop experiment | ⬜ | card below |
| T8-69 | The owed device+build session (3 HIGH items + ledger) | ⬜ | card below |
| T8-78 | Multi-MB synchronous JS near result-screen render | ⬜ | card below |
| T8-87 | Face-on guide outline-fraction tuning with the kids | ⬜ | card below |
| T9-70 | Retire/rebuild stale export-faceon-phase-analysis script (1,512L) | ⬜ | card below |
| T9-71 | Shared replay scaffold (`scripts/lib/`) | 🔶 | card below |
| T9-72 | PhaseRuleDebug rebuilt as inline literal ×~15 sites | ⬜ | card below |
| T9-73 | Extract pure `buildSwingDebug(...)` | ⬜ | card below |
| T9-74 | Legacy↔DTL detector copies + `0.008` floor drift | ⬜ | card below |
| T9-75 | Video-URI + frame↔time math trapped in hooks | ⬜ | card below |
| T9-76 | `swings` column set maintained in 3 parallel forms | ⬜ | card below |
| T9-77 | Detector-fabric triplication (PHASE_LABELS/ORDER ×3) | ⬜ | card below |

---

## 2. Action cards (38)

### Partial (3)

**T2-9 — swing limit semantics** 🔶
WHAT: The anonymous swing counter now increments and failed inserts no longer burn quota (fixed in 548bba2). What remains is a product decision: deleting a swing currently frees a quota slot for authed users (the limit is a live server count, `swingLimit.ts:94-97`), and `localSwingCount` is never decremented on delete, so anon and authed behave differently.
WHY QUEUED: Decision — is delete-recycles-quota intended? Options: (a) accept recycling (count live rows), (b) count lifetime swings (new counter column/event), (c) decrement local on delete for symmetry.
WHERE: `lib/swingLimit.ts`, `lib/persistSwing.ts`, `lib/deleteSwing.ts`.
EFFORT: S (code ~25m once decided).
DEPENDS ON: nothing.
RISK IF IGNORED: free users can loop record→delete→record forever; matters only when the paywall matters.

**T2-94 — session-insights reset listener (fix 4 of 4)** 🔶
WHAT: Fixes 1–3 shipped (655f075): flag keys translate, trends are deviation-from-ideal, tempo insights live. Remaining: `sessionAccumulator.reset()` has no production caller, so a "session" spans the entire app process — the file header's claimed "resets on background >5min" listener doesn't exist.
WHY QUEUED: Decision — what IS a session? Options: AppState background >N minutes (as documented), app launch only (status quo, fix the comment), or per-player-profile switch.
WHERE: `lib/sessionAccumulator.ts:234-240`, an AppState listener site (likely `app/_layout.tsx`).
EFFORT: S.
DEPENDS ON: nothing.
RISK IF IGNORED: insights blend yesterday's swings into today's "session" on a never-killed app; mildly wrong praise, not data loss.

**T9-71 — shared replay scaffold** 🔶
WHAT: The paged corpus-digest tool is promoted under the canonical `scripts/replayCorpusDigest.ts` name (904b1f3, round-trip verified). Remaining: ≥10 replay scripts still each re-implement the fetch→identity→veto→canonical preamble, and `buildTrailPoints` is unexported so scripts hand-rebuild trails.
WHY QUEUED: Sized as workstream-G infrastructure (face-on detector program) — build `scripts/lib/` replay-common when that workstream starts, not before.
WHERE: `scripts/lib/` (new), `packages/domain/swing/analysisPipeline.ts:161` (`buildTrailPoints` export), 2–3 scripts migrated as proof.
EFFORT: L (~90m).
DEPENDS ON: face-on workstream G kickoff; T9-70 pairs with it.
RISK IF IGNORED: every future validation script re-derives the preamble; drift risk between scripts and the live pipeline (already bit once — T9-70's stale twin).

### Decision queue (17)

**T1-88 — outbox clip deleted on transient insert failure** 🟡
WHAT: When `persistSwing`'s insert throws (network/5xx), `captureProcessing.ts` flattens the throw into the same `null` as the legitimate no-user return; reconcile then abandons the durable video entry. The outbox is defeated for exactly the failure class it was built to survive — clip gone, row never exists, no retry.
WHY QUEUED: Decision — insert retry policy: hold entries for later retry (how long? dead-letter after N?), or accept abandon with telemetry. Note: the 2026-07-15 queue-until-login work (5003f7c) added held-entry machinery (`outbox.ts` `held` flag) that may now be reusable here — re-evaluate before designing from scratch.
WHERE: `lib/captureProcessing.ts` (failure-signal threading), `packages/domain/swing/captureFlow.ts:143-145` (`planOutboxReconcile`), `lib/outbox.ts`.
EFFORT: M (~60m).
DEPENDS ON: nothing hard; benefits from the queue-until-login `held` machinery.
RISK IF IGNORED: an authed kid's real swing silently vanishes on one bad network moment — the worst data-loss class left in capture.

**T2-21 — iOS mic/photo purpose strings** 🟡
WHAT: The location purpose string was flagged in the readiness audit; mic and photo-library strings are absent while the app may (or may not) technically touch those capabilities via recording with audio or photo APIs.
WHY QUEUED: Half-decision, half-grep: check `startRecording` for `audio:` and any photo-library API use; add strings only for what's real, delete what isn't.
WHERE: `app.json` (infoPlist), `app/(tabs)/record.tsx` (recording options).
EFFORT: S.
DEPENDS ON: nothing.
RISK IF IGNORED: App Store review friction (5.1.1 pattern) at full-review time; TestFlight-internal unaffected.

**T2-81 — degenerate-timestamp floor** 🟡
WHAT: `captureValidity.ts` converts the 1200ms validity floor to frames via measured `msPerFrame`; degenerate frame timestamps can shrink `validMinFrames` so a ~500ms junk capture sneaks through as "valid". The fallback is intentional and pinned by test group C5.
WHY QUEUED: Decision — overturn the pinned design? Options: clamp `msPerFrame` to sane bounds, or gate on wall-clock duration as well, or keep (documented) if degenerate timestamps can't occur post-RTMW.
WHERE: `packages/domain/swing/captureValidity.ts:55`, `captureValidity.test.ts` group C5.
EFFORT: M (constructing the degenerate case is most of it).
DEPENDS ON: nothing.
RISK IF IGNORED: sub-second junk reaching analysis as "valid" — never observed in the field; latent.

**T2-95 — OTA runtimeVersion "1.0.0" + reload-on-launch** 🟡
WHAT: `app.json:75` pins `runtimeVersion: "1.0.0"` while native modules churn; `_layout.tsx` auto-applies updates on launch. Any published JS bundle reaches EVERY binary ever shipped under that string — a bundle referencing new native methods crash-loops old builds.
WHY QUEUED: Decision — `{"policy": "fingerprint"}` vs `{"policy": "appVersion"}` + whether to defer `reloadAsync` to next cold start.
WHERE: `app.json:75`, `app/_layout.tsx:88-100`.
EFFORT: S (~20m once decided).
DEPENDS ON: nothing — but urgency CHANGED: TestFlight builds 1.10.2–1.10.4 shipped this week (05b8d8e/76acf15/4a771df) all under runtime "1.0.0"; the blast radius is no longer hypothetical.
RISK IF IGNORED: one OTA publish after the next native change can crash-loop every installed TestFlight build.

**T3-26 — permissive policies + anon UPDATE on profiles** 🟡
WHAT: Advisors show multiple permissive policies on the same role/action for `profiles` (UPDATE — including for `anon`), `swings`, `coaches`, `player_profiles` [DB, 2026-07-16]. The anon-UPDATE pair (`"Users can update own profile"` + `users_update_own_referral`) needs a review: can anon actually write anything?
WHY QUEUED: Decision — consolidate which policies, and is any anon write path intended? Discipline: snapshot `pg_policies` before ANY change (rollback), per the Batch 6 kickoff.
WHERE: prod DB policies on `profiles`/`swings`/`coaches`/`player_profiles`; migration under `supabase/migrations/`.
EFFORT: M.
DEPENDS ON: gates T3-24 (do the initplan rewrite only on the post-consolidation set).
RISK IF IGNORED: possible unintended anon write hole on profiles (unverified either way) + per-query policy overhead; the security half deserves a look before wider distribution.

**T3-27 — `get_coach_by_code` anon-callable** 🟡
WHAT: SECURITY DEFINER function callable by anon via REST (`/rest/v1/rpc/get_coach_by_code`) — now the ONLY security advisor warning left [DB, 2026-07-16]. Probably intentional (referral-code lookup at sign-up) but unreviewed: field exposure and rate limiting.
WHY QUEUED: Decision — intentional? If yes: constrain returned fields + consider rate limit; if no: REVOKE like T1-6.
WHERE: prod DB function `public.get_coach_by_code(text)`; `lib/referralAttribution.ts` is the client caller.
EFFORT: S.
DEPENDS ON: nothing.
RISK IF IGNORED: anon can enumerate coach codes/names by brute force; low-value data, but it's the last advisor warn.

**T4-99 — sign-out doesn't reset eventBus session** 🟡
WHAT: Within one app launch, `startSession` runs once; neither sign-out nor sign-in resets it. If user A signs out and B signs in without an app restart, A's pre-auth events (same sessionId) could be stamped with B at drain — benign in common flows, not airtight on a shared kids device.
WHY QUEUED: Decision — wire session reset into the Clerk auth-change/sign-out path (endSession + fresh startSession), or accept as documented.
WHERE: `lib/eventBus.ts` (~:430 drain-time backfill), `app/(tabs)/settings.tsx:173` / `lib/supabase.ts:86` (sign-out hooks).
EFFORT: S (~30m once decided).
DEPENDS ON: nothing.
RISK IF IGNORED: rare cross-user analytics misattribution on shared devices; no user-visible effect.

**T5-47 — hook-render test infra** 🟡
WHAT: `useSwingCapture` (490L) and `useWatchImuCapture` (420L) are untestable without hook-render infrastructure; every capture-ordering regression is device-only today.
WHY QUEUED: Decision — adopt infra (~90m) or keep the device-testing strategy. The program explicitly dropped test debt (2026-07-07), so this needs an owner reversal to proceed.
WHERE: test runner (`scripts/run-tests.mjs`), the two hooks.
EFFORT: L.
DEPENDS ON: contradicts the standing no-new-tests directive — decide the directive first.
RISK IF IGNORED: none new — the T8-69 device checklist is the accepted alternative.

**T7-57 — crash reporting** 🟡
WHAT: No crash reporting, no global error handler, no rejection tracking anywhere. Field failures die silently.
WHY QUEUED: Decision — Sentry (service, weight, privacy review for a kids app) vs minimal `ErrorUtils.setGlobalHandler` + rejection hook feeding the existing `events` telemetry.
WHERE: `app/_layout.tsx` (handler install), `lib/eventBus.ts` (`error.captured` already exists as an event type).
EFFORT: M (~60m incl. forced-crash verify).
DEPENDS ON: nothing.
RISK IF IGNORED: TestFlight users now exist (1.10.2–1.10.4 shipped) — crashes in the field are currently invisible.

**T7-58 — gated logger (~592 console calls)** 🟡
WHAT: ~592 ungated `console.log`s in prod paths; no logger utility exists in the tree, so this is a new-abstraction decision, not a sweep.
WHY QUEUED: Decision — introduce a `__DEV__`-gated logger (then migrate incrementally), use babel `transform-remove-console` in prod builds (zero code churn), or accept.
WHERE: everywhere; babel option = `babel.config.js` only.
EFFORT: S for the babel route; L for a logger migration.
DEPENDS ON: nothing.
RISK IF IGNORED: log overhead + accidental PII in device logs; low.

**T7-59 — grip dev-tools hub ships** 🟡
WHAT: The grip tab hosts dev tools (LiDAR demo, outline-test, apple-vision-capture) reachable in shipped builds via deep link even though the tab is `href: null`.
WHY QUEUED: Decision — route-gate for prod, delete the dev screens, or accept for TestFlight. Rider: `lib/swingStore.ts getGripHistory` has zero production consumers since 01194c2 — it goes wherever grip surfaces go.
WHERE: `app/grip/*`, `app/(tabs)/grip.tsx`, `lib/swingStore.ts:360`.
EFFORT: S (gate) / M (delete).
DEPENDS ON: pairs with T7-61's grip-adjacent calls.
RISK IF IGNORED: App Store reviewer can deep-link into obvious dev screens; TestFlight-internal fine.

**T7-60 — inert camera-guidance chain** 🟡
WHAT: A guidance pill/chain (separation + color) computes and persists per swing but drives no user-visible behavior — discovered inert during the 2026-07-06 audits.
WHY QUEUED: Decision — kill (~25m) or revive (~90m, needs design).
WHERE: `lib/cameraGuidance.ts`, `record.tsx` plumbing, `swing_debug.camera_angle_at_start`/`camera_guidance_color`.
EFFORT: S to kill / L to revive.
DEPENDS ON: nothing.
RISK IF IGNORED: none functional — dead weight inviting accidental edits.

**T7-61 — result.tsx vanished features** 🟡
WHAT: gripCloud/limitHit/coachName/positiveResult UI disappeared in c2f7d5a while their effects still run. Standing instruction: do NOT delete in refactors — ship-or-delete is a product call.
WHY QUEUED: Product decision per feature: restore the UI or delete effect + plumbing.
WHERE: `app/analysis/result.tsx`, `app/analysis/useSwingSource.ts:48,141` (gripCloud).
EFFORT: M either way.
DEPENDS ON: overlaps T7-59 (gripCloud) and the positive-reinforcement surface (T2-11 made the praise card reachable — decide together).
RISK IF IGNORED: effects burn cycles and confuse every future reader; the 3 standing lint warnings live here.

**T7-62 — watch-IMU keep/delete** 🟡
WHAT: The Apple Watch IMU capture path is parked: `targets/watch` disabled, but `@bacons/apple-targets` is still an active plugin, `withHoneyNative.js` still force-links WatchConnectivity + bundles HoneyWatchImuModule, and `useWatchImuCapture`/imu-debug remain.
WHY QUEUED: Product decision — finish the watch feature (a project) or delete (~45m). DELETE also moots the G5 device check AND clears the 3 remaining npm-audit highs (`@bacons/xcode` chain).
WHERE: `targets/watch/`, `plugins/withHoneyNative.js`, `lib/useWatchImuCapture.ts`, `app/clinic/imu-debug.tsx`, `app.json` plugins.
EFFORT: S to delete / L to finish.
DEPENDS ON: G5's T8-69 slot exists only if KEEP.
RISK IF IGNORED: ~1,200 parked lines + a framework linked into every build for a feature nobody can use.

**T7-82 — player_profiles server mirror** 🟡 ⚠️ premise changed
WHAT: Ticketed as "server mirror has 0 rows — backfill or accept local-first." **The premise no longer holds: live DB has 5 player_profiles rows [DB `select count(*)`, 2026-07-16]** — the queue-until-login/profile-filter work (5003f7c/ed98b4a) evidently began syncing.
WHY QUEUED: Decision — but it needs RE-SCOPING first: verify whether sync is now systematic (all devices/profiles) or incidental, then decide whether any backfill remains.
WHERE: `lib/playerProfilesSync.ts`, `player_profiles` table.
EFFORT: S to verify + decide.
DEPENDS ON: nothing.
RISK IF IGNORED: coach view reads this table — partial sync means coaches see partial rosters.

**T7-93 — Android 100% broken** 🟡
WHAT: All pose natives are iOS-only; Android records fine then every swing throws in extraction → "no swing" screen, every time. Zero `Platform.OS` gating on the record tab; `expo run:android` + committed android/ make it a supported-looking target.
WHY QUEUED: Decision — (a) gate record on Android with an unsupported message (~30m), (b) Android pose port (a project), (c) drop the android/ target.
WHERE: `app/(tabs)/record.tsx`, `modules/vision-camera-pose/src/rtmw.ts:38-50`, `android/`.
EFFORT: S (gate) / L (port).
DEPENDS ON: nothing.
RISK IF IGNORED: anyone building Android ships a product whose core feature fails silently on every use.

**T7-100 — migrate to `sb_publishable` API keys** 🟡
WHAT: The legacy anon key is in git history; the owner accepted the leak as documented risk (2026-07-08) with this as the mitigation path: adopt Supabase's new publishable-key system — new + legacy keys coexist, ship/OTA the new key, disable the legacy anon key after old builds age out.
WHY QUEUED: Timing decision — the coexistence window should start after OTA targeting is fixed (T2-95), else old binaries can't receive the new key.
WHERE: Supabase dashboard (key issuance), `.env` + `lib/supabase.ts` (key consumption), an OTA/binary release.
EFFORT: M (spread over a coexistence window).
DEPENDS ON: T2-95 (sane OTA targeting makes the rotation deliverable); binaries shipping (already true — 1.10.4).
RISK IF IGNORED: the leaked RLS-scoped key stays valid indefinitely; measured anon surface was zero rows readable, so exposure is bounded but permanent.

### Open (18)

**T3-24 — RLS initplan rewrite** ⬜
WHAT: 16 policies re-evaluate `auth.uid()` per row (advisor WARN ×16 [DB, 2026-07-16]); wrap each in `(select auth.uid())`.
WHY QUEUED: Deliberately sequenced AFTER the T3-26 consolidation decision so policies aren't rewritten twice.
WHERE: prod DB policies (profiles/swings/events/coaches/player_profiles/grip_analyses); migration + `pg_policies` snapshot as rollback.
EFFORT: M (~40m + pinned RLS smoke per the Batch 6 kickoff).
DEPENDS ON: T3-26.
RISK IF IGNORED: per-row re-evaluation overhead — negligible at 85 swings, real at scale.

**T7-83 — two stashes** ⬜
WHAT: `stash@{0}` "pre-outline-test-lidar-tuning-and-avh-log" and `stash@{1}` "pre-phase3-build-untracked", both on `clean-release` (verified `git stash list`, 2026-07-16). Inspect and apply-or-drop.
WHY QUEUED: Nobody has looked inside; trivial but requires eyes.
WHERE: git stashes.
EFFORT: S.
DEPENDS ON: nothing.
RISK IF IGNORED: none — stashes are stable; only archaeology debt.

**T7-84 — refactor-branch delete** ⬜ ⚠️ target ambiguous
WHAT: A branch kept after the --no-ff merge 416e376 awaits a delete decision. **No branch named "refactor" exists** — live branches: `clean-release`, `docs/architecture-map-deep-dive`, `feat/result-view-modes`, `feat/watch-automode`, `feat/watch-imu`, `feat/z-depth-flip`, `feature/roi-crop` (verified `git branch`, 2026-07-16). Which one the ticket means is UNKNOWN from repo+memory.
WHY QUEUED: Owner identification + delete call; several `feat/*` branches probably deserve the same review.
WHERE: git branches.
EFFORT: S.
DEPENDS ON: T7-62 for the two watch branches.
RISK IF IGNORED: none — clutter.

**T7-85 — watchlist swing df3f4a76** ⬜
WHAT: One swing flagged anomalous in early July; the standing instruction is to investigate ONLY if the anomaly repeats (check attributed handedness first).
WHY QUEUED: Conditional by design.
WHERE: `swings` row df3f4a76 (prod).
EFFORT: S if triggered.
DEPENDS ON: recurrence.
RISK IF IGNORED: none unless it recurs.

**T7-86 — reliability.impact dormant** ⬜
WHAT: Both detectors write `reliability.impact`; nothing reads it (tempo/scoring/angles/finish/trends all ignore it). Propagation was deliberately deferred until the xCross consensus impact validates on-device.
WHY QUEUED: Blocked on that validation (T8-69's fresh-capture review).
WHERE: `phaseDetectionFaceOn.ts:909`-region, `phaseDetectionDTL.ts:412`-region, consumers TBD.
EFFORT: S once unblocked.
DEPENDS ON: T8-69 (impact validation on fresh captures).
RISK IF IGNORED: a computed trust signal keeps being thrown away; withheld-tempo decisions stay coarser than they could be.

**T8-66 — instrumented device swing** ⬜
WHAT: Capture one real swing and read `swing_debug.extraction_breakdown` (decode vs inference vs metadata-probe) to rank the perf levers (ec9fcf1 instrumented the pipeline; nobody has read a real breakdown yet).
WHY QUEUED: Needs a physical device.
WHERE: device + `swing_debug` on the resulting row.
EFFORT: S.
DEPENDS ON: rides the T8-69 session.
RISK IF IGNORED: perf work (T8-68/T8-78) stays unprioritized guesswork.

**T8-67 — extraction progress UI** ⬜
WHAT: ~11s median extraction with no progress indication; a progress UI is a pure perceived-latency win, no telemetry needed.
WHY QUEUED: Never scheduled; UI work.
WHERE: `record.tsx`/analyzing indicator surface, fed by extraction progress events (native emit would need adding to `HoneyRtmwOneShotPlugin`).
EFFORT: M.
DEPENDS ON: nothing.
RISK IF IGNORED: kids stare at a spinner for 11s; retention cost unknown.

**T8-68 — bbox-crop experiment** ⬜
WHAT: BBox cropping is plumbed end-to-end but unused; cropping to the golfer could improve keypoint accuracy and speed.
WHY QUEUED: Needs corpus validation (accuracy lever) + device timing; profile-gated on T8-66.
WHERE: `modules/vision-camera-pose/src/rtmw.ts` (boundingBox param), `HoneyRtmwOneShotPlugin.swift`.
EFFORT: M + corpus pass.
DEPENDS ON: T8-66.
RISK IF IGNORED: none — dormant capability.

**T8-69 — THE device+build session** ⬜
WHAT: One physical device + one EAS build clears the accumulated verification ledger. 3 HIGH: (1) N1-native build proof [12eca28] — builds without the pose plugins, grip works, 9MB .task gone; (2) G5 watch handoff [fa39b14] — real watch+phone; (3) Clerk auth smoke [ca6f028] — pod install, `grep -E 'GoogleSignIn|AppAuth|GTM|Recaptcha' ios/Podfile.lock` EMPTY, sign-in/verify/sign-out. Plus: SimCC distribution review [b243a60], Batch 1/3 concurrency+UI checks, 5c riders (offline no-swing, insight truthfulness, skeleton bad-frame-0, drain-on-foreground), 120fps validation, U13/T8-87 tuning.
WHY QUEUED: Requires the user, a device, and a build — cannot be done from this desk.
WHERE: physical device, EAS.
EFFORT: L (one session, ~2h).
DEPENDS ON: nothing — everything else depends on IT. Note: TestFlight 1.10.2–1.10.4 shipped this week; if those builds included the post-N1/post-Clerk native tree, parts of HIGH-1/3 may already be implicitly proven — verify which commit the builds were cut from before re-testing.
RISK IF IGNORED: every trace-verified fix since Batch 1 remains untrusted on hardware; the Clerk auth risk rides every TestFlight build.

**T8-78 — multi-MB sync JS near render** ⬜
WHAT: Full pose-stream `JSON.stringify(frames)` (outbox capture) and video base64→ArrayBuffer decode run on the JS thread around result-screen render.
WHY QUEUED: Profile-gated: confirm it actually janks (T8-66's instrumented swing) before optimizing (URI-streaming upload, deferred stringify).
WHERE: `lib/outbox.ts` (stringify + base64 sites — note outbox.ts was reworked 2026-07-15, re-locate the lines).
EFFORT: M.
DEPENDS ON: T8-66.
RISK IF IGNORED: possible dropped frames/jank right as the result screen animates; unmeasured.

**T8-87 — outline-fraction tuning with the kids** ⬜
WHAT: Face-on guide fractions junior .40/youth .46/teen .52 are UNTUNED (adult .57 tuned); tune with Luca + Leighto at real filming distance, then strip the UNTUNED labels.
WHY QUEUED: Needs the kids on-site.
WHERE: `components/faceOnGuideSizing.ts`.
EFFORT: S (device session).
DEPENDS ON: rides T8-69 or any device sitting with the kids.
RISK IF IGNORED: mis-sized framing guide for non-adult tiers; cosmetic-to-mild UX.

**T9-70 — export-faceon-phase-analysis retire/rebuild** ⬜
WHAT: `scripts/export-faceon-phase-analysis.ts` (1,512L — the repo's largest file) is a stale parallel reimplementation of the whole detector (36fps constants, drifted impact rule). Any replay report from it is untrustworthy.
WHY QUEUED: Gates face-on workstream G — retire it or rebuild on the real detector before that workstream trusts any report.
WHERE: the script; rebuild target = `detectFaceOnPhasesDebug`/`runFaceOnPhaseSequence`.
EFFORT: M (retire) / L (rebuild).
DEPENDS ON: workstream G timing; pairs with T9-71.
RISK IF IGNORED: someone runs it and believes it.

**T9-72 — PhaseRuleDebug inline literal ×~15** ⬜
WHAT: The `PhaseRuleDebug` shape is rebuilt as an inline literal at ~15 gate sites across two detectors; one mutable `ruleDebug` per run would collapse them.
WHY QUEUED: On-trigger — do when workstream B/D next adds a field to the shape.
WHERE: `phaseDetectionFaceOn.ts`, `phaseDetectionDTL.ts`.
EFFORT: M.
DEPENDS ON: its trigger.
RISK IF IGNORED: adding one debug field = ~15 edit sites; miss one and telemetry silently loses it.

**T9-73 — extract `buildSwingDebug(...)`** ⬜
WHAT: `swing_debug` assembly is two untested inline literals (`persistSwing.ts` + `analysisPipeline.ts`); extract a pure builder with a shape test into `swingRowBuilders.ts`.
WHY QUEUED: On-trigger — first persistSwing edit (NOTE: queue-until-login 5003f7c touched persist heavily; the trigger may already have fired — check whether `buildSwingRow` from that work absorbed this).
WHERE: `lib/persistSwing.ts`, `packages/domain/swing/analysisPipeline.ts:787-812`, `swingRowBuilders.ts`.
EFFORT: M.
DEPENDS ON: trigger (possibly already fired).
RISK IF IGNORED: the two literals drift; swing_debug keys silently diverge between success and stub paths.

**T9-74 — legacy↔DTL detector copies (+ T9-77 merged)** ⬜
WHAT: Legacy and DTL detectors are line-for-line copies of top/impact/finish + sanity gates, with one real drift (raw `0.008` floor vs `scalePerFrameFloor`); plus PHASE_LABELS/PHASE_ORDER defined 3× (T9-77 executes inside this commit). Lift shared parts into `phaseDetectionShared.ts`.
WHY QUEUED: Waits on the legacy keep/retire disposition (legacy = backup-only since the face-on pivot).
WHERE: `phaseDetectionLegacy.ts`, `phaseDetectionDTL.ts`, `phaseDetectionFaceOn.ts`, `phaseDetectionShared.ts`.
EFFORT: M (~60m, one commit with T9-77).
DEPENDS ON: legacy disposition; corpus digest lock applies.
RISK IF IGNORED: the `0.008` drift class recurs — fixes land in one detector and not its twin.

**T9-75 — video-URI + frame↔time math extraction** ⬜
WHAT: Video-URI resolution and frame↔time conversions live inside hooks; extract a pure resolver + `frameToVideoTime`/`videoTimeToFrame`.
WHY QUEUED: On-trigger — scheduled for workstream E (replay/viewer work).
WHERE: `app/analysis/useSwingVideoClock.ts`, `useSwingSource.ts`.
EFFORT: S/M (~40m).
DEPENDS ON: its trigger.
RISK IF IGNORED: frame/time math forks between replay surfaces (already bit the viewer repo once — impact_thumb rename).
 
**T9-76 — swings columns ×3 → manifest** ⬜
WHAT: The `swings` column set is maintained by hand in three parallel forms (insert literal / `SWING_RECORD_COLUMNS` / `SwingRecord` type); derive from one manifest.
WHY QUEUED: On-trigger — first new swings column (NOTE: queue-until-login added `captured_at_iso` — check whether the trigger fired and the three forms are already drifting).
WHERE: `lib/persistSwing.ts`, `lib/swingStore.ts`, `lib/database.types.ts` consumers.
EFFORT: M.
DEPENDS ON: trigger (possibly already fired).
RISK IF IGNORED: a new column added to 2 of 3 forms = silent read gaps (the viewer-repo class of bug).

**T9-77 — detector-fabric triplication** ⬜
WHAT: PHASE_LABELS/PHASE_ORDER ×3 + per-detector sanity-gate ladders. Merged into T9-74's commit at execution; kept as a separate entry for provenance only.
WHY QUEUED / WHERE / EFFORT / DEPENDS ON / RISK: see T9-74.

---

## 2b. Post-100 addendum (added outside the canonical 100; not in the counts)

**P-101 — full-swing score recompute from operator phases** ✅ (2026-07-17)
WHAT: a phase-override input to the full-swing analysis pipeline that consumes
`swing_debug.operator_labels` (the annotate-only labels shipped with the operator label
mode) and recomputes tempo/score from operator frames — the full-swing twin of the putting
"Save Corrections" authoritative path.
SHIPPED AS: NEW seam `packages/domain/swing/operatorRegrade.ts` (composes the real
calculateTempo/isTempoTrustworthy/scoreSwing on merged phases — no whole-pipeline re-run:
historical rows can't replay tilt correction, and the headline score is tempo-only) +
`app/analysis/useFullSwingRegrade.ts` view-model + Auto|Yours toggle on the result card.
Owner decision: option (a) row-rewrite on save (score/tempo_ratio/backswing_ms/
downswing_ms/honey_boom get the Yours values; row updates on SAVE only, never on open).
Auto side is recomputed from the row's original detected phases (or the
operator_labels.detected snapshot), never the row columns. Known limit: phase-windowed
angles are NOT recomputed from operator frames.

**P-103 — extract shared phase-label interaction hook** ⬜ (logged at FIX 4b approval, 2026-07-19)
WHAT: the two-tap-arm/re-stamp, detected-seek flash, frame stepping/clamping, and
numeric frame-input logic is now DUPLICATED between `components/PhaseLabelBar.tsx`
(putting panel) and `components/VideoLabelOverlay.tsx` (full-swing edge overlay, FIX 4b).
Extract a shared `usePhaseLabelInteraction` hook both components consume.
WHY QUEUED: owner directive at FIX 4b approval — do NOT refactor now (putting panel must
stay byte-identical; extraction is a behavior-neutral cleanup for its own session).
WHERE: components/PhaseLabelBar.tsx, components/VideoLabelOverlay.tsx (+ new hook file).
EFFORT: S. DEPENDS ON: none. RISK IF IGNORED: the two copies drift (e.g. a seek-pause or
arm-semantics fix landing in only one surface).

**P-102 — phase chips follow the Yours view** ⬜ (parked at P-101 approval, 2026-07-17)
WHAT: when the result card shows Yours, the phase chips (and skeleton phase markers)
still seek to the AUTO detected frames; swap them to the effective (operator-merged)
phases under Yours. `regradeFromOperatorPhases` already returns `effectivePhases`.
WHY QUEUED: owner directive — display-scope creep kept out of P-101; chips stay Auto.
WHERE: `app/analysis/result.tsx` (PHASE_CHIPS row + SwingSkeletonCanvas `phases` prop).
EFFORT: S. DEPENDS ON: P-101 (done). RISK IF IGNORED: minor operator confusion —
chips seek to Auto frames while the card shows Yours numbers.

---

## 3. Suggested order — ⚠️ OPINION, not status

1. **T2-95 (OTA runtime pin)** — the risk went live this week: three TestFlight builds shipped under runtime "1.0.0"; one OTA publish after the next native change can crash-loop all of them. 20 minutes once you pick `fingerprint`.
2. **T8-69 (device+build session)** — everything since Batch 1 is trace-verified only; three HIGH items and ~15 riders clear in one ~2h sitting, and it may already be partially proven by the 1.10.x builds (verify their base commit first).
3. **T7-57 (crash reporting)** — you now have real TestFlight users and zero visibility into field crashes; even the minimal ErrorUtils+events route beats blindness.
4. **T3-26 → T3-24 (finish Batch 6)** — one decision (policy consolidation + the anon-UPDATE review) unlocks the last mechanical migration; closes the whole DB-hygiene tier and the last security review.
5. **T7-62 (watch-IMU keep/delete)** — one decision retires ~1,200 parked lines, the G5 device check, AND the 3 remaining npm-audit highs; the highest leverage-per-decision item on the board.

---

*Regeneration note: rebuild this file from the scorecard + live checks; don't hand-patch counts. `docs/TODO_READABLE.md` needs the same regeneration (its header is 2 batches stale).*
