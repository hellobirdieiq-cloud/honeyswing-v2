# Track C — Coach Link + Trust Slice: Architecture Decisions

**Date:** 2026-03-28
**Branch:** v3-dev
**Input:** prompt1-audit.md (verified state)
**Status:** DECISION LOCK — all decisions fixed for Prompt 3

---

## Verified State Summary (from Prompt 1)

1. **persistSwing pipeline** (`lib/persistSwing.ts:59-77`): Inserts 17 fields into the `swings` table. `coach_name` and `swing_debug` do not exist. Insert point is the `row` object literal.
2. **No migration infrastructure**: No `supabase/migrations/` directory. Schema managed outside version control (dashboard or remote CLI).
3. **AsyncStorage pattern**: Domain-specific modules with `honeyswing:`-prefixed keys and typed getter/setters. No centralized storage helper. 5 keys in use. Account deletion clears 3 keys at `app/settings.tsx:31-35`.
4. **Home screen** (`app/(tabs)/index.tsx`): Centered `View` (not ScrollView), no modals or text inputs. Grip button (lines 63-74) is the closest tappable-row pattern.
5. **Result screen** (`app/analysis/result.tsx`): Reads from in-memory `swingMotionStore`. Tempo chip (lines 232-240) is the closest metadata-row pattern. `getIsLeftHanded()` AsyncStorage read at render time (line 86) is the established pattern for non-swing data.

---

## DECISION 1 — Migration Strategy

### Options

| Option | Description | Pros | Cons | Risk |
|--------|-------------|------|------|------|
| **A** | Create `supabase/migrations/` + ALTER TABLE file | Version-controlled, repeatable, team-visible | Sets precedent for a dir that has no deploy tooling | Low |
| **B** | Direct SQL in Supabase dashboard, no migration file | Fast, no file overhead | Not version-controlled, invisible to code review, no rollback trail | Medium |
| **C** | New table + foreign key | Clean separation | Over-engineered for 2 nullable columns, adds JOIN complexity to every query | High |

### Decision: **Option A** — Create `supabase/migrations/` with a single migration file

**Rationale:** Even without existing migration tooling, a version-controlled SQL file ensures the schema change is reviewable, documented, and repeatable. The file serves as documentation even if applied manually via dashboard.

**Rejected:**
- **B**: No audit trail. If the column is missing in a new environment, there's no way to know what's needed. Violates the principle that code and schema should be co-reviewable.
- **C**: Two nullable TEXT/JSONB columns on an existing table do not justify a new table. Adds query complexity for zero benefit.

**Migration file:** `supabase/migrations/20260328000000_add_coach_and_debug_to_swings.sql`

```sql
ALTER TABLE swings ADD COLUMN IF NOT EXISTS coach_name TEXT;
ALTER TABLE swings ADD COLUMN IF NOT EXISTS swing_debug JSONB;
```

**Failure mode:** If migration is not applied before code deploys, `persistSwing` inserts will fail silently (error logged at line 82, not thrown). App continues but swings stop persisting. Mitigation: migration must be applied BEFORE merging code changes.

---

## DECISION 2 — Coach Code Storage Architecture

### Options

| Option | Description | Pros | Cons | Risk |
|--------|-------------|------|------|------|
| **A** | Dedicated domain helper following `lib/handedness.ts` pattern | Consistent with codebase, typed, testable, encapsulated | New file | Low |
| **B** | Inline AsyncStorage calls in Home screen component | Fewer files | Breaks established pattern, not reusable from Result screen or persistSwing | Medium |
| **C** | Add to existing storage utility | N/A — Prompt 1 confirmed none exists | N/A | N/A |

### Decision: **Option A** — New `lib/coachCode.ts` following `lib/handedness.ts` pattern

**Rationale:** `lib/handedness.ts` (lines 1-8) is the exact pattern: module-level key constant, single typed getter, direct AsyncStorage import. The coach code module adds a setter and a code-to-name mapping constant.

**Rejected:**
- **B**: Home screen needs to read the code, Result screen needs to read the display name, and `persistSwing` needs to read the display name. Inline calls in one component can't serve all three consumers.
- **C**: Does not exist. Creating a centralized helper would be a pattern-breaking refactor beyond scope.

**Module shape:**
```typescript
// lib/coachCode.ts
const KEY = 'honeyswing:coachCode';

const CODE_TO_NAME: Record<string, string> = {
  'DAVE2026': 'Dave Donnellan',
  // extend as needed
};

export async function getCoachCode(): Promise<string | null> { ... }
export async function setCoachCode(code: string): Promise<void> { ... }
export async function clearCoachCode(): Promise<void> { ... }
export function resolveCoachName(code: string): string | null {
  return CODE_TO_NAME[code.toUpperCase()] ?? null;
}
```

### Account Deletion Cleanup — VERDICT

**YES**: `honeyswing:coachCode` MUST be added to the `AsyncStorage.multiRemove` array at `app/settings.tsx:31-35`. The existing array clears 3 onboarding keys. Coach code is user-specific persistent data that must not survive account deletion. This is a required change, not optional.

---

## DECISION 3 — swing_debug Payload Design

### Sub-decision A — Redundancy

| Option | Description | Pros | Cons | Risk |
|--------|-------------|------|------|------|
| **1** | JSONB duplicates all 4 top-level columns | Matches spec literally, single queryable blob | Redundant storage, risk of divergence | Low |
| **2** | Skip swing_debug entirely | No redundancy | Violates spec | Medium |
| **3** | swing_debug with only NEW fields not already top-level | No redundancy, extensible, adds value | Deviates from spec's exact field list | Low |

### Decision: **Option 3** — swing_debug contains only fields NOT already stored as top-level columns

**Rationale:** `frame_count`, `pose_success_rate`, `phase_source`, and `failure_reason` are already individual columns on the `swings` table (verified at `lib/persistSwing.ts:62-75`). Duplicating them in a JSONB blob creates a maintenance burden and divergence risk with zero query benefit. Instead, `swing_debug` carries metadata that has no top-level column:

```typescript
swing_debug: {
  app_version: APP_VERSION,           // already in row but useful in debug blob
  capture_validity: classification?.validity ?? 'unknown',
  classification_reason: classification?.reason ?? null,  // NEW — not stored anywhere today
}
```

This makes `swing_debug` genuinely additive. The four spec fields (`frame_count`, `pose_success_rate`, `phase_source`, `failure_reason`) remain queryable via their existing top-level columns.

**Rejected:**
- **1**: Pure duplication. If a top-level column value is updated (e.g., a future recalculation), the JSONB copy becomes stale.
- **2**: Loses the extensible debug blob concept entirely. We want a place for future diagnostic fields.

### Sub-decision B — failure_reason

| Option | Description | Pros | Cons | Risk |
|--------|-------------|------|------|------|
| **1** | Wire `classification.reason` into `failure_reason` | Data already available at persist-time, zero new logic | User-facing strings, not structured codes | Low |
| **2** | New `deriveFailureReason` helper with structured codes | Clean, machine-readable | Over-engineered for current needs, no consumer yet | Medium |
| **3** | Leave as null | No work | Wastes an existing column, loses available signal | Low |

### Decision: **Option 1** — Wire `classification.reason` into the existing `failure_reason` column

**Rationale:** `classification.reason` is already computed and passed to `persistSwing` (parameter `classification: CaptureClassification | null`). The `CaptureClassification.reason` field contains strings like `"Try a slower, fuller swing next time."` and `"The swing was too quick to catch."` (verified at `lib/captureValidity.ts:49-59`). The value is available — it's just not forwarded to the insert object.

**Change:** `lib/persistSwing.ts:74` changes from:
```typescript
failure_reason: null,
```
to:
```typescript
failure_reason: classification?.reason ?? null,
```

One-line change. No new helpers, no new computation.

**Rejected:**
- **2**: No consumer needs structured codes today. YAGNI.
- **3**: Wasting available diagnostic data when the fix is a single-line change.

---

## DECISION 4 — Home Screen Coach Code UX Pattern

### Options

| Option | Description | Pros | Cons | Risk |
|--------|-------------|------|------|------|
| **A** | Tappable row (grip button pattern) → modal with TextInput | Consistent with grip button, modal keeps Home clean, familiar pattern | No modal exists on Home today — new pattern | Low |
| **B** | Tappable row → navigates to new screen | Full screen for input, clear back navigation | Over-engineered for a single text input, adds a route | Medium |
| **C** | Inline TextInput directly on Home | Fewest components | Clutters Home, no existing input pattern, keyboard management issues | High |

### Decision: **Option A** — Tappable row following grip button pattern + simple modal with TextInput

**Rationale:** The grip button (`app/(tabs)/index.tsx:63-74`) is a `TouchableOpacity` with conditional content that shows current state. A coach code row follows the same pattern: shows current coach name when set, shows "Link a Coach" when unset. Tapping opens a lightweight `Modal` with a `TextInput` for code entry and a confirm button.

**Rejected:**
- **B**: A full navigation route for entering a 4-8 character code is excessive. The modal pattern keeps the interaction contained.
- **C**: Inline text inputs on a centered layout screen create keyboard management problems and break the clean card-based design.

### Layout Overflow Assessment

The Home screen uses `justifyContent: 'center'` on a flex container (`app/(tabs)/index.tsx:85-91`). Current vertical content stack:
- Hero (title + subtitle): ~80px
- Focus card (conditional): ~100px
- CTA button: ~56px
- Grip button: ~48px
- Coach row (new): ~48px
- Hint text: ~20px

Total with all elements: ~352px. iPhone SE usable height (minus status bar, tab bar): ~520px. **The coach row fits without a ScrollView conversion.** The `justifyContent: 'center'` distribution absorbs the additional row. No layout change needed.

The coach row renders between the grip button (line 74) and the hint text (line 76) — same visual zone, consistent grouping of secondary actions below the primary CTA.

---

## DECISION 5 — Result Screen Attribution Placement

### Options

| Option | Description | Pros | Cons | Risk |
|--------|-------------|------|------|------|
| **A** | Read coach name from AsyncStorage at render time | Matches `getIsLeftHanded()` pattern (line 86), no store changes | Async read, needs state + useEffect | Low |
| **B** | Add coach name to swingMotionStore | Synchronous access | Modifies store shape for non-swing data, breaks single-responsibility | Medium |
| **C** | Read from persisted swing row via Supabase query | Authoritative source | Network dependency on Result screen, latency, offline failure | High |

### Decision: **Option A** — Read coach name from AsyncStorage at render time

**Rationale:** `app/analysis/result.tsx:85-86` already does exactly this for handedness:
```typescript
useEffect(() => {
  getIsLeftHanded().then(setIsLeftHanded);
  ...
}, []);
```

Coach name follows the identical pattern: `getCoachCode()` → `resolveCoachName()` → setState. No store modification, no network call, no new patterns.

**Rejected:**
- **B**: `swingMotionStore` holds swing capture data (`LiveSwingMotionData`, `AnalysisResult`, video URI). Coach name is user-level config, not swing data. Adding it violates the store's purpose.
- **C**: Result screen works offline (reads from in-memory store). Adding a Supabase query introduces a network dependency and loading state for a single text line.

### Attribution Line Placement

The coach attribution line renders **between the tempo chip (item 4, lines 232-240) and the Record Again CTA (item 5, lines 242-249)**. It follows the tempo chip's style pattern: horizontal row with label on left and value on right inside a `#1A1A1C` card with 12px border-radius (`styles.tempoChip`, lines 379-388).

The line renders **conditionally** — only when a coach code is set and resolves to a name. When no coach is linked, nothing renders (no empty state, no placeholder).

---

## PROTECTED SURFACES

### Files That WILL Change

| File | Change | Why |
|------|--------|-----|
| `lib/persistSwing.ts` | Add `coach_name` and `swing_debug` to row object, wire `failure_reason` | Persist coach attribution and debug payload per-swing |
| `app/(tabs)/index.tsx` | Add coach code tappable row + modal | Home screen coach link UX |
| `app/analysis/result.tsx` | Add coach attribution line below tempo chip | Result screen attribution display |
| `app/settings.tsx` | Add `honeyswing:coachCode` to multiRemove array | Account deletion cleanup |
| **NEW** `lib/coachCode.ts` | Coach code storage helper + code-to-name mapping | Domain storage module following handedness.ts pattern |
| **NEW** `supabase/migrations/20260328000000_add_coach_and_debug_to_swings.sql` | ALTER TABLE migration | Add columns before code ships |

### Files That MUST NOT Change

| File | Reason |
|------|--------|
| `lib/gripStore.ts` | Holds only photoUri + acceptedAt. Not related to coach feature. |
| `ios/*` (all native files) | No native changes for this feature |
| `supabase/functions/classify-grip/*` | Grip classification edge function, unrelated |
| `lib/supabase.ts` | Auth infrastructure, no changes needed |
| `app/onboarding.tsx` | Coach picker writes to profiles table — architecturally separate (LOCKED from Prompt 1) |
| `lib/handDetection.ts` | Hand detection logic, unrelated |
| `lib/swingMotionStore.ts` | In-memory swing store — coach name is not swing data (Decision 5) |
| `packages/pose/*` | Pose detection layer, no changes |
| `packages/domain/swing/*` | Analysis pipeline, no changes |
| `components/VisualCoachCard.tsx` | Visual coaching card, unrelated to coach attribution |
| Auth flow files (`app/auth/*`, `app/signin.tsx`) | Authentication, unrelated |
| VisionCamera plugin files | Native camera processing, unrelated |

---

## Verification Plan

1. **Migration**: Apply SQL migration to Supabase. Verify existing `persistSwing` calls succeed with new nullable columns defaulting to null.
2. **Coach code storage**: Write/read round-trip test — `setCoachCode('DAVE2026')` → `getCoachCode()` returns `'DAVE2026'` → `resolveCoachName('DAVE2026')` returns `'Dave Donnellan'`.
3. **Persist layer**: Record a swing with coach code set. Verify `swings` row has `coach_name = 'Dave Donnellan'` and `swing_debug` JSONB populated. Verify `failure_reason` contains classification reason for partial/invalid captures.
4. **Home screen**: Tap coach row → modal opens → enter code → confirm → row updates to show coach name. Restart app → name persists.
5. **Result screen**: Record swing with coach linked → attribution line shows below tempo chip. Clear coach code → record swing → no attribution line renders.
6. **Account deletion**: Settings → Delete Account → verify `honeyswing:coachCode` is cleared.
7. **Regression**: Verify grip button, focus card, onboarding flow, and swing persistence all work unchanged.
