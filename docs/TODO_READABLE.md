# HoneySwing — Readable TODO

**Regenerated 2026-07-08 (Batch 7) from the status scorecard** (`~/.claude/plans/honeyswing-99-item-scorecard.md` — statuses reconciled against `git log`, not memory) **+ the canonical plan for item specs** (`~/.claude/plans/implementation-plan-jolly-moonbeam.md` — wins on any conflict; holds the Findings Register, Corpus Coverage Facts, and Classification Resolution referenced by ID below). This file is a tracked, scannable rendering; do NOT hand-patch it — regenerate from the scorecard.

**Counts: 52 done · 3 partial · 6 deferred · 16 decision-queue · 22 open = 99** (98 original + T4-99).

**10-second orientation**
1. **What am I building?** The face-on first-line detector (`docs/FACE_ON_FIRST_LINE_PLAN.md`) — this whole backlog is the maintenance program around it.
2. **What do I work on next?** Batch 6 (Supabase migrations — fresh session, opens with the anon-key rotation decision), then the T8-69 device+build session (3 HIGH items).
3. **What is intentionally parked?** The 16 decision-queue items below + club tracking (no chip footage exists).
4. **What can safely wait?** Deferred test debt, on-trigger refactors.

---

## The live program order

1. **Batch 6 — Supabase session** (prod DB, advisor-gated, confirm-first; handoff: `~/.claude/plans/honeyswing-batch6-handoff.md`): 🔑 anon-key rotation decision → T1-6 → T3-25 → T3-23 → T3-28 → T3-26 decision → T3-24.
2. **T8-69 — device + build session** (one device + one EAS build). **3 HIGH:** N1-native build proof [12eca28]; G5 watch handoff [fa39b14]; T2-20 Clerk auth smoke [ca6f028] (pod install; Podfile.lock grep `GoogleSignIn|AppAuth|GTM|Recaptcha` = EMPTY; sign-in/verify/sign-out). Plus the SimCC threshold review [b243a60], Batch 1/3 owed checks, and the 5b/5c riders.
3. Then: decision queue as decided; on-trigger refactors when their triggers fire.

---

## Decision queue (16) — no code until decided

- **T1-88** — outbox abandon on transient insert failure: retry policy, then a lib/infra commit.
- **T2-9 (remainder)** — swing-limit semantics: delete-recycles-quota / decrement-on-delete (counter itself is fixed [548bba2]).
- **T2-21** — iOS mic/photo purpose strings (may resolve by grep: `audio:` on startRecording, photo-library APIs).
- **T2-81** — degenerate-timestamp floor: overturn the C5-test-pinned intentional fallback?
- **T2-94 (remainder)** — session reset listener / session boundary semantics (fixes 1–3 shipped [655f075]).
- **T2-95** — OTA runtimeVersion policy (fingerprint vs appVersion) + defer-reload.
- **T3-26** — consolidate permissive policies + review anon UPDATE on profiles (sequenced BEFORE T3-24).
- **T3-27** — `get_coach_by_code` anon-callable: intentional / constrain / rate-limit.
- **T4-99** — sign-out session reset (same-launch account switch shares a sessionId).
- **T5-47** — hook-render test infra (unlocks the two big untestable hooks).
- **T7-57** — crash reporting: Sentry vs ErrorUtils.
- **T7-58** — gated logger yes/no (~592 console calls; no logger utility exists).
- **T7-59** — grip dev-tools hub in shipped builds (rider: `getGripHistory` is now zero-consumer — goes with grip surfaces if cut).
- **T7-60** — inert camera-guidance chain: kill or revive.
- **T7-61** — result.tsx vanished features: ship or delete (do NOT delete in refactors).
- **T7-62** — watch-IMU keep/delete (DELETE also moots G5 and clears the 3 remaining @bacons/xcode audit highs).
- **T7-82** — player_profiles server mirror: backfill vs accept local-first.
- **T7-93** — Android 100% broken: gate / port / drop.

*(T7-59/60/61/62/82/93 + T7-57/58 are the owner product calls; the 🔑 anon-key rotation rider on T7-65 opens Batch 6.)*

## Open (22)

**Tier 1/3 — Batch 6 migrations:** T1-6 (REVOKE `rls_auto_enable`) · T3-23 (swings.user_id index) · T3-24 (RLS initplan ×16, AFTER T3-26) · T3-25 (`merge_swing_debug` search_path) · T3-28 (verify-then-drop 3 indexes).
**Tier 7:** T7-83 (stash inspect ×2) · T7-84 (refactor-branch delete) · T7-85 (watchlist df3f4a76 — only if it repeats) · T7-86 (`reliability.impact` propagation — after xCross validates).
**Tier 8:** T8-66 (instrumented device swing) · T8-67 (extraction progress UI) · T8-68 (bbox-crop experiment) · T8-69 (the device+build session itself — see program order) · T8-78 (sync-JS profile, gated on T8-66) · T8-87 (outline-fraction tuning with the kids).
**Tier 9 (on-trigger):** T9-70 (retire/rebuild export-faceon script — gates workstream G) · T9-72 (PhaseRuleDebug literal) · T9-73 (buildSwingDebug extract) · T9-74+77 (detector dedup, one commit) · T9-75 (video-URI/frame-time math) · T9-76 (columns manifest).

## Partial (3)

- 🔶 **T2-9** — counter + increment-after-insert DONE [548bba2]; quota semantics = decision queue.
- 🔶 **T2-94** — insight fixes 1–3 DONE [655f075]; reset listener = decision queue.
- 🔶 **T9-71** — corpus-digest tool promoted under the canonical name [904b1f3]; the `scripts/lib` replay scaffold + `buildTrailPoints` export remain open.

## Deferred (6)

- ⏸️ **T4-41** (U13 grip overlay cover-crop — device tuning) · **T5-42…46** (test debt — program-dropped 2026-07-07; device testing is the verification strategy).

## Done (52)

**Tier 1 (6):** T1-1 [4012fa9] · T1-2 [4012fa9] · T1-3 [714ebae] · T1-4 [714ebae] · T1-5 [98dfa7d] · T1-7 [bdd7458]
**Tier 2 (17):** T2-8 [d60a789] · T2-10 [318e0d3] · T2-11 [974e90e] · T2-12 [4012fa9] · T2-13 [fa39b14]* · T2-14 [1c78a09] · T2-15 [214601d] · T2-16 [b4806f7] · T2-17 [b4806f7] · T2-18 [3bf0f14+12eca28]* · T2-19 [5d89769] · T2-20 [ca6f028]* · T2-22 [9fe37fc] · T2-80 [0534232] · T2-89 [b243a60]* · T2-90 [519d3f7] · T2-91 [519d3f7]
**Tier 4 (16):** T4-29 [542b9c7] · T4-30/31/32/34 [974e90e] · T4-33 [714ebae] · T4-35 [548bba2] · T4-36 [8f8e3b5] · T4-37 [9fe37fc] · T4-38 [4012fa9] · T4-39 [d60a789] · T4-40 [b4806f7] · T4-92 [1186ac1] · T4-96 [8f8e3b5+f35589d] · T4-97 [7144d5e] · T4-98 [37022ba]
**Tier 5 (1):** T5-48 [714ebae]
**Tier 6 (8):** T6-49/50/56 [b0e5c19] · T6-51 [95034b7] · T6-52 [3a628a6] · T6-53 [c0e2cee] · T6-54 [5b3413a] · T6-55 [fe7a543]
**Tier 7 (4):** T7-63/64 [01194c2] · T7-65 [5d89769] (🔑 rotation decision open) · T7-79 [0534232]

*\* = carries an owed device/build verification on the T8-69 ledger.*
