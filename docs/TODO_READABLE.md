# HoneySwing — Readable TODO

**Regenerated 2026-07-16 from the status scorecard** (`~/.claude/plans/honeyswing-99-item-scorecard.md` — statuses reconciled against `git log` + live DB, not memory) **+ the canonical plan for item specs** (`~/.claude/plans/implementation-plan-jolly-moonbeam.md` — wins on any conflict). This file is a tracked, scannable rendering; do NOT hand-patch it — regenerate from the scorecard. Detailed action cards for every non-done item: `docs/BACKLOG_BRIEF.md`.

**Counts: 56 done · 3 partial · 6 deferred · 17 decision-queue · 18 open = 100** (98 original + T4-99 + T7-100).

**10-second orientation**
1. **What am I building?** The face-on first-line detector (`docs/FACE_ON_FIRST_LINE_PLAN.md`) — this whole backlog is the maintenance program around it.
2. **What do I work on next?** T2-95 (OTA runtime pin — urgent now that TestFlight 1.10.2–1.10.4 shipped under runtime "1.0.0"), the T8-69 device+build session (3 HIGH), then the decision-gated Batch 6 remainder (T3-26 → T3-24).
3. **What is intentionally parked?** The 17 decision-queue items + club tracking (no chip footage exists).
4. **What can safely wait?** Deferred test debt, on-trigger refactors.

---

## The live program order

1. **T2-95 decision + fix** — OTA runtimeVersion policy; risk went live with the 1.10.x TestFlight builds.
2. **T8-69 — device + build session** (one device + one EAS build). **3 HIGH:** N1-native build proof [12eca28]; G5 watch handoff [fa39b14]; T2-20 Clerk auth smoke [ca6f028] (pod install; Podfile.lock grep `GoogleSignIn|AppAuth|GTM|Recaptcha` = EMPTY; sign-in/verify/sign-out). Plus SimCC threshold review [b243a60], Batch 1/3 owed checks, 5b/5c riders. Check first whether the 1.10.x builds already implicitly proved parts of HIGH-1/3.
3. **Batch 6 remainder** — T3-26 decision (policy consolidation + anon-UPDATE review, `pg_policies` snapshot first) → T3-24 initplan rewrite; T3-27; T7-100 key rotation (after T2-95).
4. Then: decision queue as decided; on-trigger refactors when their triggers fire.

## Decision queue (17) — no code until decided

- **T1-88** — outbox abandon on transient insert failure: retry policy (queue-until-login `held` machinery may be reusable).
- **T2-9 (remainder)** — swing-limit semantics: delete-recycles-quota / decrement-on-delete (counter fixed [548bba2]).
- **T2-21** — iOS mic/photo purpose strings (may resolve by grep).
- **T2-81** — degenerate-timestamp floor: overturn the C5-test-pinned intentional fallback?
- **T2-94 (remainder)** — session reset listener / session boundary semantics (fixes 1–3 shipped [655f075]).
- **T2-95** — OTA runtimeVersion policy (fingerprint vs appVersion) + defer-reload. **URGENT — see program order #1.**
- **T3-26** — consolidate permissive policies + review anon UPDATE on profiles (sequenced BEFORE T3-24).
- **T3-27** — `get_coach_by_code` anon-callable: intentional / constrain / rate-limit (the ONLY security advisor warn left, verified 2026-07-16).
- **T4-99** — sign-out session reset (same-launch account switch shares a sessionId).
- **T5-47** — hook-render test infra (contradicts the standing no-new-tests directive — decide the directive first).
- **T7-57** — crash reporting: Sentry vs ErrorUtils (TestFlight users now exist).
- **T7-58** — gated logger yes/no (~592 console calls; babel transform-remove-console is the cheap route).
- **T7-59** — grip dev-tools hub in shipped builds (rider: `getGripHistory` is zero-consumer).
- **T7-60** — inert camera-guidance chain: kill or revive.
- **T7-61** — result.tsx vanished features: ship or delete (do NOT delete in refactors).
- **T7-62** — watch-IMU keep/delete (DELETE moots G5 + clears the 3 remaining @bacons/xcode audit highs).
- **T7-82** — player_profiles mirror: ⚠️ premise changed — live DB has 5 rows now (was "0"); re-scope, then decide.
- **T7-93** — Android 100% broken: gate / port / drop.
- **T7-100** — `sb_publishable` key-system migration (coexistence rotation; owner accepted the anon-key leak 2026-07-08). Sequence after T2-95.

*(19 lines above because T2-9/T2-94 partial-remainders are listed here for visibility; the 17 counted decision items exclude those two.)*

## Open (18)

**Tier 3 — Batch 6 remainder:** T3-24 (RLS initplan rewrite, AFTER T3-26; `pg_policies` snapshot as rollback).
**Tier 7:** T7-83 (2 stashes on clean-release, verified 2026-07-16) · T7-84 (branch delete — ⚠️ no branch named "refactor" exists; identify target first) · T7-85 (watchlist df3f4a76 — only if it repeats) · T7-86 (`reliability.impact` propagation — after T8-69 validates impact on fresh captures).
**Tier 8:** T8-66 (instrumented device swing) · T8-67 (extraction progress UI) · T8-68 (bbox-crop experiment, gated on T8-66) · T8-69 (THE device+build session — see program order) · T8-78 (sync-JS profile, gated on T8-66; outbox.ts reworked 2026-07-15, re-locate lines) · T8-87 (outline-fraction tuning with the kids).
**Tier 9 (on-trigger):** T9-70 (retire/rebuild export-faceon script — gates workstream G) · T9-72 (PhaseRuleDebug literal) · T9-73 (buildSwingDebug extract — trigger may have FIRED via 5003f7c, check) · T9-74+77 (detector dedup, one commit) · T9-75 (video-URI/frame-time math) · T9-76 (columns manifest — trigger may have FIRED via captured_at_iso, check).

## Partial (3)

- 🔶 **T2-9** — counter + increment-after-insert DONE [548bba2]; quota semantics = decision queue.
- 🔶 **T2-94** — insight fixes 1–3 DONE [655f075]; reset listener = decision queue.
- 🔶 **T9-71** — corpus-digest tool promoted under the canonical name [904b1f3]; `scripts/lib` scaffold + `buildTrailPoints` export remain (workstream G).

## Deferred (6)

- ⏸️ **T4-41** (U13 grip overlay cover-crop — device tuning) · **T5-42…46** (test debt — program-dropped 2026-07-07; device testing is the verification strategy).

## Done (56)

**Tier 1 (7):** T1-1 [4012fa9] · T1-2 [4012fa9] · T1-3 [714ebae] · T1-4 [714ebae] · T1-5 [98dfa7d] · T1-6 [remote 20260708155325, mirror 1de3912] · T1-7 [bdd7458]
**Tier 2 (17):** T2-8 [d60a789] · T2-10 [318e0d3] · T2-11 [974e90e] · T2-12 [4012fa9] · T2-13 [fa39b14]* · T2-14 [1c78a09] · T2-15 [214601d] · T2-16 [b4806f7] · T2-17 [b4806f7] · T2-18 [3bf0f14+12eca28]* · T2-19 [5d89769] · T2-20 [ca6f028]* · T2-22 [9fe37fc] · T2-80 [0534232] · T2-89 [b243a60]* · T2-90 [519d3f7] · T2-91 [519d3f7]
**Tier 3 (3):** T3-23 [1de3912] · T3-25 [remote 20260708160117, mirror 1de3912] · T3-28 [1de3912]
**Tier 4 (16):** T4-29 [542b9c7] · T4-30/31/32/34 [974e90e] · T4-33 [714ebae] · T4-35 [548bba2] · T4-36 [8f8e3b5] · T4-37 [9fe37fc] · T4-38 [4012fa9] · T4-39 [d60a789] · T4-40 [b4806f7] · T4-92 [1186ac1] · T4-96 [8f8e3b5+f35589d] · T4-97 [7144d5e] · T4-98 [37022ba]
**Tier 5 (1):** T5-48 [714ebae]
**Tier 6 (8):** T6-49/50/56 [b0e5c19] · T6-51 [95034b7] · T6-52 [3a628a6] · T6-53 [c0e2cee] · T6-54 [5b3413a] · T6-55 [fe7a543]
**Tier 7 (4):** T7-63/64 [01194c2] · T7-65 [5d89769] (leak ACCEPTED → T7-100) · T7-79 [0534232]

*\* = carries an owed device/build verification on the T8-69 ledger.*
