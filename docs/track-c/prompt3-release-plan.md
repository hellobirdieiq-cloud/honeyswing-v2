# Track C — Coach Link + Trust Slice: Release Plan

**Date:** 2026-03-28
**Branch:** v3-dev
**Inputs:** prompt1-audit.md, prompt2-architecture.md
**Status:** All Prompt 2 decisions LOCKED. This document validates and sequences only.

---

## SECTION 1 — Contradiction Pass

### Systematic Audit

| Check | Result |
|-------|--------|
| Does Prompt 2 assume any field exists that Prompt 1 said doesn't? | **No.** Prompt 2 correctly states `coach_name` and `swing_debug` do not exist on swings table (Prompt 1 §2, §6). Both are created via migration. |
| Does Prompt 2 reference any file path that Prompt 1 couldn't find? | **No.** All referenced files verified: `lib/persistSwing.ts`, `app/(tabs)/index.tsx`, `app/analysis/result.tsx`, `app/settings.tsx`, `lib/handedness.ts`, `lib/captureValidity.ts`. New files (`lib/coachCode.ts`, migration SQL) are to be created. |
| Do the protected surfaces lists match? | **Yes.** Prompt 2's "MUST NOT change" list includes all files Prompt 1 identified as unrelated: `lib/gripStore.ts`, `ios/*`, `supabase/functions/classify-grip/*`, `app/onboarding.tsx`, `lib/swingMotionStore.ts`, auth files, VisionCamera files, pose/domain packages. |
| Line numbers match source? | **Yes.** All line numbers re-verified against current source files (see verification above). |

### DEVIATION 1 — swing_debug payload (ACCEPTED)

**Spec says:** `swing_debug = {frame_count, pose_success_rate, phase_source, failure_reason}`
**Prompt 2 says:** `swing_debug = {app_version, capture_validity, classification_reason}`

**Ruling:** Accepted. Prompt 1 §6 confirmed all four spec fields already exist as individual top-level columns on the swings table (`lib/persistSwing.ts:62-75`). Duplicating them in JSONB creates divergence risk. The accepted `swing_debug` carries only additive debug fields not stored elsewhere. The four spec fields remain queryable via their existing top-level columns.

### DEVIATION 2 — Coach code format (CORRECTED)

**Prompt 2 example:** `'DAVE2026'` with `.toUpperCase()` normalization
**Spec says:** Lowercase codes — `"dave"` maps to `"Dave Donnellan"`

**Ruling:** Corrected. The `CODE_TO_NAME` mapping keys must be lowercase (e.g., `'dave': 'Dave Donnellan'`). The `resolveCoachName` function normalizes input via `.toLowerCase().trim()`, not `.toUpperCase()`. This is a cosmetic fix to Prompt 2's example code, not an architecture change. The Prompt 2 verification plan example (`resolveCoachName('DAVE2026')`) is also corrected to `resolveCoachName('dave')`.

### Other Contradictions

**None found.** All other Prompt 2 decisions align with Prompt 1 evidence.

---

## SECTION 2 — Blocking Risk

### Risk: Migration not applied before code deploys

**Layer:** CONFIG

**What happens:** If `coach_name` or `swing_debug` is added to the `row` object in `persistSwing.ts` before the ALTER TABLE migration runs on the Supabase database, every call to `persistSwing` will fail with a Postgres "column does not exist" error. The error is caught and logged (`lib/persistSwing.ts:82`) but not thrown — so the app does not crash. Instead, **swings silently stop being persisted**. The user sees normal UI but their swing data is lost.

**Why this fires first:** This is a CONFIG failure that triggers on the very first swing capture attempt after code changes are deployed. It fires before any JS compile error (TypeScript will compile fine — the column name is just a string key in a record literal). It fires before any UI rendering issue. There is no compile-time or link-time guard against a missing database column.

**Why other risks rank lower:**
- TypeScript compile errors: mitigated by `npx tsc --noEmit` gate before build.
- Home screen overflow: mitigated by Prompt 2's layout math (352px vs 520px available).
- AsyncStorage key collision: mitigated by `honeyswing:` prefix convention (Prompt 1 §3).

**First test:**
1. Open Supabase dashboard → SQL Editor
2. Run: `ALTER TABLE swings ADD COLUMN IF NOT EXISTS coach_name TEXT; ALTER TABLE swings ADD COLUMN IF NOT EXISTS swing_debug JSONB;`
3. Verify success: `SELECT column_name FROM information_schema.columns WHERE table_name = 'swings' AND column_name IN ('coach_name', 'swing_debug');` — must return 2 rows.
4. Record a test swing in the current (unmodified) app. Verify the existing insert still succeeds — new columns default to null without breaking anything.

**Fallback trigger:** If the migration cannot be applied within 1 hour (e.g., Supabase dashboard access issues, permissions error, table lock), do NOT proceed with any code changes. The entire build is blocked. Investigate the database access issue before writing any code.

---

## SECTION 3 — Numbered Build Order

### Step 1: Apply database migration [SUPABASE]

**What:** Add `coach_name TEXT` and `swing_debug JSONB` columns to the `swings` table.
**Files:** Create `supabase/migrations/20260328000000_add_coach_and_debug_to_swings.sql`. Apply via Supabase dashboard SQL Editor.
**Pass gate:** Query `information_schema.columns` confirms both columns exist. Record a swing in the current unmodified app — insert succeeds, new columns are null.
**If it fails:** Full stop. No code changes until the database accepts the new columns. Check Supabase permissions, table name, RLS policies.

### Step 2: Create coach code storage helper [JS-ONLY]

**What:** New `lib/coachCode.ts` with: `KEY` constant, `CODE_TO_NAME` mapping (lowercase keys), `getCoachCode()`, `setCoachCode()`, `clearCoachCode()`, `resolveCoachName()` (normalizes via `.toLowerCase().trim()`).
**Files:** Create `lib/coachCode.ts`
**Pass gate:** `npx tsc --noEmit` passes. Module exports match the Prompt 2 Decision 2 signature.
**If it fails:** TypeScript errors in the new file. Fix type issues before proceeding — all downstream steps import from this module.

### Step 3: Wire persistSwing [JS-ONLY]

**What:** Three changes to `lib/persistSwing.ts`:
1. Import `getCoachCode`, `resolveCoachName` from `./coachCode`
2. Add async coach name resolution before the row object (read coach code, resolve to name)
3. Add `coach_name` and `swing_debug` fields to the `row` object (lines 59-77)
4. Change line 74 from `failure_reason: null` to `failure_reason: classification?.reason ?? null`

`swing_debug` payload:
```typescript
swing_debug: {
  app_version: APP_VERSION,
  capture_validity: classification?.validity ?? 'unknown',
  classification_reason: classification?.reason ?? null,
}
```

**Files:** `lib/persistSwing.ts`
**Pass gate:** `npx tsc --noEmit` passes. Record a swing with no coach code set → `coach_name` is null, `swing_debug` is populated, `failure_reason` reflects classification reason. Verify in Supabase table viewer.
**If it fails:** Check column names match migration exactly. Check that `getCoachCode()` is awaited (async). Check `swing_debug` is a plain object (JSONB-compatible).

**Regression check:** Record a swing WITHOUT any coach code set. Verify: `coach_name` is null, all 17 original fields persist correctly, `swing_debug` has `app_version` + `capture_validity` + `classification_reason`, `failure_reason` has classification reason (or null for valid captures).

### Step 4: Home screen coach code UI [JS-ONLY]

**What:** Add tappable coach row (following grip button pattern at `app/(tabs)/index.tsx:63-74`) and modal with TextInput for code entry.
- New state: `coachName: string | null` loaded in `useFocusEffect` (lines 19-25)
- Tappable row between grip button (after line 74) and hint text (line 76)
- Shows coach display name when set, "Link a Coach" when unset
- Modal: TextInput + confirm button + cancel. On confirm: `setCoachCode(input)`, resolve name, update state
- Import `Modal`, `TextInput` from `react-native`

**Files:** `app/(tabs)/index.tsx`
**Pass gate:** `npx tsc --noEmit` passes. Hot reload. Tap row → modal opens → enter "dave" → confirm → row shows "Dave Donnellan". Kill app → reopen → name persists. Enter invalid code → no name resolves (row shows code or appropriate feedback). Tap when coach is already set → modal opens with option to clear/change.
**If it fails:** Modal not rendering: check `visible` state. TextInput not capturing: check keyboard type. Name not persisting: check `setCoachCode` is awaited.

### Step 5: Result screen attribution [JS-ONLY]

**What:** Add conditional coach attribution line between tempo chip (lines 232-240) and Record Again CTA (lines 242-249).
- New state: `coachName: string | null`, loaded in existing `useEffect` at line 85 alongside `getIsLeftHanded()`
- Render: conditional `<View>` following `styles.tempoChip` pattern (horizontal row, `#1A1A1C` bg, 12px border-radius, label + value)
- Only renders when coach name resolves to non-null

**Files:** `app/analysis/result.tsx`
**Pass gate:** `npx tsc --noEmit` passes. Record swing with coach "dave" linked → "Coach" label + "Dave Donnellan" value renders between tempo and CTA. Clear coach code → record swing → no attribution line renders.
**If it fails:** Attribution showing for null coach: check conditional guard. Style mismatch: verify using `styles.tempoChip` pattern.

**Regression check:** Record swing with NO coach linked. Verify: result screen renders identically to current behavior — no empty row, no crash, no layout shift. Tempo chip and Record Again CTA are adjacent with no gap.

### Step 6: Account deletion cleanup [JS-ONLY]

**What:** Add `'honeyswing:coachCode'` to the `AsyncStorage.multiRemove` array at `app/settings.tsx:31-35`.

**Files:** `app/settings.tsx`
**Pass gate:** `npx tsc --noEmit` passes. Set a coach code → delete account → verify `AsyncStorage.getItem('honeyswing:coachCode')` returns null.
**If it fails:** Key typo: verify string matches `KEY` constant in `lib/coachCode.ts`.

**Regression check:** Delete account → verify all 4 keys are cleared (3 existing + coach code). Verify the delete flow still navigates to `/(tabs)` after completion.

### Step 7: TypeScript full check [JS-ONLY]

**What:** Final full type check of entire project.
**Files:** None (read-only check)
**Pass gate:** `npx tsc --noEmit` exits with code 0. `npx expo lint` passes with no new errors.
**If it fails:** Fix all type errors before proceeding to build step. Do NOT skip this gate.

### Step 8: App Privacy update [APP-STORE-CONNECT]

**What:** Review and update App Store privacy declarations. See Section 4 for details.
**Files:** None (App Store Connect configuration)
**Pass gate:** Privacy declarations accurately reflect the shipped data collection. No compliance warnings in App Store Connect.
**If it fails:** Do not submit the build until privacy declarations are correct. This is a release blocker.

### Step 9: EAS build + submit [NATIVE-BUILD-REQUIRED]

**What:** `eas build --platform ios --profile production` → `eas submit --platform ios`
**Files:** None (build system)
**Pass gate:** Build succeeds. Binary uploaded to App Store Connect. TestFlight build appears for review.
**If it fails:** Check build logs. This feature is JS-only — no native module changes. If EAS fails, it's an environment issue, not a Track C issue.

---

## SECTION 4 — Release Compliance Gates

### App Privacy Checklist

| Question | Answer |
|----------|--------|
| What data categories change? | `coach_name` (user-entered code mapping to a name) is stored on the `swings` table linked to `user_id`. `swing_debug` contains app version, capture validity, and classification reason — all technical diagnostics. `failure_reason` is a user-facing diagnostic string. |
| Does "Data Not Collected" still apply? | **Working expectation: No.** `coach_name` is user-provided input stored remotely with a user identifier. This likely falls under "Data Linked to You" or "Data Used to Track You" depending on usage. **Final determination must be verified during release prep (Step 8) against the actual shipped implementation.** |
| Privacy update timing? | Privacy declarations must be updated BEFORE the build is submitted to App Store review. App Store Connect requires privacy info to be current at submission time. Update in Step 8, submit in Step 9. |
| Export compliance? | No encryption changes. No new third-party SDKs. Standard HTTPS for Supabase communication (unchanged). Export compliance status: unchanged from prior version. |

**App Privacy update is a MUST SHIP release blocker.**

---

## SECTION 5 — MUST SHIP vs BONUS vs FUTURE ONLY

| Item | Classification | Reason |
|------|---------------|--------|
| Step 1: Database migration | **MUST SHIP** | All code changes depend on these columns existing |
| Step 2: `lib/coachCode.ts` | **MUST SHIP** | Core storage module consumed by steps 3-6 |
| Step 3: persistSwing wiring | **MUST SHIP** | Per-swing coach attribution + debug payload |
| Step 4: Home screen coach UI | **MUST SHIP** | User entry point for coach code |
| Step 5: Result screen attribution | **MUST SHIP** | User-visible coach attribution display |
| Step 6: Account deletion cleanup | **MUST SHIP** | Data hygiene requirement |
| Step 7: TypeScript check | **MUST SHIP** | Build gate |
| Step 8: App Privacy update | **MUST SHIP** | Release blocker — compliance requirement |
| Step 9: EAS build + submit | **MUST SHIP** | Delivery mechanism |
| `failure_reason` wiring (within Step 3) | **MUST SHIP** | One-line change, wires available data into an existing null column |
| Invalid code feedback UX (toast/alert) | **BONUS** | Nice polish but app functions without it — unrecognized code just means no coach name resolves |
| Coach code edit/clear from Home modal | **BONUS** | Can be handled by re-entering a new code or leaving blank |

**FUTURE ONLY (stated once):** All spec-listed non-goals — `coach_codes` database table, retroactive attribution, payout system, referral dashboard, admin panel, Stripe Connect, analytics dashboard, coach notification system, code generation/rotation — are out of scope for this version. Do not plan, design, or stub any of these.

---

## SECTION 6 — Time Estimates

**Assumptions:** Developer works in Claude Code. JS changes hot-reload via Metro. EAS build takes ~15-20 min. Migration applied manually via Supabase dashboard SQL Editor. Developer has Supabase dashboard access.

| Step | Estimated Time | Notes |
|------|---------------|-------|
| 1. Database migration | 10 min | Write SQL file + apply via dashboard + verify |
| 2. `lib/coachCode.ts` | 15 min | Small module, follows existing pattern |
| 3. persistSwing wiring | 15 min | 3 changes to existing file + regression verify |
| 4. Home screen coach UI | 40 min | New modal + state + styling, most complex UI step |
| 5. Result screen attribution | 20 min | Follows existing tempo chip pattern closely |
| 6. Account deletion cleanup | 5 min | One string added to an array |
| 7. TypeScript check | 5 min | Run command, fix if needed |
| 8. App Privacy update | 15 min | Review declarations in App Store Connect |
| 9. EAS build + submit | 20 min | Mostly waiting |

**Total estimated active work time: ~2.5 hours**

---

## SECTION 7 — What NOT to Waste Time On

1. **Do not build a coach codes database table or API.** The spec explicitly lists this as a non-goal. The hardcoded `CODE_TO_NAME` mapping in `lib/coachCode.ts` is the correct scope for this version. Do not create a Supabase table, edge function, or admin interface for managing codes.

2. **Do not refactor the Home screen into a ScrollView.** Prompt 2 confirmed the coach row fits within existing layout bounds. If it looks tight on a specific device, adjust margins — do not restructure the layout component.

3. **Do not modify `app/onboarding.tsx` or the profiles table.** The onboarding coach picker is architecturally separate (locked from Prompt 1). It writes `coach_name` to `profiles`, not `swings`. They coexist. Do not attempt to merge, replace, or synchronize them.

4. **Do not add swing_debug fields that duplicate existing top-level columns.** `frame_count`, `pose_success_rate`, `phase_source`, and `failure_reason` are already individual columns. The accepted deviation (Section 1) is final.

5. **Do not add comprehensive error handling for invalid coach codes.** If a code doesn't resolve, `resolveCoachName` returns null and no coach name is persisted or displayed. That's sufficient. Do not build validation UI, error toasts, or "code not found" modals unless time permits (BONUS).

---

## SECTION 8 — Go/No-Go Rule

**Do NOT submit this version if swings recorded without a coach code fail to persist (null coach_name must be accepted by the database without error).**

---

## SECTION 9 — Action Gate (First Validation Step)

**Immediately after reading this plan:**

1. Open the Supabase dashboard SQL Editor
2. Run:
```sql
ALTER TABLE swings ADD COLUMN IF NOT EXISTS coach_name TEXT;
ALTER TABLE swings ADD COLUMN IF NOT EXISTS swing_debug JSONB;
```
3. Verify:
```sql
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'swings'
  AND column_name IN ('coach_name', 'swing_debug');
```
Must return exactly 2 rows: `coach_name | text` and `swing_debug | jsonb`.
4. Open the app (current unmodified code), record a swing, verify it persists successfully in the Supabase table viewer with `coach_name = null` and `swing_debug = null`.

This confirms the database accepts the schema change and existing code is unbroken. If this fails, the entire build is blocked — diagnose before writing any code.

---

## SECTION 10 — Consistency Self-Check

- [x] Plan targets existing compiled code, not dead code — all attachment points verified against running source
- [x] No section assumes something Prompt 1 disproved — all references cross-checked
- [x] Every build step has a pass/fail gate — Steps 1-9 each have explicit gates
- [x] Protected surfaces from Prompt 2 are respected in every build step — no step touches `lib/gripStore.ts`, `ios/*`, `supabase/functions/classify-grip/*`, `app/onboarding.tsx`, `lib/swingMotionStore.ts`, or any other protected file
- [x] App Privacy is tagged MUST SHIP — Section 5, Step 8
- [x] swing_debug payload matches accepted deviation — `{app_version, capture_validity, classification_reason}`, NOT spec's original four fields
- [x] Coach code format is lowercase ("dave"), not uppercase ("DAVE2026") — Deviation 2 corrected in Section 1
- [x] failure_reason wired from `classification?.reason ?? null`, not hardcoded null — Step 3
- [x] No scope creep beyond the spec's explicit scope — FUTURE ONLY items listed in Section 5
- [x] Onboarding coach picker is untouched — `app/onboarding.tsx` is on protected surfaces list
- [x] Migration is Step 1 in build order — confirmed

---

## SECTION 11 — Open Questions Registry

See `docs/track-c/open-questions.md` for tracked items.
