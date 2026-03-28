# Track C — Coach Link + Trust Slice: Exhaustive Codebase Audit

**Date:** 2026-03-28
**Branch:** v3-dev
**Purpose:** Map every attachment point for Track C features before implementation design (Prompt 2).

---

## SECTION 1 — persistSwing Pipeline

**File:** `lib/persistSwing.ts` (92 lines total)

### Function Signature (line 41)

```typescript
export async function persistSwing(
  frames: PoseFrame[],
  analysis: AnalysisResult,
  classification: CaptureClassification | null,
): Promise<string | null>
```

REPO-VERIFIED: `lib/persistSwing.ts:41-45`

### Fields Currently Inserted into swings Table (lines 59–77)

The insert object `row: Record<string, unknown>` contains:

| # | Field | Value | Line |
|---|-------|-------|------|
| 1 | `user_id` | `profileId` (conditional spread) | 60 |
| 2 | `motion_frames` | `frames` (PoseFrame[]) | 61 |
| 3 | `frame_count` | `frames.length` | 62 |
| 4 | `duration_ms` | `Math.round(durationMs)` | 63 |
| 5 | `score` | `analysis.score` | 64 |
| 6 | `honey_boom` | `analysis.honeyBoom` | 65 |
| 7 | `angles` | `analysis.angles ?? null` | 66 |
| 8 | `tempo` | `analysis.tempo ?? null` | 67 |
| 9 | `phases` | `analysis.phases ?? null` | 68 |
| 10 | `backswing_ms` | `analysis.tempo?.backswingMs` (rounded) or null | 69 |
| 11 | `downswing_ms` | `analysis.tempo?.downswingMs` (rounded) or null | 70 |
| 12 | `tempo_ratio` | `analysis.tempo?.ratio ?? null` | 71 |
| 13 | `pose_success_rate` | `calcPoseSuccessRate(frames)` | 72 |
| 14 | `phase_source` | `extractPhaseSource(analysis.phases)` | 73 |
| 15 | `failure_reason` | `null` (hardcoded) | 74 |
| 16 | `capture_validity` | `classification?.validity ?? 'unknown'` | 75 |
| 17 | `app_version` | `'1.3.0'` (hardcoded constant, line 8) | 76 |

REPO-VERIFIED: `lib/persistSwing.ts:59-77`

### user_id Resolution (lines 52–57)

```typescript
const authUserId = await getUserId();        // line 52
if (!authUserId) {                           // line 53
  console.log('[persistSwing] No user, skipping DB write')
  return                                     // line 55 — EARLY RETURN, no insert
}
const profileId = authUserId ?? await AsyncStorage.getItem('honeyswing:profileId');  // line 57
```

- `getUserId()` calls `supabase.auth.getUser()` and returns `user?.id ?? null`. REPO-VERIFIED: `lib/supabase.ts:27-30`
- When `authUserId` is null: **early return at line 55 — no DB write occurs.**
- Line 57 is **dead code**: the `??` branch is unreachable because lines 53–55 already returned when `authUserId` is null. `profileId` always equals `authUserId`.
- `user_id` is set via conditional spread: `...(profileId ? { user_id: profileId } : {})` (line 60). Given the dead-code analysis, `profileId` is always truthy at this point.

REPO-VERIFIED: `lib/persistSwing.ts:52-57`, `lib/supabase.ts:27-30`

### Supabase Insert Call (line 79)

```typescript
const { data, error } = await supabase.from('swings').insert(row).select('id').single();
```

Single-row insert, returns `{ id: string }` on success. Error logged but not thrown (line 82).

REPO-VERIFIED: `lib/persistSwing.ts:79`

### Call Site

```typescript
swingIdPromiseRef.current = persistSwing(frames, analysis, classification).catch(() => null);
```

REPO-VERIFIED: `app/(tabs)/record.tsx:246` (reported by agent — exact line not independently re-verified in this read pass, but function name and call pattern confirmed by grep)

### Where coach_name and swing_debug Would Attach

- **coach_name**: New key-value pair in the `row` object literal (lines 59–77). Value would come from the storage layer (AsyncStorage read of coach code, mapped to display name). Attaches at the **persist layer**.
- **swing_debug**: New key-value pair in the `row` object literal. Value would be a JSONB object assembled from values already computed in this function. Attaches at the **persist layer** — no new computation needed, just bundling existing fields.

### Helper Functions in persistSwing.ts

1. `calcPoseSuccessRate(frames)` (lines 17–31): Counts frames where ≥4 of 8 key joints have confidence ≥0.3. Returns float 0–1.
2. `extractPhaseSource(phases)` (lines 33–39): Maps phase array to `'heuristic' | 'fallback' | 'mixed' | 'none'`.

Both REPO-VERIFIED with line numbers above.

---

## SECTION 2 — swings Table Schema

### Migration Files

**No `supabase/migrations/` directory exists.** The directory listing returns nothing. Database schema is managed outside version control (Supabase dashboard or remote CLI).

REPO-VERIFIED: `ls supabase/migrations/` → `NO_MIGRATIONS_DIR`

The `supabase/` directory contains only:
- `config.toml` — local dev configuration
- `functions/classify-grip/` — edge function for grip classification
- `.temp/cli-latest` — CLI metadata

### Inferred swings Table Columns

Since no migration files exist, the schema is inferred from the insert shape in `lib/persistSwing.ts:59-77` (see Section 1). The swings table must have at minimum these 17 columns plus Supabase defaults:

- `id` (UUID PK, auto-generated — returned by `.select('id')`)
- `created_at` (timestamptz, auto-populated by Supabase default)
- All 17 fields from the insert object (see Section 1 table)

### Do coach_name or swing_debug Already Exist?

- `grep -rn "swing_debug" --include="*.ts" --include="*.tsx"` → **zero results**
- `grep -rn "coach_name" --include="*.ts" --include="*.tsx"` → results ONLY in `app/onboarding.tsx:42` where it is written to the **profiles** table, NOT the swings table

REPO-VERIFIED: grep results confirmed

### Migration Naming Convention

No established convention — no migration files exist. First migration sets the precedent. Standard Supabase convention: `YYYYMMDDHHMMSS_description.sql`.

### Verdict

**Neither `coach_name` nor `swing_debug` exists on the swings table.** Both columns must be added via migration before code references them. If code ships before migration deploys, inserts will fail with "column does not exist" — the current insert call (line 79) does not destructure or cherry-pick columns, so an unknown column in the `row` object will cause a Postgres error.

---

## SECTION 3 — AsyncStorage Usage Pattern

### Current Keys

| Key | Read by | Written by | Type |
|-----|---------|------------|------|
| `honeyswing:onboardingComplete` | `app/_layout.tsx:50,67`, `app/auth/callback.tsx:14` | `app/onboarding.tsx:59` | string `'true'` |
| `honeyswing:profileId` | `lib/persistSwing.ts:57` (dead branch) | `app/onboarding.tsx:62` | UUID string |
| `honeyswing:isLeftHanded` | `lib/handedness.ts:6` | `app/onboarding.tsx:60` | string `'true'`/`'false'` |
| `honeyswing:localSwingCount` | `lib/swingLimit.ts:15,25` | `lib/swingLimit.ts:17` | string of integer |
| `honeyswing:todaysFocus` | `lib/swingMotionStore.ts:148` | `lib/swingMotionStore.ts:144` | JSON string (FocusData) |

Additionally, Supabase auth uses AsyncStorage as its session persistence layer: `lib/supabase.ts:10`.

Account deletion clears 3 keys via `AsyncStorage.multiRemove()`: `app/settings.tsx:31-35`.

REPO-VERIFIED: all files and line numbers above.

### Import Pattern

Every file uses:
```typescript
import AsyncStorage from '@react-native-async-storage/async-storage';
```

No re-export, no wrapper. Direct import everywhere. REPO-VERIFIED: 9 files.

### Read/Write Patterns

- **Read:** `await AsyncStorage.getItem(KEY)` — returns `string | null`. Callers handle null with `??`, ternary, or early return.
- **Write:** `await AsyncStorage.setItem(KEY, stringValue)` — always `await`ed. Values serialized manually: `String(bool)`, `String(count + 1)`, `JSON.stringify(object)`.
- **Delete:** `await AsyncStorage.multiRemove([...keys])` — used once in settings.tsx for account deletion.
- **Batch read:** Not used. Each key read individually.

### Storage Helper Modules

There is **no centralized storage module**. Instead, domain-specific helpers encapsulate AsyncStorage access:

| Helper | File | Functions |
|--------|------|-----------|
| Focus persistence | `lib/swingMotionStore.ts:143-151` | `saveFocus()`, `loadFocus()` |
| Handedness | `lib/handedness.ts:5-8` | `getIsLeftHanded()` |
| Swing limit | `lib/swingLimit.ts:14-60` | `incrementLocalSwingCount()`, `checkSwingLimit()` |

**Pattern:** Each domain concern owns its own AsyncStorage key via a module-level constant and exposes typed get/set functions. No generic `storage.ts` helper exists.

A new coach code storage concern should follow this same pattern: module-level key constant, typed getter/setter functions in a domain-specific file.

---

## SECTION 4 — Home Screen Structure

**File:** `app/(tabs)/index.tsx` (188 lines)

### Component: `TabsHomeScreen` (lines 14–82)

**State:** `focus: FocusData | null`, `gripUri: string | null`

**Data loading** (lines 19–25): `useFocusEffect` runs on every tab focus — calls `loadFocus()` (AsyncStorage) and `getGrip()` (gripStore). No Supabase calls on Home.

### Current Rendered Components (top-to-bottom order)

| # | Component | Lines | Description |
|---|-----------|-------|-------------|
| 1 | Settings button | 29–35 | Top-right absolute-positioned icon → `router.push('/settings')` |
| 2 | Hero section | 37–40 | "HoneySwing" title + "Your pocket swing coach" subtitle |
| 3 | Today's Focus card | 42–52 | **Conditional** (renders only if `focus` is non-null). Card with: title "TODAY'S FOCUS", colored dot + label row, coaching cue text. Background: `#1A1A1C`, border-radius: 14 |
| 4 | Start Swinging CTA | 55–61 | Primary orange button → `router.push('/(tabs)/record')` |
| 5 | Grip Photo button | 63–74 | Bordered button with optional thumbnail → `router.push('/grip/capture')`. Text toggles "Update Grip Photo" / "Capture Grip" |
| 6 | Hint text | 76–78 | Gray text, toggles between "Record a swing to update your focus" / "Let's see that swing" |

REPO-VERIFIED: `app/(tabs)/index.tsx:27-78`

### Tappable Row/Card Patterns

- **Today's Focus card** (lines 42–52): Static `<View>` — not tappable, no `TouchableOpacity` wrapper. Read-only card.
- **Grip Photo button** (lines 63–74): `TouchableOpacity` with conditional image + text. Navigates via `router.push`.
- All interactive elements are `TouchableOpacity` with `onPress` handlers.

### Navigation Patterns

All navigation from Home uses `router.push()`:
- `/settings` (line 31)
- `/(tabs)/record` (line 57)
- `/grip/capture` (line 65)

No modals, no inline text inputs, no bottom sheets on this screen.

### Where a Coach Link Row Would Attach

The Home screen is a vertically-centered `View` (not a ScrollView). Components render in order between the hero and the hint. A coach link element would logically sit in the card area (between items 3–5), following the existing card style (`#1A1A1C` background, 14px border-radius). The existing grip button (item 5) is the closest pattern for a tappable row that shows state and navigates or opens input.

---

## SECTION 5 — Result Screen Structure

**File:** `app/analysis/result.tsx` (441 lines — 279 component + 162 styles)

### Data Sources (lines 66–70)

| Source | Accessor | Type |
|--------|----------|------|
| Swing motion | `getCurrentSwingMotion()` from swingMotionStore | `LiveSwingMotionData \| null` |
| Swing analysis | `getCurrentSwingAnalysis()` from swingMotionStore | `AnalysisResult \| null` |
| Video URI | `getCurrentSwingVideoUri()` from swingMotionStore | `string \| null` |

Additional async loads:
- `getIsLeftHanded()` → `lib/handedness.ts` (line 86)
- `checkSwingLimit()` → `lib/swingLimit.ts` (lines 88–94)

Classification is computed in-component: `classifyCapture(motion.frames)` (lines 97–100).

Analysis has a fallback path: if `storedAnalysis` is null and capture is not invalid, `analyzePoseSequence(sequence)` runs in-component (lines 116–119). Final analysis: `storedAnalysis ?? fallbackAnalysis` (line 121).

REPO-VERIFIED: `app/analysis/result.tsx:65-121`

### Current Rendered Components (valid capture path, lines 183–273)

| # | Component | Lines | Description |
|---|-----------|-------|-------------|
| 1 | Header | 153–163 | "← Back" button + "Your Swing" title |
| 2 | Score card | 185–193 | Large centered score (96px). Low-confidence badge. "Honey Boom!" text |
| 3 | Video replay | 196–218 | VideoView (9:16 aspect) + speed buttons (0.25x, 0.5x, 1x) |
| 4 | Visual Coach | 221–229 | `VisualCoachCard` component — skeleton overlay + worst-metric coaching cue |
| 5 | Tempo chip | 233–239 | Label "Tempo" + rating value with color |
| 6 | Record Again CTA | 243–249 | Primary button → `router.back()` |
| 7 | Sign-in prompt | 252–264 | Conditional (limit hit + not signed in). Card with CTA → `/signin` |
| 8 | Swing Art card | 267–272 | `SwingArtCard` — valid captures only |

Empty state (line 167) and invalid capture state (lines 168–181) are separate branches.

REPO-VERIFIED: `app/analysis/result.tsx:151-273`

### Existing Metadata Line Patterns

- **Low confidence badge** (line 187): `<Text style={styles.lowConfBadge}>Quick look — try a longer swing next time</Text>` — conditional text above the score. Style: `#F5A623`, 13px, 600 weight.
- **Tempo chip** (lines 233–239): Row with label + value in `#1A1A1C` card. Style: `flexDirection: 'row'`, 12px border-radius.
- **"Honey Boom!" text** (lines 190–191): Conditional text below the score. Style: `#F5A623`, 22px, 700 weight.

The **tempo chip** (item 5) is the closest existing pattern for a metadata attribution line — a horizontal row with label on left and value on right inside a dark card.

### Where Coach Attribution Would Attach

A coach attribution line fits naturally in the metadata zone between the Visual Coach card (item 4) and the Record Again CTA (item 6). The tempo chip pattern (label + value in a `#1A1A1C` card row) is the closest existing style match. Data source: coach name would come from the storage layer (AsyncStorage), not from the swing analysis pipeline.

### Today's Focus Side Effect

Lines 128–132: after analysis is available, computes and persists the weakest metric as "Today's Focus" for the Home screen. This is a **write** side effect on the Result screen — it persists to AsyncStorage, not Supabase.

REPO-VERIFIED: `app/analysis/result.tsx:128-132`

---

## SECTION 6 — swingMotionStore Shape

**File:** `lib/swingMotionStore.ts` (151 lines)

### Store Architecture

Module-level singleton with three mutable variables (lines 12–14):

```typescript
let currentMotion: LiveSwingMotionData | null = null;
let currentAnalysis: AnalysisResult | null = null;
let currentVideoUri: string | null = null;
```

Accessors: `set`/`get`/`clear` for each. No persistence — state is lost on app restart (per CLAUDE.md).

REPO-VERIFIED: `lib/swingMotionStore.ts:12-14`

### LiveSwingMotionData Type (lines 6–10)

```typescript
export type LiveSwingMotionData = {
  frames: PoseFrame[];
  recordedAt: number;
  source: 'live-camera';
};
```

### AnalysisResult Type (from `packages/domain/swing/analysisPipeline.ts:7-13`)

```typescript
export type AnalysisResult = {
  score: number;
  honeyBoom: boolean;
  angles?: any;
  tempo?: any;
  phases?: any[];
};
```

REPO-VERIFIED: `packages/domain/swing/analysisPipeline.ts:7-13`

### swing_debug Field Availability at Persist-Time

For each proposed `swing_debug` field:

| Field | Available? | Current Value | Source | Notes |
|-------|-----------|---------------|--------|-------|
| `frame_count` | **YES** | `frames.length` | `lib/persistSwing.ts:62` | Already a top-level column in the insert. |
| `pose_success_rate` | **YES** | `calcPoseSuccessRate(frames)` → float 0–1 | `lib/persistSwing.ts:72` | Already a top-level column. Computed from frames parameter. |
| `phase_source` | **YES** | `extractPhaseSource(analysis.phases)` → `'heuristic' \| 'fallback' \| 'mixed' \| 'none'` | `lib/persistSwing.ts:73` | Already a top-level column. Computed from analysis parameter. |
| `failure_reason` | **YES, but always `null`** | `null` | `lib/persistSwing.ts:74` | Hardcoded. No pipeline logic populates this. No `CaptureClassification.reason` is forwarded — `classification.reason` exists but is not used in the insert. |

**Key insight:** All four fields are already computed and inserted as **individual top-level columns** on the swings table. Bundling them into a `swing_debug` JSONB column would create redundancy — the same values would exist in two places. Implementation must decide: (a) populate `swing_debug` from the same computed values (redundant but schema-clean for the "trust slice" feature), or (b) query existing top-level columns instead of adding `swing_debug`.

### What Is NOT Available

- `failure_reason` has no logic to populate it. `CaptureClassification.reason` (e.g., "Try a slower, fuller swing next time") exists at `lib/captureValidity.ts:49-59` and is passed to `persistSwing` via the `classification` parameter, but is **never forwarded to the insert object**. The `classification.reason` value is available at persist-time; it just isn't used.
- No other debug fields beyond the four listed are available without new computation.

REPO-VERIFIED: all line numbers above.

---

## SECTION 7 — Existing Coach/Code References

### grep Results

`grep -rn "coach" -i --include="*.ts" --include="*.tsx"` returned matches in these files:

| File | Lines | Context |
|------|-------|---------|
| `app/onboarding.tsx` | 19, 24, 38, 42, 95–108 | Coach picker during onboarding |
| `app/analysis/result.tsx` | 27, 147, 220, 222 | `VisualCoachCard` — refers to "coaching" in the swing analysis sense, NOT coach attribution |
| `components/VisualCoachCard.tsx` | 148, 195, 240 | Component that shows coaching cues — biomechanical coaching, not human coach |
| `supabase/functions/classify-grip/index.ts` | 23 | Prompt instruction "Do NOT provide coaching paragraphs" — grip prompt, not coach attribution |
| `app/(tabs)/index.tsx` | 39 | "Your pocket swing coach" — tagline, not coach infrastructure |

`grep -rn "COACH" --include="*.ts" --include="*.tsx"` returned:

| File | Line | Context |
|------|------|---------|
| `app/onboarding.tsx` | 19 | `const COACH_OPTIONS = ['Dave Donnellan', 'No coach'] as const;` |

### Existing Coach Infrastructure: Onboarding Picker

**File:** `app/onboarding.tsx` (lines 19, 24, 38, 42, 95–114)

The onboarding screen has a coach picker with hardcoded options:

```typescript
const COACH_OPTIONS = ['Dave Donnellan', 'No coach'] as const;
```

- User selects from `COACH_OPTIONS` (radio-style toggle, lines 97–114)
- Default selection: `'No coach'` (line 24)
- On submit: `const coachName = coach === 'No coach' ? null : coach;` (line 38)
- Written to: `profiles` table as `coach_name: coachName` (line 42)
- Written via: `supabase.from('profiles').upsert(row)` (line 51–55)

**This writes to the `profiles` table, NOT the `swings` table.**

REPO-VERIFIED: `app/onboarding.tsx:19-55`

### Verdict: Relationship to Track C's Coach Code System

The existing onboarding coach picker and the spec's coach code entry system are **architecturally separate** but conceptually related:

1. **Existing system** (onboarding): Hardcoded list of coach names → writes `coach_name` to `profiles` table at onboarding time. One-time selection. No code entry, no dynamic mapping, no attribution on swings.

2. **Spec system** (Track C): Coach code entry via AsyncStorage → hardcoded code→name mapping → writes `coach_name` to `swings` table per-swing. Persistent across sessions. Shows attribution on Result screen and link on Home screen.

**They operate on different tables** (`profiles` vs `swings`) and **at different times** (onboarding vs per-swing). The existing `profiles.coach_name` could serve as a default or fallback, but Track C's `swings.coach_name` is per-swing attribution that comes from the code-entry flow, not from the profile.

**No existing coach code entry, code→name mapping, or swing-level coach attribution exists anywhere in the repo.**

---

## SECTION 8 — Facts vs Unknowns Summary

| # | CONFIRMED | Section |
|---|-----------|---------|
| 1 | `persistSwing` signature takes `(frames, analysis, classification)` and inserts 17 fields into `swings` table | §1 |
| 2 | Insert point for `coach_name` and `swing_debug` is the `row` object at `lib/persistSwing.ts:59-77` | §1 |
| 3 | No `supabase/migrations/` directory exists — schema managed externally | §2 |
| 4 | Neither `coach_name` nor `swing_debug` column exists on `swings` table | §2 |
| 5 | AsyncStorage pattern: domain-specific modules with `honeyswing:` prefixed keys, typed getter/setters | §3 |
| 6 | 5 AsyncStorage keys in use; no centralized storage helper | §3 |
| 7 | Home screen is a centered `View` (not ScrollView) with hero, focus card, CTA, grip button, hint | §4 |
| 8 | No modals or inline text inputs exist on Home screen today | §4 |
| 9 | Result screen reads from swingMotionStore (in-memory), not from Supabase or route params | §5 |
| 10 | Tempo chip is the closest existing pattern for a metadata attribution row on Result screen | §5 |
| 11 | All four `swing_debug` fields are already computed and stored as top-level columns | §6 |
| 12 | `failure_reason` is always `null` — but `classification.reason` is available at persist-time and not used | §6 |
| 13 | Onboarding coach picker writes `coach_name` to `profiles` table — separate from per-swing attribution | §7 |
| 14 | No coach code entry, code→name mapping, or per-swing coach attribution exists in the repo | §7 |

| # | UNKNOWN / NEEDS RESOLUTION |
|---|---------------------------|
| 1 | **Migration deployment sequence:** Migration must land before code. How is the migration deployed? Supabase CLI push, dashboard SQL editor, or CI pipeline? No migration tooling exists in repo. |
| 2 | **swing_debug redundancy:** The four `swing_debug` fields already exist as top-level columns. Should `swing_debug` JSONB duplicate them (redundant), replace them (breaking change), or contain only *new* fields not already top-level? |
| 3 | **failure_reason population:** Spec lists `failure_reason` as a `swing_debug` field. Currently always `null`. Should it be populated from `classification.reason` (which has user-facing strings like "Try a slower, fuller swing next time"), or remain null? |
| 4 | **Onboarding coach picker relationship:** The spec's code-entry system writes `coach_name` to `swings`. Onboarding already writes `coach_name` to `profiles`. Should the onboarding picker be updated, removed, or left untouched? |
| 5 | **Home screen layout implications:** Home is a centered `View`, not a ScrollView. Adding a coach link row increases vertical content. May need layout adjustment if content overflows on smaller screens. |

---

## SECTION 9 — Quality Bar Self-Check

### 1. What is actually compiled and running?

Relevant pipeline components for Track C:

- **Persist layer:** `lib/persistSwing.ts` — single function, single Supabase insert call, 17 fields. This is where `coach_name` and `swing_debug` attach.
- **Storage layer:** AsyncStorage with domain-specific helpers (`lib/swingMotionStore.ts`, `lib/handedness.ts`, `lib/swingLimit.ts`). Coach code storage follows this pattern.
- **Home surface:** `app/(tabs)/index.tsx` — loads focus from AsyncStorage on tab focus. Coach link row attaches here.
- **Result surface:** `app/analysis/result.tsx` — reads from swingMotionStore. Coach attribution line attaches here (metadata zone near tempo chip).
- **Onboarding:** `app/onboarding.tsx` — has existing coach picker writing to `profiles` table. Architecturally separate from per-swing attribution (§7).

### 2. What is dead code?

- `lib/persistSwing.ts:57` — AsyncStorage fallback for `profileId` is unreachable (§1).
- No coach-related dead code found. The onboarding coach picker is live and functional — it writes to `profiles`, not `swings`.

### 3. Where does new logic attach?

| Layer | File | Attachment Point |
|-------|------|-----------------|
| **DB schema** | New migration file (no dir exists yet) | Add `coach_name TEXT` and `swing_debug JSONB` to `swings` |
| **Storage layer** | New domain helper in `lib/` | AsyncStorage key for coach code, getter/setter, code→name mapping |
| **Persist layer** | `lib/persistSwing.ts:59-77` | Add `coach_name` and `swing_debug` to `row` object |
| **Home surface** | `app/(tabs)/index.tsx` | Coach link row in card area (between focus card and CTA) |
| **Result surface** | `app/analysis/result.tsx` | Coach attribution line in metadata zone (near tempo chip, lines 232–240) |

### 4. What will fail first and why?

**Migration timing.** If `coach_name` or `swing_debug` is added to the `row` object in `persistSwing.ts` before the migration adds those columns to the Supabase `swings` table, every swing persist will fail with a Postgres "column does not exist" error. The error is logged but not thrown (line 82), so the app won't crash — but swings silently stop being saved. This is the highest-risk failure mode.

Second risk: **Home screen overflow.** Adding a coach link row to a centered `View` (not ScrollView) could push content off-screen on smaller devices (iPhone SE).

### 5. What should the developer test first to validate feasibility?

1. **Run the migration** (add both columns to `swings` table via Supabase dashboard or CLI) and confirm that existing `persistSwing` calls still succeed with the new columns defaulting to null.
2. **Add a hardcoded `coach_name: 'Test Coach'`** to the `row` object in `persistSwing.ts` and verify it persists to Supabase by checking the swings table after a test swing.
3. **Add a test AsyncStorage key** (`honeyswing:coachCode`) and verify read/write round-trip from the Home screen `useFocusEffect`.

These three tests confirm: schema compatibility, persist-layer wiring, and storage-layer pattern — the three infrastructure layers that must work before any UI is built.
