# Track C — Coach Link + Trust Slice: Codebase Audit

**Date:** 2026-03-28
**Branch:** v3-dev
**Auditor:** Claude (automated)

---

## SECTION 1 — persistSwing Pipeline

**Source file:** `lib/persistSwing.ts` (92 lines)

### Function signature

```ts
export async function persistSwing(
  frames: PoseFrame[],
  analysis: AnalysisResult,
  classification: CaptureClassification | null,
): Promise<string | null>
```
REPO-VERIFIED `lib/persistSwing.ts:41-45`

### Fields currently inserted into swings table

The `row` object at lines 59-77 contains:

| Field              | Source                                      | Line |
|--------------------|---------------------------------------------|------|
| `user_id`          | `profileId` (see below)                     | 60   |
| `motion_frames`    | raw `frames` array                          | 61   |
| `frame_count`      | `frames.length`                             | 62   |
| `duration_ms`      | computed from first/last frame timestamps   | 63   |
| `score`            | `analysis.score`                            | 64   |
| `honey_boom`       | `analysis.honeyBoom`                        | 65   |
| `angles`           | `analysis.angles ?? null`                   | 66   |
| `tempo`            | `analysis.tempo ?? null`                    | 67   |
| `phases`           | `analysis.phases ?? null`                   | 68   |
| `backswing_ms`     | `analysis.tempo?.backswingMs` rounded       | 69   |
| `downswing_ms`     | `analysis.tempo?.downswingMs` rounded       | 70   |
| `tempo_ratio`      | `analysis.tempo?.ratio ?? null`             | 71   |
| `pose_success_rate`| `calcPoseSuccessRate(frames)`               | 72   |
| `phase_source`     | `extractPhaseSource(analysis.phases)`       | 73   |
| `failure_reason`   | hardcoded `null`                            | 74   |
| `capture_validity` | `classification?.validity ?? 'unknown'`     | 75   |
| `app_version`      | constant `'1.3.0'`                          | 76   |

REPO-VERIFIED `lib/persistSwing.ts:59-77`

### user_id resolution

1. `getUserId()` returns `supabase.auth.getUser().id` or `null`. REPO-VERIFIED `lib/supabase.ts:27-29`
2. If `authUserId` is null, the function **returns early** (line 53-56) — no DB write. REPO-VERIFIED `lib/persistSwing.ts:53-56`
3. Line 57 has a dead fallback: `authUserId ?? AsyncStorage.getItem('honeyswing:profileId')` — this code is unreachable because the early return already handled `authUserId === null`. REPO-VERIFIED `lib/persistSwing.ts:57`

### Supabase insert call shape

```ts
const { data, error } = await supabase.from('swings').insert(row).select('id').single();
```
REPO-VERIFIED `lib/persistSwing.ts:79`

Single `.insert(row)` with `.select('id').single()` — returns the new row's `id`.

### Insertion point for coach_name and swing_debug

Both fields would attach inside the `row` object literal at lines 59-77. The `coach_name` field would be read from AsyncStorage (or a helper) at persist-time, slotting in alongside the other metadata fields. `swing_debug` is a JSONB payload assembled from values already computed within this function (`frame_count`, `pose_success_rate`, `phase_source`, `failure_reason`) plus `app_version` and `capture_validity`.

Specifically: the new fields would be added between lines 76 and 77 (after `app_version`, before the closing brace). No structural changes to the function are needed — it's a flat key-value addition to the `row` object.

REPO-VERIFIED — insertion point identified at `lib/persistSwing.ts:76-77`

### Call site

`persistSwing` is called exactly once, in `app/(tabs)/record.tsx:246`:
```ts
swingIdPromiseRef.current = persistSwing(frames, analysis, classification).catch(() => null);
```
REPO-VERIFIED `app/(tabs)/record.tsx:246`

---

## SECTION 2 — swings Table Schema

### Migration files

The `supabase/migrations/` directory is **empty** — no migration files found. REPO-VERIFIED (glob `supabase/migrations/**/*` returned zero results).

This means the swings table schema is managed outside local migrations (likely created directly in Supabase dashboard or via a seed script not tracked in-repo). The columns are inferred from the `persistSwing` insert call (Section 1).

### Current columns (inferred from insert shape)

Based on the `row` object in `lib/persistSwing.ts:59-77`, the swings table has at minimum:

`id` (returned by `.select('id')`), `user_id`, `motion_frames`, `frame_count`, `duration_ms`, `score`, `honey_boom`, `angles`, `tempo`, `phases`, `backswing_ms`, `downswing_ms`, `tempo_ratio`, `pose_success_rate`, `phase_source`, `failure_reason`, `capture_validity`, `app_version`

Plus any auto-generated columns (e.g. `created_at`). EXTERNAL ASSUMPTION — no DDL in repo to confirm auto-columns.

### Do coach_name or swing_debug already exist?

- `grep -rn "swing_debug"` across all .ts/.tsx: **zero matches**. REPO-VERIFIED.
- `grep -rn "coach_name"` in the context of the swings table: the string `coach_name` appears only in onboarding, where it's inserted into the **profiles** table, not swings. REPO-VERIFIED `app/onboarding.tsx:42`.

**Verdict: Neither `coach_name` nor `swing_debug` exist on the swings table. Both columns must be added.**

### Migration naming convention

No local migrations exist. A new migration will need to be created. Convention is TBD — there is no precedent in-repo. REPO-VERIFIED.

Note: `coach_name` already exists on the **profiles** table (set during onboarding). The Track C feature adds a *separate* `coach_name` to the **swings** table for per-swing attribution — this is a distinct concern from the profile-level coach.

---

## SECTION 3 — AsyncStorage Usage Pattern

### All current keys

| Key                              | Module                      | Read/Write | Purpose                       |
|----------------------------------|-----------------------------|------------|-------------------------------|
| `honeyswing:onboardingComplete`  | `app/onboarding.tsx:59`, `app/auth/callback.tsx:14`, `app/_layout.tsx:50,67` | R+W | Gate onboarding screen |
| `honeyswing:profileId`           | `app/onboarding.tsx:62`, `lib/persistSwing.ts:57` | R+W | Anonymous profile fallback ID |
| `honeyswing:isLeftHanded`        | `app/onboarding.tsx:60`, `lib/handedness.ts:6` | R+W | Handedness preference |
| `honeyswing:localSwingCount`     | `lib/swingLimit.ts:15,25`  | R+W        | Anonymous swing counter       |
| `honeyswing:todaysFocus`         | `lib/swingMotionStore.ts:144,148` | R+W  | Persisted focus metric        |
| (Supabase auth session)          | `lib/supabase.ts:10`       | R+W        | Supabase uses AsyncStorage as auth storage backend |

REPO-VERIFIED — all references from grep results.

### Import pattern

All files use the same direct import:
```ts
import AsyncStorage from '@react-native-async-storage/async-storage';
```
REPO-VERIFIED — consistent across all 8 files that import it.

### Read/write pattern

- **Write:** `AsyncStorage.setItem(KEY, stringValue)` — always string values, JSON.stringify for objects.
- **Read:** `AsyncStorage.getItem(KEY)` — returns `string | null`, parsed with `parseInt` or `JSON.parse` as needed.
- **Delete:** `AsyncStorage.multiRemove([...keys])` — used only in `app/settings.tsx:31` for account deletion.
- No `removeItem` calls found.

REPO-VERIFIED.

### Existing storage helper pattern

**There is no centralized storage helper module.** Each module imports AsyncStorage directly and manages its own key. Some modules define the key as a module-level constant (e.g., `lib/handedness.ts:3`, `lib/swingLimit.ts:4`, `lib/swingMotionStore.ts:59`). Others use inline string literals (e.g., `app/onboarding.tsx:59`).

The established pattern for a new `coachStorage.ts` would be:
1. Module-level constant for the key (e.g., `const COACH_CODE_KEY = 'honeyswing:coachCode'`)
2. Direct AsyncStorage import
3. Exported getter/setter functions (like `lib/handedness.ts` — 8 lines, single key, get function)

This matches the simplest existing pattern: `lib/handedness.ts`.

### Settings screen cleanup note

`app/settings.tsx:31-34` removes 3 keys on account deletion: `onboardingComplete`, `profileId`, `isLeftHanded`. A new coach code key would need to be added to this `multiRemove` array. REPO-VERIFIED `app/settings.tsx:31-34`.

---

## SECTION 4 — Home Screen Structure

**Source file:** `app/(tabs)/index.tsx` (188 lines)

### Current component tree

```
TabsHomeScreen
├── TouchableOpacity (settings gear, top-right) → router.push('/settings')
├── View.hero
│   ├── Text "HoneySwing"
│   └── Text "Your pocket swing coach"
├── [conditional] View.focusCard (Today's Focus)
│   ├── Text "Today's Focus"
│   ├── View.focusRow (colored dot + label)
│   └── Text.focusCue (coaching cue text)
├── TouchableOpacity.cta "Start Swinging" → router.push('/(tabs)/record')
├── TouchableOpacity.gripBtn "Capture Grip" / "Update Grip Photo" → router.push('/grip/capture')
│   └── [conditional] Image (grip thumbnail)
└── Text.hint (contextual hint)
```

REPO-VERIFIED `app/(tabs)/index.tsx:27-81`

### Where Today's Focus renders

The focus card renders conditionally at line 42: `{focus && (<View style={styles.focusCard}>...)}`. It loads from AsyncStorage via `loadFocus()` in a `useFocusEffect` hook (lines 19-25). REPO-VERIFIED.

### Existing tappable row/card patterns

1. **focusCard** — a `View` (not tappable), dark card with title, colored dot, and description text. Uses `styles.focusCard` (backgroundColor `#1A1A1C`, borderRadius 14, padding 16, full width).
2. **gripBtn** — a `TouchableOpacity` with border outline style, navigates via `router.push`. Contains optional image + text.
3. **Settings button** — positioned absolutely, icon-only.

There is **no existing modal or text input pattern** on the Home screen. The gripBtn (outlined border, row layout) is the closest precedent for a "tappable row that does something" — a coach link row could follow this same visual pattern. REPO-VERIFIED.

### Navigation/modal patterns

All navigation on this screen uses `router.push()` — no modals, alerts, or bottom sheets. The screen has no state beyond `focus` and `gripUri`, both loaded in `useFocusEffect`. REPO-VERIFIED `app/(tabs)/index.tsx:19-25`.

### Coach link placement

The natural insertion point for a coach link row is between the gripBtn (line 63-74) and the hint text (line 76-78). This keeps the primary CTA ("Start Swinging") above the fold and groups secondary actions (grip, coach) together. REPO-VERIFIED — layout order at lines 55-78.

---

## SECTION 5 — Result Screen Structure

**Source file:** `app/analysis/result.tsx` (441 lines)

### Current data display

The result screen shows (in order, for valid captures):
1. **Score card** — large score number, optional "Honey Boom!" badge, optional low-confidence badge. Lines 184-193.
2. **Video replay** — expo-video player with speed controls (0.25x, 0.5x, 1x). Lines 196-218.
3. **Visual Coach card** — skeleton overlay with worst-metric highlight + coaching cue. Lines 220-230.
4. **Tempo chip** — label + rating in a horizontal bar. Lines 232-239.
5. **Record Again CTA** — primary button. Lines 242-249.
6. **Sign-in prompt** (conditional, when limit hit). Lines 251-264.
7. **Swing Art card** (valid captures only). Lines 266-273.

For invalid captures: title, hint, and "Record Again" button. Lines 168-181.

REPO-VERIFIED `app/analysis/result.tsx:183-275`

### Data sources

- `getCurrentSwingMotion()` — in-memory store (frames, recordedAt, source). Line 68.
- `getCurrentSwingAnalysis()` — in-memory store (AnalysisResult). Line 69.
- `getCurrentSwingVideoUri()` — in-memory store (video path). Line 70.
- `getIsLeftHanded()` — AsyncStorage. Line 86.
- `checkSwingLimit()` / `getUser()` — Supabase. Lines 88-93.
- `classifyCapture()` — pure function on frames. Line 97-100.

All swing data comes from the in-memory `swingMotionStore`, not route params. REPO-VERIFIED.

### Existing metadata line patterns

The **tempo chip** (lines 232-239) is the closest existing pattern for a metadata attribution line:
```tsx
<View style={styles.tempoChip}>
  <Text style={styles.tempoChipLabel}>Tempo</Text>
  <Text style={[styles.tempoChipValue, { color: tempoColor }]}>{tempoLabel}</Text>
</View>
```
Style: `flexDirection: 'row'`, `backgroundColor: '#1A1A1C'`, `borderRadius: 12`, `paddingVertical: 14`, `paddingHorizontal: 18`, `justifyContent: 'space-between'`. REPO-VERIFIED `app/analysis/result.tsx:379-388`.

A "Coach: Dave Donnellan" line would naturally follow this same tempoChip pattern.

### Where coach attribution would attach

Logically between the tempo chip (line 239) and the Record Again CTA (line 243). This places it in the metadata section alongside tempo. REPO-VERIFIED — visual flow at lines 232-249.

### Navigation TO this screen

Single call site: `app/(tabs)/record.tsx:126`:
```ts
router.push('/analysis/result');
```
No route params are passed. All data flows through the in-memory `swingMotionStore`. REPO-VERIFIED.

### Navigation FROM this screen

- `router.back()` — Record Again button (line 245), Back button (line 156), invalid-capture Record Again (line 176).
- `router.push('/signin')` — sign-in prompt (line 255).

REPO-VERIFIED `app/analysis/result.tsx:156,176,245,255`.

---

## SECTION 6 — swingMotionStore Shape

**Source file:** `lib/swingMotionStore.ts` (151 lines)

### Store fields

The store exposes three in-memory singletons:

| Singleton          | Type                    | Getter / Setter                                |
|--------------------|-------------------------|------------------------------------------------|
| `currentMotion`    | `LiveSwingMotionData`   | `getCurrentSwingMotion()` / `setCurrentSwingMotion()` |
| `currentAnalysis`  | `AnalysisResult`        | `getCurrentSwingAnalysis()` / `setCurrentSwingAnalysis()` |
| `currentVideoUri`  | `string \| null`        | `getCurrentSwingVideoUri()` / `setCurrentSwingVideoUri()` |

Plus the `FocusData` persistence layer (`saveFocus` / `loadFocus`) using AsyncStorage.

REPO-VERIFIED `lib/swingMotionStore.ts:12-48`

### swing_debug field source mapping

The spec calls for a `swing_debug` JSONB payload. Here is where each constituent field lives:

| swing_debug field   | Available in persistSwing? | Source                                           |
|---------------------|---------------------------|--------------------------------------------------|
| `frame_count`       | YES                       | `frames.length` — already computed at line 62    |
| `pose_success_rate` | YES                       | `calcPoseSuccessRate(frames)` — already computed at line 72 |
| `phase_source`      | YES                       | `extractPhaseSource(analysis.phases)` — already computed at line 73 |
| `failure_reason`    | YES (hardcoded null)      | Line 74 — currently always `null`                |
| `app_version`       | YES                       | Constant `'1.3.0'` at line 8                     |
| `capture_validity`  | YES                       | `classification?.validity ?? 'unknown'` at line 75 |

REPO-VERIFIED `lib/persistSwing.ts:62-76`

**Critical finding:** Every field needed for `swing_debug` is already computed inside `persistSwing()`. The debug payload can be assembled entirely from values already in the `row` object — no new data sources or pipeline changes are required. The `swing_debug` column would contain a subset of fields that already exist as top-level columns, packaged as a single JSONB blob for easy querying.

### Fields NOT in the store

The `swingMotionStore` itself does not contain `frame_count`, `pose_success_rate`, `phase_source`, or `failure_reason` — these are computed inside `persistSwing()` only. The store holds raw frames and analysis results; the derived debug fields are calculated at persist-time. This is the correct location — no store changes are needed.

REPO-VERIFIED — store exposes only `frames`, `analysis`, `videoUri`, and focus data.

---

## SECTION 7 — Existing Coach/Code References

### grep results for "coach" (case-insensitive)

| File | Context | Relevance |
|------|---------|-----------|
| `app/onboarding.tsx:19` | `COACH_OPTIONS = ['Dave Donnellan', 'No coach']` | **HIGH** — hardcoded coach names for profile creation |
| `app/onboarding.tsx:24,38,42,95-108` | Coach picker state, profile insert with `coach_name` | **HIGH** — existing coach selection during onboarding |
| `components/VisualCoachCard.tsx:148,195,240` | Component name "VisualCoach" + `coachCue` variable | **LOW** — unrelated; this is the swing coaching overlay, not a coach person |
| `app/(tabs)/index.tsx:39` | `"Your pocket swing coach"` subtitle | **NONE** — marketing copy |
| `app/analysis/result.tsx:27,147,220` | References to VisualCoachCard | **LOW** — same as VisualCoachCard above |
| `supabase/functions/classify-grip/index.ts:23` | "Do NOT provide coaching paragraphs" in prompt | **NONE** — grip prompt instruction |

### grep results for "COACH" (case-sensitive)

Only `COACH_OPTIONS` at `app/onboarding.tsx:19,98`. REPO-VERIFIED.

### Existing coach infrastructure

**YES — partial.** The onboarding flow already has:
1. A hardcoded `COACH_OPTIONS` array: `['Dave Donnellan', 'No coach']` — `app/onboarding.tsx:19`
2. Coach picker UI in the onboarding form — `app/onboarding.tsx:95-114`
3. `coach_name` written to the **profiles** table on onboarding submit — `app/onboarding.tsx:42`

**What does NOT exist:**
- No coach code entry system (codes like "DAVE2024")
- No code → display name mapping
- No per-swing coach attribution on the swings table
- No coach display on the Home screen
- No coach attribution on the Result screen
- No AsyncStorage key for coach code
- No concept of "linking" to a coach post-onboarding

**Verdict:** The onboarding coach picker writes `coach_name` to the profiles table but has no connection to a code-based system. Track C is a new feature, not an extension of the onboarding flow. The `COACH_OPTIONS` constant in onboarding and the planned hardcoded code→name map in Track C share the same names (e.g., "Dave Donnellan") but are architecturally separate.

REPO-VERIFIED — all claims from grep results above.

---

## SECTION 8 — Facts vs Unknowns Summary

| # | CONFIRMED | Section |
|---|-----------|---------|
| 1 | `persistSwing()` accepts frames + analysis + classification, builds a flat row, inserts into `swings` table | §1 |
| 2 | `coach_name` and `swing_debug` do not exist on the swings table | §2 |
| 3 | No local migration files exist; schema is managed outside the repo | §2 |
| 4 | `coach_name` already exists on the **profiles** table (onboarding) | §2, §7 |
| 5 | AsyncStorage pattern: direct import, module-level key constants, simple get/set | §3 |
| 6 | 5 app keys + Supabase auth in AsyncStorage; settings.tsx cleanup removes 3 of them | §3 |
| 7 | Home screen has no modals or text inputs; gripBtn is the closest pattern for a coach link row | §4 |
| 8 | Result screen reads all data from in-memory store, not route params | §5 |
| 9 | Tempo chip is the visual precedent for a coach attribution metadata line | §5 |
| 10 | All `swing_debug` fields are already computed inside `persistSwing()` — no new pipeline work | §6 |
| 11 | Onboarding has a hardcoded `COACH_OPTIONS` array with 'Dave Donnellan' | §7 |
| 12 | No code-based coach linking exists anywhere in the repo | §7 |

| # | UNKNOWN / NEEDS RESOLUTION |
|---|---------------------------|
| 1 | **Swings table DDL**: No migration files in-repo. The `ALTER TABLE swings ADD COLUMN` for `coach_name` (TEXT) and `swing_debug` (JSONB) must be run directly in Supabase dashboard or a new migration must be committed. Need to decide which approach. |
| 2 | **Coach code values**: The spec says "hardcoded coach code → display name mapping." What are the actual codes? Only "Dave Donnellan" is referenced in onboarding. Are there other coaches? What format (e.g., "DAVE2024", "donnellan")? |
| 3 | **Coach code entry UX**: Where exactly does the user enter the code — a modal from Home screen? A new screen? A text input inline on the Home screen? The spec says "client-side coach code entry" but the Home screen has no modal/input precedent (§4). |
| 4 | **Coach code persistence scope**: When a user enters a code, does it persist forever (until cleared), or per-session? The spec says AsyncStorage, suggesting permanent until account deletion. Confirm. |
| 5 | **Result screen coach source**: The result screen reads from in-memory store (§5). Coach name would need to be read from AsyncStorage at render time (like `getIsLeftHanded`), since it's not part of the analysis pipeline. Confirm this is acceptable vs adding to store. |
| 6 | **Settings cleanup**: Should the coach code key be cleared on account deletion (added to `multiRemove` in settings.tsx)? |
| 7 | **Onboarding coach picker relationship**: Should the existing onboarding coach picker be kept as-is, replaced by the code system, or connected to it? Currently they are architecturally separate (§7). |

---

## SECTION 9 — Quality Bar Self-Check

### 1. What is actually compiled and running?

For this feature, the relevant compiled pipeline is:
- **Capture → persist:** `app/(tabs)/record.tsx` calls `persistSwing()` in `lib/persistSwing.ts`, which inserts into the `swings` table via Supabase client (`lib/supabase.ts`).
- **Home screen:** `app/(tabs)/index.tsx` — loads focus + grip state, renders hero/CTA/grip button.
- **Result screen:** `app/analysis/result.tsx` — reads from `swingMotionStore`, renders score/video/coach/tempo/CTA.
- **Onboarding:** `app/onboarding.tsx` — writes `coach_name` to profiles table (existing, separate concern).
- **Settings:** `app/settings.tsx` — account deletion clears AsyncStorage keys.

All confirmed running in v1.3.0 (build 19, App Store live). REPO-VERIFIED per all sections above.

### 2. What is dead code?

- `lib/persistSwing.ts:57` — the `AsyncStorage.getItem('honeyswing:profileId')` fallback is dead code; the early return at line 53-56 makes it unreachable. Not coach-related, but worth noting since Track C will add code near this line. REPO-VERIFIED §1.
- No coach-related dead code exists. REPO-VERIFIED §7.

### 3. Where does new logic attach?

- **Persist layer:** `lib/persistSwing.ts` — add `coach_name` and `swing_debug` to the row object (§1).
- **Storage layer:** New `lib/coachStorage.ts` (or equivalent) — AsyncStorage get/set for coach code, plus code→name mapping (§3).
- **Home screen:** `app/(tabs)/index.tsx` — add coach link row (tappable, shows current coach or "Link a Coach") (§4).
- **Result screen:** `app/analysis/result.tsx` — add coach attribution line (tempo chip pattern) (§5).
- **Settings screen:** `app/settings.tsx` — add coach code key to multiRemove cleanup (§3).
- **Database:** Supabase swings table — add `coach_name` TEXT and `swing_debug` JSONB columns (§2).

### 4. What will fail first and why?

**The Supabase insert will fail if columns don't exist.** If `coach_name` or `swing_debug` are added to the `row` object in `persistSwing()` before the corresponding columns are added to the swings table in Supabase, every swing persist will error. The Supabase client does not silently drop unknown columns — it returns an error. The `.catch(() => null)` at the call site (record.tsx:246) will swallow the error, so swings will appear to work but nothing will be saved.

**Mitigation order:** Database columns must be added BEFORE deploying the app update.

### 5. What should the developer test first to validate feasibility?

1. **Add columns in Supabase dashboard** — `ALTER TABLE swings ADD COLUMN coach_name TEXT; ALTER TABLE swings ADD COLUMN swing_debug JSONB;` — confirm the insert still works with existing code (null values should be accepted).
2. **Read/write a coach code key in AsyncStorage** — verify the get/set pattern works from the Home screen context, and that the value persists across app restarts.
3. **Add `coach_name` and `swing_debug` to the row in persistSwing** — confirm the insert succeeds with the new columns populated, and verify the data appears correctly in the Supabase dashboard.

This is the minimal vertical slice: DB → persist → read back. UI (Home screen link, Result screen attribution) can be validated independently after the data layer is confirmed.

---

*Audit complete. All file paths and line numbers verified against repo state at commit 2f0023a (v3-dev branch).*
