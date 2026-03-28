# Track C — Prompt 1: Repo Audit

**Date:** 2026-03-28
**Branch:** v3-dev
**Scope:** Coach Link + Trust Slice — coach code entry, coach attribution on swings, swing_debug JSONB column

---

## SECTION 1 — persistSwing Pipeline

**File:** `lib/persistSwing.ts`

### Function signature (line 41-45)

```ts
export async function persistSwing(
  frames: PoseFrame[],
  analysis: AnalysisResult,
  classification: CaptureClassification | null,
): Promise<string | null>
```

REPO-VERIFIED: `lib/persistSwing.ts:41-45`

### Fields currently inserted into swings table (lines 59-77)

| Field | Source | Line |
|---|---|---|
| `user_id` | `profileId` (auth uid or AsyncStorage fallback) | 60 |
| `motion_frames` | Raw `frames` array | 61 |
| `frame_count` | `frames.length` | 62 |
| `duration_ms` | Computed from first/last frame timestamps | 63 |
| `score` | `analysis.score` | 64 |
| `honey_boom` | `analysis.honeyBoom` | 65 |
| `angles` | `analysis.angles` | 66 |
| `tempo` | `analysis.tempo` | 67 |
| `phases` | `analysis.phases` | 68 |
| `backswing_ms` | `analysis.tempo?.backswingMs` | 69 |
| `downswing_ms` | `analysis.tempo?.downswingMs` | 70 |
| `tempo_ratio` | `analysis.tempo?.ratio` | 71 |
| `pose_success_rate` | `calcPoseSuccessRate(frames)` (local helper, line 17) | 72 |
| `phase_source` | `extractPhaseSource(analysis.phases)` (local helper, line 33) | 73 |
| `failure_reason` | Hardcoded `null` | 74 |
| `capture_validity` | `classification?.validity ?? 'unknown'` | 75 |
| `app_version` | Hardcoded `'1.3.0'` | 76 |

REPO-VERIFIED: `lib/persistSwing.ts:59-77`

### user_id resolution (lines 52-57)

1. `getUserId()` calls `supabase.auth.getUser()` — returns auth uid or null. REPO-VERIFIED: `lib/supabase.ts:27-30`
2. If `authUserId` is null → early return at line 54, skipping DB write entirely. REPO-VERIFIED: `lib/persistSwing.ts:53-55`
3. Line 57 has a dead fallback: `authUserId ?? AsyncStorage.getItem(...)` — unreachable because of the early return above. The `profileId` variable always equals `authUserId` when execution reaches line 59. REPO-VERIFIED: `lib/persistSwing.ts:53-57`

### Supabase insert call (line 79)

```ts
const { data, error } = await supabase.from('swings').insert(row).select('id').single();
```

Single insert, returns the new row's `id`. REPO-VERIFIED: `lib/persistSwing.ts:79`

### Call site (record.tsx line 246)

```ts
swingIdPromiseRef.current = persistSwing(frames, analysis, classification).catch(() => null);
```

Called in `finalizeCapture()` after analysis completes, fire-and-forget with `.catch(() => null)`. REPO-VERIFIED: `app/(tabs)/record.tsx:246`

### Insertion point for coach_name and swing_debug

The `row` object literal at lines 59-77 is the single place where all insert fields are assembled. New fields (`coach_name`, `swing_debug`) attach here — added to this same object before the `.insert(row)` call at line 79.

- **coach_name**: Must be read from the persist layer at call time. Not currently available in any of the three parameters (`frames`, `analysis`, `classification`). Value must be sourced from a storage layer (AsyncStorage) before insertion.
- **swing_debug**: All four sub-fields are already computed in this file:
  - `frame_count` — `frames.length` (line 62)
  - `pose_success_rate` — `calcPoseSuccessRate(frames)` (line 72)
  - `phase_source` — `extractPhaseSource(analysis.phases)` (line 73)
  - `failure_reason` — hardcoded `null` (line 74)

  These can be bundled into a JSONB object at the same insertion point without any new data sources.

---

## SECTION 2 — swings Table Schema

### Migration files

No migration files found. `supabase/migrations/` directory is empty (confirmed by `find` command returning no results). REPO-VERIFIED: Bash output empty.

The swings table schema is not version-controlled via migration files in this repo. The table was likely created directly in the Supabase dashboard or via a migration that predates this repo's history.

### Current columns (inferred from persistSwing insert)

Based on the insert object in Section 1, the swings table has at minimum these columns:

`id`, `user_id`, `motion_frames`, `frame_count`, `duration_ms`, `score`, `honey_boom`, `angles`, `tempo`, `phases`, `backswing_ms`, `downswing_ms`, `tempo_ratio`, `pose_success_rate`, `phase_source`, `failure_reason`, `capture_validity`, `app_version`

Plus standard Supabase columns (`created_at`, etc.).

### Do coach_name or swing_debug already exist?

- `grep "swing_debug"` — **zero results**. REPO-VERIFIED.
- `grep "coach"` — hits in `onboarding.tsx` (profile coach picker), `VisualCoachCard.tsx` (unrelated UI component), `classify-grip/index.ts` (prompt text). **No references to a `coach_name` column on the swings table.** REPO-VERIFIED.

**Verdict:** Neither `coach_name` nor `swing_debug` exist on the swings table. Both require a new migration.

### Migration naming convention

No existing migrations to establish a convention. The first migration file will set the convention.

---

## SECTION 3 — AsyncStorage Usage Pattern

### Keys currently in use

| Key | File | Purpose |
|---|---|---|
| `honeyswing:onboardingComplete` | `app/_layout.tsx`, `app/onboarding.tsx`, `app/settings.tsx` | Gate onboarding screen |
| `honeyswing:profileId` | `app/onboarding.tsx`, `lib/persistSwing.ts`, `app/settings.tsx` | Anonymous profile ID fallback |
| `honeyswing:isLeftHanded` | `app/onboarding.tsx`, `lib/handedness.ts`, `app/settings.tsx` | Handedness preference |
| `honeyswing:localSwingCount` | `lib/swingLimit.ts` | Anonymous swing limit tracking |
| `honeyswing:todaysFocus` | `lib/swingMotionStore.ts` | Today's Focus persistence |
| (Supabase auth session) | `lib/supabase.ts` | Supabase auth uses AsyncStorage as its storage adapter |

REPO-VERIFIED: All files listed above.

### Import pattern

```ts
import AsyncStorage from '@react-native-async-storage/async-storage';
```

Consistent across all files. REPO-VERIFIED.

### Read/write pattern

- **Read:** `await AsyncStorage.getItem(KEY)` — returns `string | null`
- **Write:** `await AsyncStorage.setItem(KEY, stringValue)`
- **Delete:** `await AsyncStorage.multiRemove([...keys])` (used in `app/settings.tsx:31`)

All usage is **inline** — direct `AsyncStorage.getItem` / `setItem` calls. No wrapper module or storage helper exists. Each module defines its own key constant (e.g., `const KEY = 'honeyswing:isLeftHanded'`). REPO-VERIFIED.

### Key naming convention

All keys use the prefix `honeyswing:` followed by a camelCase identifier. A new coach code key would follow this pattern (e.g., `honeyswing:coachCode`).

---

## SECTION 4 — Home Screen Structure

**File:** `app/(tabs)/index.tsx`

### Current component tree (lines 27-81)

```
<View container>
  <TouchableOpacity settingsButton> → router.push('/settings')
  <View hero>
    <Text title> "HoneySwing"
    <Text subtitle> "Your pocket swing coach"
  </View>
  {focus && <View focusCard>  ← Today's Focus row
    <Text focusTitle> "Today's Focus"
    <View focusRow> dot + label
    <Text focusCue> coaching cue text
  </View>}
  <TouchableOpacity cta> "Start Swinging" → router.push('/(tabs)/record')
  <TouchableOpacity gripBtn> "Capture Grip" / "Update Grip Photo" → router.push('/grip/capture')
  <Text hint>
</View>
```

REPO-VERIFIED: `app/(tabs)/index.tsx:27-81`

### Today's Focus row

Renders conditionally when `focus` state is non-null (line 42). Data comes from `loadFocus()` which reads `honeyswing:todaysFocus` from AsyncStorage. It's a `<View focusCard>` — a card-style container, not tappable. REPO-VERIFIED: `app/(tabs)/index.tsx:42-53`

### Existing tappable row/card patterns

- Settings button: `<TouchableOpacity>` with icon → `router.push('/settings')` (line 29-35)
- Start Swinging CTA: `<TouchableOpacity>` → `router.push('/(tabs)/record')` (line 55-61)
- Grip button: `<TouchableOpacity>` with optional image + text → `router.push('/grip/capture')` (line 63-74)

The grip button pattern (line 63-74) is the closest analog to a "coach link" row: it conditionally shows content based on stored state, uses a bordered outline style, and navigates on press. REPO-VERIFIED: `app/(tabs)/index.tsx:63-74`

### Navigation/modal patterns

All navigation on this screen uses `router.push()`. No modals are used. The screen is a flat layout — no ScrollView, no FlatList. REPO-VERIFIED.

---

## SECTION 5 — Result Screen Structure

**File:** `app/analysis/result.tsx`

### Data sources

- `getCurrentSwingMotion()` — in-memory store, provides `frames` for skeleton rendering. REPO-VERIFIED: `app/analysis/result.tsx:68`
- `getCurrentSwingAnalysis()` — in-memory store, provides `AnalysisResult` (score, angles, tempo, phases). REPO-VERIFIED: `app/analysis/result.tsx:69`
- `getCurrentSwingVideoUri()` — in-memory store, provides video path. REPO-VERIFIED: `app/analysis/result.tsx:70`
- `getIsLeftHanded()` — AsyncStorage read. REPO-VERIFIED: `app/analysis/result.tsx:86`
- `checkSwingLimit()` — Supabase + AsyncStorage. REPO-VERIFIED: `app/analysis/result.tsx:88`

No route params are used. All swing data comes from the in-memory `swingMotionStore`. REPO-VERIFIED.

### Current display sections (lines 183-275)

1. **Score card** (line 185-193) — big score number + optional "Honey Boom!" text + low-confidence badge
2. **Video replay** (line 196-218) — VideoView + speed controls (0.25x, 0.5x, 1x)
3. **Visual Coach** (line 221-230) — VisualCoachCard component (skeleton + coaching cue)
4. **Tempo chip** (line 233-239) — label + rating text
5. **Record Again CTA** (line 243-249) — `router.back()`
6. **Sign-in prompt** (line 252-264) — conditional, shown when swing limit hit
7. **Swing Art** (line 267-273) — trail visualization, valid captures only

### Existing metadata line patterns

The **tempo chip** (lines 233-239) is the closest pattern to a coach attribution line: a horizontal row with label on the left and value on the right, inside a `#1A1A1C` card with rounded corners. Style: `styles.tempoChip` (line 379-388). REPO-VERIFIED.

### Logical attachment point for coach attribution

Between the score card (section 1) and the video replay (section 2) would be the most visible position. Alternatively, between the tempo chip (section 4) and the Record Again CTA (section 5), which groups metadata together. The tempo chip pattern provides the exact visual template.

---

## SECTION 6 — swingMotionStore Shape

**File:** `lib/swingMotionStore.ts`

### Store shape

The store is an in-memory module with three module-level variables:

- `currentMotion: LiveSwingMotionData | null` — holds `{ frames: PoseFrame[], recordedAt: number, source: 'live-camera' }`. REPO-VERIFIED: `lib/swingMotionStore.ts:6-10, 12`
- `currentAnalysis: AnalysisResult | null` — holds `{ score, honeyBoom, angles?, tempo?, phases? }`. REPO-VERIFIED: `lib/swingMotionStore.ts:13`, `packages/domain/swing/analysisPipeline.ts:7-13`
- `currentVideoUri: string | null`. REPO-VERIFIED: `lib/swingMotionStore.ts:14`

### swing_debug field availability at persist-time

The `persistSwing` function is called in `record.tsx:246` with `(frames, analysis, classification)`. All four swing_debug sub-fields are evaluated at persist-time:

| Field | Available? | Value at persist-time | Source |
|---|---|---|---|
| `frame_count` | Yes | `frames.length` | `lib/persistSwing.ts:62` — already computed as a top-level column |
| `pose_success_rate` | Yes | `calcPoseSuccessRate(frames)` output (0-1 float) | `lib/persistSwing.ts:72` — already computed as a top-level column |
| `phase_source` | Yes | `extractPhaseSource(analysis.phases)` output (`'heuristic'` / `'fallback'` / `'mixed'` / `'none'`) | `lib/persistSwing.ts:73` — already computed as a top-level column |
| `failure_reason` | Yes, but always `null` | Hardcoded `null` | `lib/persistSwing.ts:74` — no logic currently populates this |

REPO-VERIFIED: All four fields exist at lines 62-74 of `lib/persistSwing.ts`.

**Key observation:** All four swing_debug sub-fields are already computed as **individual top-level columns** in the insert row. The `swing_debug` JSONB column would bundle these same values into a single structured object. This is redundant storage but serves a different purpose (debug diagnostics in a single queryable JSONB blob vs. individual indexed columns).

### failure_reason

`failure_reason` is always `null`. The pipeline has no codepath that sets it to a non-null value. If Track C wants meaningful failure reasons, new logic would need to be added — for example, mapping `capture_validity === 'invalid'` or `classification === null` to a reason string. REPO-VERIFIED: `lib/persistSwing.ts:74`

---

## SECTION 7 — Existing Coach/Code References

### grep results for "coach" / "COACH"

| File | What it is | Relevance to Track C |
|---|---|---|
| `app/onboarding.tsx:19` | `COACH_OPTIONS = ['Dave Donnellan', 'No coach']` — hardcoded picker during onboarding | **Related but architecturally separate** |
| `app/onboarding.tsx:38-42` | Writes `coach_name` to `profiles` table on upsert | Writes to **profiles**, not **swings** |
| `components/VisualCoachCard.tsx` | Visual coaching card with skeleton overlay | **Unrelated** — "coach" here means "coaching cue", not a person |
| `supabase/functions/classify-grip/index.ts:23` | Prompt text "Do NOT provide coaching paragraphs" | **Unrelated** — prompt instruction |
| `app/(tabs)/index.tsx:39` | "Your pocket swing coach" subtitle | **Unrelated** — marketing copy |

REPO-VERIFIED: All files listed above.

### Verdict

**Existing coach infrastructure is limited to the onboarding flow.** It writes a `coach_name` to the `profiles` table (line 42), not to `swings`. The onboarding picker is a hardcoded two-option list (`'Dave Donnellan'` or `'No coach'`).

**Track C's coach code system is architecturally separate from onboarding.** The spec describes:
- A coach **code** entered post-onboarding via the Home screen
- Stored in **AsyncStorage** (client-side)
- A hardcoded **code → display name** mapping
- Attribution written to the **swings** table per-swing

The onboarding coach picker writes to **profiles**. Track C writes to **swings**. They are complementary but operate on different tables, different screens, and different lifecycles. The onboarding picker could eventually be replaced by or unified with the code-entry system, but that is out of scope for Track C.

---

## SECTION 8 — Facts vs Unknowns Summary

| # | CONFIRMED | Source |
|---|---|---|
| 1 | `persistSwing` is the single insertion point for swings — row object at lines 59-77 | Section 1 |
| 2 | Neither `coach_name` nor `swing_debug` exist on the swings table | Section 2 |
| 3 | No migration files exist in repo — first migration sets the convention | Section 2 |
| 4 | AsyncStorage is used inline with `honeyswing:` prefix convention | Section 3 |
| 5 | Home screen has tappable row patterns (grip button is closest analog) | Section 4 |
| 6 | Result screen reads all data from in-memory swingMotionStore, no route params | Section 5 |
| 7 | Tempo chip is the closest UI pattern for a coach attribution metadata line | Section 5 |
| 8 | All four swing_debug sub-fields are already computed at persist-time as top-level columns | Section 6 |
| 9 | `failure_reason` is always `null` — no logic populates it | Section 6 |
| 10 | Onboarding has a coach picker → profiles table; Track C is architecturally separate (→ swings table, AsyncStorage, Home screen) | Section 7 |
| 11 | Coach code format: short alphanumeric code (spec-defined) | Spec |
| 12 | Coach code → display name: hardcoded mapping (spec-defined) | Spec |
| 13 | Coach code storage: AsyncStorage (spec-defined) | Spec |
| 14 | Coach code persistence lifetime: survives app restart, cleared on account delete (spec-defined) | Spec |

| # | UNKNOWN / NEEDS RESOLUTION |
|---|---|
| 1 | Exact swings table DDL — no migrations in repo. Columns are inferred from insert shape only. Adding columns requires verifying current schema in Supabase dashboard or running `\d swings`. |
| 2 | Should `failure_reason` in `swing_debug` carry meaningful values, or remain `null` for now? No pipeline logic currently produces a reason string. |
| 3 | Should the Settings screen's "Delete Account" flow also clear the coach code from AsyncStorage? (Currently clears 3 keys — Section 3.) |
| 4 | Should the onboarding coach picker be hidden/removed/unified now that Track C introduces code-entry? Or leave both in place? |

---

## SECTION 9 — Quality Bar Self-Check

### 1. What is actually compiled and running?

- **Persist layer:** `lib/persistSwing.ts` — single function, single Supabase insert, called from `app/(tabs)/record.tsx:246`
- **Storage layer:** `@react-native-async-storage/async-storage` — inline usage across 8 files, `honeyswing:` prefix convention
- **Home screen:** `app/(tabs)/index.tsx` — flat layout, focus card + grip button patterns
- **Result screen:** `app/analysis/result.tsx` — reads from in-memory store, tempo chip metadata pattern
- **Onboarding:** `app/onboarding.tsx` — existing coach picker writes to `profiles` table

### 2. What is dead code?

- `lib/persistSwing.ts:57` — the `AsyncStorage.getItem('honeyswing:profileId')` fallback is dead code. The early return at line 53-55 means `profileId` always equals `authUserId` when reached. Not coach-related, but notable for persist layer understanding.
- No coach-related dead code found.

### 3. Where does new logic attach?

| Layer | Attachment point |
|---|---|
| **DB schema** | New migration: `ALTER TABLE swings ADD COLUMN coach_name TEXT, ADD COLUMN swing_debug JSONB` |
| **Persist layer** | `lib/persistSwing.ts` lines 59-77 — add `coach_name` and `swing_debug` to the row object |
| **Storage layer** | New AsyncStorage key (`honeyswing:coachCode` or similar) — read/write inline, following existing pattern |
| **Home screen** | `app/(tabs)/index.tsx` — new tappable row (following grip button pattern) for coach code entry |
| **Result screen** | `app/analysis/result.tsx` — new metadata line (following tempo chip pattern) showing coach attribution |
| **Settings screen** | `app/settings.tsx:31` — add coach code key to `multiRemove` array for account deletion cleanup |

### 4. What will fail first and why?

The **Supabase insert** will fail if `coach_name` or `swing_debug` are added to the row object before the migration adds those columns. The insert call uses a plain object — Supabase will reject unknown columns. **Migration must deploy before code ships.**

Secondary risk: if the coach code AsyncStorage key is not cleared on account deletion (`settings.tsx:31`), a stale coach code could persist after account reset.

### 5. What should the developer test first to validate feasibility?

1. **Verify swings table accepts new columns:** Run the ALTER TABLE migration against Supabase, then manually insert a row with `coach_name` and `swing_debug` via the dashboard.
2. **Verify AsyncStorage round-trip:** Write a coach code to AsyncStorage, kill the app, relaunch, read it back. Confirm it survives app restart.
3. **Verify persist flow end-to-end:** Add the two new fields to the row object in `persistSwing.ts`, record a swing, check the Supabase dashboard to confirm both fields land in the new row.
