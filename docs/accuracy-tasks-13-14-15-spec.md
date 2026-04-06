# Accuracy Roadmap — Tasks 13 + 14 + 15 Batched Spec

**Date:** April 5, 2026
**Execution order:** 13 → 14 → 15
**Total estimate:** 9–11h
**Prerequisites:** Tasks 1-12 complete ✅

---

## Shared Context

### Files involved (expected — audit will verify)

| File | Task(s) | Notes |
|------|---------|-------|
| `app/record.tsx` | 13 | 691 lines. Extract camera guidance into its own component. Do NOT inline. |
| `lib/analysisPipeline.ts` | 13, 14 | detectCameraAngle() output is input for Task 13. READ ONLY for core logic. |
| Tip/intervention layer | 14, 15 | Audit will identify exact file(s). Task 14 adds insight card type. Task 15 adds variant selection. |
| `app/settings.tsx` | 15 | Age tier row. Already has handedness, subscription, coach sections. |
| `stores/swingMotionStore.ts` | 14 | Session handoff. May or may not be the right place for session accumulator. |
| `app/_layout.tsx` | 14 | AppState listener for session boundary. |
| `lib/persistSwing.ts` | 13, 14, 15 | swing_debug additive fields. |

### Architecture constraints (from V26)

- `swing_debug` is additive only. New fields: `camera_angle_at_start`, `camera_guidance_color`, `session_swing_number`, `session_insight_shown`, `age_tier`.
- Don't touch grip pipeline, auth flow, or video files.
- Don't expand gripStore.
- `(joint.confidence ?? 0)` always.
- Test files: `lib/*.test.ts`, custom harness, `npx tsx`. Not Jest.
- Don't use sed for multi-line edits.
- record.tsx is 691 lines — **extract, don't expand.**

### All features are [JS-ONLY]
No Swift changes. No Supabase schema migrations. No new RLS policies. No native build required for implementation (only for device verification). No edge function changes.

---

## Task 13 — Camera Guidance UI

**Estimate:** 3–4h
**Depends on:** Task 4 (detectCameraAngle) ✅
**Touches:** record.tsx (via new component), analysisPipeline.ts (read only)

### What it does

Real-time overlay on the record screen showing phone position quality as red/yellow/green. User adjusts to green before recording. This uses the bilateral symmetry angle detection from Task 4 — shoulderSeparationX and hipSeparationX at address frames — but runs it **live on incoming frames** rather than post-analysis.

### Design decisions

1. **When does guidance show?** Pre-recording only (while user is positioning). Disappears once recording starts. Don't distract during the swing.

2. **Signal source:** Use shoulder separation from live pose frames. Same bilateral symmetry math as Task 4's detectCameraAngle, but simplified for real-time:
   - Compute `shoulderSeparationX = |rightShoulder.x - leftShoulder.x|` on each frame
   - Normalize by frame width
   - Green: 0.15–0.35 (good face-on to 45° range)
   - Yellow: 0.08–0.15 or 0.35–0.45 (borderline DTL or too face-on)
   - Red: <0.08 (DTL, metrics unreliable) or no shoulders detected
   - **[EXTERNAL ASSUMPTION]** These thresholds are derived from Task 4's post-analysis angle detection ranges, not validated for real-time pre-recording frames. Device testing may require adjustment — expose as named constants for easy tuning.

3. **UI:** Small pill or dot indicator, not a full overlay. Position: top-center of record screen. Text label: "Great angle" / "Adjust angle" / "Move to the side". Keep it minimal — kids are using this.

4. **Smoothing:** EMA on the separation value (alpha ~0.3) to prevent flickering. Don't show red for a single bad frame.

### Implementation plan

```
1. Create app/components/CameraGuidance.tsx
   - Props: shoulderSeparation (number | null)
   - Returns pill indicator with color + short label
   - Pure presentational component

2. Create lib/cameraGuidance.ts
   - classifyCameraAngle(separation: number): 'good' | 'borderline' | 'poor'
   - Thresholds as named constants
   - Export for testing

3. Wire into record.tsx
   - During pre-recording state, compute shoulderSeparationX from latest pose frame
   - Prompt 1 §1 will identify exact attachment point
   - Pass to <CameraGuidance /> component
   - Hide component once recording starts
   - EMA smooth the separation value (new state variable)

4. Add to swing_debug
   - camera_angle_at_start: the separation value when recording began
   - camera_guidance_color: what color was showing when user pressed record

5. Tests (lib/cameraGuidance.test.ts)
   - classifyCameraAngle returns correct bucket for each range
   - Edge cases: 0, 0.08, 0.15, 0.35, 0.45, 1.0
   - null/undefined handling
```

### Validation

- On device: position phone face-on → green. Rotate toward DTL → transitions through yellow to red.
- Verify no flicker (EMA smoothing working).
- Verify guidance disappears during recording.
- Verify record.tsx did NOT grow significantly (component extracted).

---

## Task 14 — Historical Swing Averaging

**Estimate:** 3–4h
**Depends on:** Task 7 (tip frequency limiter) ✅
**Touches:** tip engine, swingMotionStore (or new session store), result screen

### What it does

After N swings in a session, show session-level insights: "Across 20 swings, your tempo is consistently good" or "Your balance has improved over the last 10 swings." This is an **in-memory session accumulator** — not persisted to Supabase.

### Design decisions

1. **Threshold:** Show session insights starting at swing 10 (not 20 — kids at clinics hit 100+, earlier feedback is better). Configurable constant: `SESSION_INSIGHT_MIN_SWINGS = 10`.

2. **Which metrics to accumulate:** All metrics that the tip engine currently tracks and can flag — the same set Task 7's frequency limiter knows about. Audit will confirm the exact list, but expected: tempo, balance, arm extension, shoulder tilt, hip rotation, knee flex, elbow angle, posture, grip (if applicable). Each metric gets a running stats object.

3. **What to accumulate per metric:**
   - Mean value (running)
   - Standard deviation (running)
   - Trend direction over last 5 swings: compute linear slope of the metric's values over the most recent 5 data points. **Improving** = slope moves toward ideal by ≥3% of the metric's range per swing. **Declining** = slope moves away from ideal by ≥3%. **Stable** = everything else. For metrics where lower is better (e.g., elbow angle deviation), "toward ideal" means decreasing. For metrics where higher is better (e.g., arm extension), it means increasing. The metric's ideal direction is part of the metric definition, not computed.
   - Count of swings where metric was flagged (tip fired for it)
   - Flag rate: flagCount / totalSwings

4. **Insight types and priority order** (highest priority first):
   - **Focus suggestion** (priority 1): fires when a single metric's flag rate ≥ 40% AND flagCount ≥ 4. "Shoulder tilt came up 6 times — worth focusing on." This is highest priority because it surfaces a pattern the player should address.
   - **Improvement notice** (priority 2): fires when a previously-flagged metric (flagCount ≥ 2 earlier in session) has trend = improving over last 5. "Your balance is getting better!" Positive reinforcement for effort.
   - **Consistency praise** (priority 3): fires when the metric with the most data points has coefficient of variation (std/mean) < 0.15 AND has never been flagged. "Your tempo has been solid across N swings." Only shows when nothing else qualifies — the "all good" state.
   - If multiple insights qualify at the same priority level, pick the one with the highest flag count (focus), strongest slope (improvement), or lowest CV (consistency).

5. **When to show insight vs tip:** A correction tip is "high-priority" if the confidence score for that swing is ≥ 75 AND the metric deviation exceeds its threshold. If a high-priority correction fires, show the tip. If no high-priority correction fires AND a session insight qualifies, show the insight. If neither qualifies, show the normal tip (or positive reinforcement per Task 8). Maximum 1 session insight per swing result.

6. **Session boundary:** Session resets when app goes to background for >5 minutes OR app is killed. Use AppState listener. Don't persist to AsyncStorage.

### Implementation plan

```
1. Create lib/sessionAccumulator.ts
   - SessionAccumulator class or module-scoped state
   - addSwing(analysisResult): void — extracts metric values, updates running stats
   - getInsight(): SessionInsight | null — returns highest-priority insight if threshold met
   - reset(): void
   - Types: SessionMetricStats, SessionInsight

2. Create lib/sessionInsights.ts  
   - generateConsistencyInsight(metric, stats): string | null
   - generateImprovementInsight(metric, stats): string | null
   - generateFocusInsight(metric, stats): string | null
   - Pure functions, testable
   - Language: friendly, age-neutral (Task 15 will layer age-specific variants)

3. Wire into the swing flow
   - Prompt 1 §2 will identify exact attachment point
   - After analysis: sessionAccumulator.addSwing(result)
   - **Confidence gate:** addSwing increments session_swing_number always, but only adds metric values to running stats if the swing's confidence score ≥ 50. Low-confidence swings count toward the session but don't pollute trend/consistency/flag calculations. This prevents phase detection noise from corrupting session insights.
   - Before tip display: check sessionAccumulator.getInsight()
   - If insight available AND no high-priority correction → show insight card
   - Otherwise show normal tip

4. Wire AppState listener
   - Prompt 1 §3 will identify existing AppState handling
   - On background >5min or app kill: sessionAccumulator.reset()

5. Add to swing_debug
   - session_swing_number: which swing this was in the session (1, 2, 3...)
   - session_insight_shown: string | null (which insight, if any)

6. Tests (lib/sessionAccumulator.test.ts, lib/sessionInsights.test.ts)
   - Accumulator correctly tracks N swings
   - No insight below threshold
   - Consistency insight fires on low-variance metric
   - Improvement insight fires on trending metric
   - Reset clears state
   - Insight text generation
   - **Confidence gate: swing with score <50 increments count but does NOT affect metric stats**
```

### Validation

- On device: take 10+ swings. After swing 10, session insight card should appear.
- Verify insight content matches actual session data.
- Verify session resets after backgrounding >5min.
- Verify normal tips still show when no insight qualifies.

---

## Task 15 — Age-Aware Tip Language

**Estimate:** 2–3h
**Depends on:** Task 7 (tip engine) ✅
**Touches:** tip engine, onboarding/settings, tip content

### What it does

Tips for ages 6-8 use simpler, more encouraging language than tips for 12+. Requires collecting age (or age tier) during onboarding.

### Design decisions

1. **Age tiers (not exact age):**
   - `junior`: 6-8 (simpler language, more encouragement, shorter sentences)
   - `youth`: 9-12 (current language — this is the default)
   - `teen`: 13+ (can handle slightly more technical terms)
   
   Three tiers, not a continuous scale. Start with `junior` vs `default` (youth+teen) — only differentiate teen later if needed.

2. **Collection point:** 
   - **Option A:** Onboarding screen (first launch). Adds friction.
   - **Option B:** Settings only. No friction but most users never set it.
   - **Recommendation: Option A** with a single-tap age range picker. Kids' apps do this. One screen: "Who's swinging?" with 3 illustrated buttons. Skippable → defaults to `youth`.

3. **Storage:** AsyncStorage key `honeyswing:ageTier`. Values: `'junior'` | `'youth'` | `'teen'`. Default: `'youth'`.

4. **Tip content structure:** Each tip gets a `variants` map:
   ```typescript
   {
     default: "Keep your lead elbow straighter through impact",
     junior: "Try keeping your front arm straight"
   }
   ```
   Only `junior` needs explicit variants. `youth` and `teen` use `default`. This minimizes content work.

   **Reference examples** (Claude Code should use these as the style anchor for all junior variants):

   | Default (youth/teen) | Junior (6-8) |
   |---------------------|--------------|
   | "Keep your lead elbow straighter through impact" | "Try keeping your front arm straight" |
   | "Your shoulders are tilting too much at the top" | "Keep your shoulders more level" |
   | "Try to maintain better balance through your swing" | "Stay balanced like a statue" |
   | "Rotate your hips more to generate power" | "Turn your belly toward the target" |
   | "Your tempo is too fast — slow down the backswing" | "Nice and slow going back" |
   | "Extend your arms more through the hitting zone" | "Reach out when you hit the ball" |

   **Pattern:** Junior text ≤10 words, body-part words a 6-year-old knows (arm, belly, shoulders — not "lead elbow", "hip rotation"), positive/instructional framing ("try", "keep", "reach" — not "don't", "stop", "too much").

5. **Which tips get junior variants?** All correction tips. Positive reinforcement (Task 14's session insights) are already simple enough. Prioritize the most common tips first — Prompt 1 §2 will count these.

6. **Dave input needed:** Cross-reference his coaching language for 8-12 year olds. Flag this as a follow-up — ship with best-guess junior variants, refine with Dave's feedback.

### Implementation plan

```
1. Create lib/ageTier.ts
   - AgeTier = 'junior' | 'youth' | 'teen'
   - getAgeTier(): Promise<AgeTier> (reads AsyncStorage, defaults 'youth')
   - setAgeTier(tier: AgeTier): Promise<void>
   - STORAGE_KEY = 'honeyswing:ageTier'

2. Create age tier picker screen
   - Prompt 1 §4 determines whether onboarding exists
   - Three buttons: "Little Kid (6-8)" / "Kid (9-12)" / "Teen (13+)"
   - Skippable (X button → defaults to youth)
   - Shows once on first launch (check AsyncStorage flag)

3. Add age tier to Settings
   - New row in Settings: "Player Age" showing current tier
   - Tap → same picker UI or simple selector
   - Between Handedness and Coach sections

4. Modify tip content
   - Prompt 1 §2 identifies this
   - Add `junior` variant to each correction tip
   - Guidelines for junior text:
     * Max 10 words
     * No technical terms (no "lead elbow", say "front arm")  
     * Positive framing ("try to" not "don't")
     * Concrete imagery ("like you're reaching for something")
   - Leave positive reinforcement cards unchanged

5. Modify tip selection
   - Prompt 1 §2 identifies this
   - Read ageTier
   - If junior AND junior variant exists → use junior text
   - Otherwise → use default text

6. Add to swing_debug
   - age_tier: string (which tier was active for this swing)

7. Tests (lib/ageTier.test.ts)
   - getAgeTier returns 'youth' when unset
   - setAgeTier persists correctly
   - Tip variant selection logic
```

### Validation

- Set age to junior → tips use simpler language.
- Set age to youth → tips use current language (no regression).
- Skip onboarding → defaults to youth.
- Settings shows and allows changing age tier.
- Verify junior tip text is ≤10 words, no jargon, positive framing.

---

## Claude Code Prompts (House Standard V10 Compliant)

Run in one Claude Code Plan Mode session: Prompt 1 → review → Prompt 2 → review → Prompt 3 → review. Then three implementation sessions (one per task). Score every output using Section 13 rubric before proceeding.

**Starter prompt** (paste before Prompt 1 — from V26 Appendix D):
> You are continuing HoneySwing development. v1.8 (build 29) submitted. v1.7 LIVE.
> App repo: ~/Desktop/HoneySwing/honeyswing-v2. Branch: v3-dev.
> Do NOT modify: lib/gripStore.ts, lib/referralAttribution.ts, lib/purchases.ts, grip/, auth flow, video files.
> Do NOT expand gripStore. swing_debug is additive only. (joint.confidence ?? 0) always.
> record.tsx is 691 lines — extract new components, do NOT inline more logic.
> Tests: lib/*.test.ts, custom harness, npx tsx. Not Jest.

---

### PROMPT 1 — Shared Repo Audit

```
PLANNING ONLY. Do NOT write code. Do NOT modify files.

I'm building three features that share overlapping files. I need a single exhaustive
audit before making architecture decisions. Write output incrementally to
docs/accuracy-tasks-13-14-15/audit.md — one section at a time, appended after each
section completes.

FEATURES:
- Task 13: Camera guidance UI — real-time red/yellow/green overlay on record screen
  showing phone position quality, using shoulder separation from live pose frames.
- Task 14: Historical swing averaging — in-memory session accumulator that shows
  session-level insights after 10+ swings ("Your tempo is consistent").
- Task 15: Age-aware tip language — age tier picker (junior/youth/teen), simpler tip
  text for ages 6-8.

READ THESE FILES FULLY before answering:
- app/record.tsx
- lib/analysisPipeline.ts (specifically: detectCameraAngle, analyzePoseSequence,
  computePhaseWindowedAngles, and any visibility/confidence scoring)
- stores/swingMotionStore.ts
- app/settings.tsx
- app/_layout.tsx (AppState listeners, session lifecycle)
- lib/swingLimit.ts (how swing count is tracked — relevant to session counting)
- lib/persistSwing.ts (swing_debug field structure)

ALSO SEARCH FOR:
- grep -r "tip\|intervention\|coaching.*card\|feedback.*card" lib/ app/ --include="*.ts" --include="*.tsx" -l
  → Find the tip/intervention/coaching card content and selection logic
- grep -r "onboarding\|first.*launch\|welcome" app/ --include="*.tsx" -l
  → Find whether an onboarding flow exists
- grep -r "shoulderSeparation\|shoulder.*separation\|bilateral" lib/ --include="*.ts" -l
  → Find how detectCameraAngle accesses shoulder data
- grep -r "AppState\|appState\|background\|foreground" app/ lib/ --include="*.ts" --include="*.tsx" -l
  → Find existing AppState handling
- grep -r "AsyncStorage" lib/ app/ --include="*.ts" --include="*.tsx" -l
  → Catalog all AsyncStorage keys in use

This audit must be exhaustive. Read every file you reference fully. Execute all search
queries listed. Do not stop after initial findings. Do not shortcut based on assumptions.

ANSWER THESE QUESTIONS (one section each, evidence labels on every claim):

Evidence labels: REPO-VERIFIED = confirmed with file:line. EXTERNAL ASSUMPTION = from
docs, not code. DEVICE-TEST REQUIRED = only for things the repo literally cannot answer.

SECTION 1 — Record screen state machine
How does record.tsx manage pre-recording vs recording vs post-recording states? Where
in the component are live pose frames accessible? What is the pose frame type? Is there
already a live overlay during pre-recording (e.g., skeleton)? What renders on the result
screen after a swing? End with verdict: where does the camera guidance component attach?

SECTION 2 — Tip/coaching card system
What file(s) contain tip content? How are tips selected (random, rule-based, confidence-
gated)? What is the data structure of a tip/card? How many distinct tip texts exist?
Where does tip selection happen relative to analysis? Is there already a frequency limiter
(Task 7)? End with verdict: where does session insight (Task 14) attach? Where does age
variant selection (Task 15) attach?

SECTION 3 — Session lifecycle
Does _layout.tsx or any other file track AppState (foreground/background)? Is there any
concept of a "session" (multiple swings in one sitting)? How does swingMotionStore handle
consecutive swings — does it accumulate or reset? End with verdict: where does the session
accumulator attach? What event signals session reset?

SECTION 4 — Settings screen structure  
What sections/rows exist in settings.tsx? In what order? What's the current AsyncStorage
key catalog? Is there an onboarding flow? End with verdict: where does age tier row go?
Does onboarding exist to add a screen to, or must we create one?

SECTION 5 — swing_debug current fields
What fields are currently in swing_debug JSONB? What's the exact structure passed to
persistSwing? End with verdict: list exact new fields for Tasks 13-15.

SECTION 6 — Quality bar self-check
Before finalizing, verify your output answers:
1. What is actually compiled and running? (for each file audited)
2. What is dead code? (any tip/card systems that are unused?)
3. Where does new logic attach? (layers, not just filenames)
4. What will fail first when building these three features?
5. What should the developer test first?

Do NOT repeat conclusions across sections — state once, reference by section number.
Re-read the key files and verify every line number you cited. Remove any claim with an
unverifiable citation.
```

**Between prompts:** Read audit.md. Sanity check: does the tip system match what V26 describes? Does record.tsx structure match the 691-line claim? If wrong, diagnose before continuing.

---

### PROMPT 2 — Architecture Decisions (Batched)

```
PLANNING ONLY. Do NOT write code. Do NOT modify files.

BEFORE WRITING ANYTHING: Extract the verified state summary from the Prompt 1 audit
(docs/accuracy-tasks-13-14-15/audit.md). Restate it as 5 bullet points. Use ONLY this
as ground truth. If any plan you produce contradicts the verified state, it is INVALID.

Append output to docs/accuracy-tasks-13-14-15/architecture.md — one section at a time.

Read docs/accuracy-tasks-13-14-15-spec.md for feature requirements.

For each task, produce:

TASK 13 — Camera Guidance UI

Decision table: Where to compute shoulder separation for live guidance.
| Option | Pros | Cons | Risk | What breaks if wrong |
List 3-4 options (e.g., reuse detectCameraAngle vs lightweight inline calc vs
shared utility). Pick ONE. Reject others with reasons.

Decision table: UI component placement and rendering approach.
| Option | Pros | Cons | Risk | What breaks if wrong |
(e.g., absolute overlay vs inline in record layout vs separate pre-recording screen)

Protected surfaces:
- Files that WILL change and why
- Files that MUST NOT change (include: lib/analysisPipeline.ts core logic,
  grip pipeline, auth, video capture, persistSwing.ts upload logic)

TASK 14 — Historical Swing Averaging

Decision table: Where to store session state.
| Option | Pros | Cons | Risk | What breaks if wrong |
(e.g., expand swingMotionStore vs new module-scoped state vs new Zustand store vs
React context)

Decision table: How to display session insights.
| Option | Pros | Cons | Risk | What breaks if wrong |
(e.g., replace tip card vs separate card type vs inline text on result screen)

Protected surfaces (same format).

TASK 15 — Age-Aware Tip Language

Decision table: Where/how to collect age tier.
| Option | Pros | Cons | Risk | What breaks if wrong |
(e.g., onboarding screen vs settings-only vs first-swing prompt)

Decision table: How to structure tip variants.
| Option | Pros | Cons | Risk | What breaks if wrong |
(e.g., variant map per tip vs separate content file per tier vs template string
with substitution)

Protected surfaces (same format).

ACROSS ALL TASKS:
- Label every recommendation: MUST SHIP, BONUS, or FUTURE ONLY.
- Persistence/schema changes are FUTURE ONLY by default unless the feature cannot
  function without them.
- Do NOT introduce new abstractions, libraries, or refactors not required by the spec.
  If something additional seems needed, label it BONUS or FUTURE ONLY.
```

**Between prompts:** Read architecture.md. Check: did Claude pick reasonable options? Did it invent abstractions? Did it respect protected surfaces?

---

### PROMPT 3 — Risks, Gates, Release Plan

```
PLANNING ONLY. Do NOT write code. Do NOT modify files.

Read the audit (docs/accuracy-tasks-13-14-15/audit.md) and architecture decisions
(docs/accuracy-tasks-13-14-15/architecture.md). Append output to
docs/accuracy-tasks-13-14-15/release-plan.md.

SECTION 1 — Blocking risk (one per task)
For each task, identify ONE risk that fails FIRST. Not the biggest — the earliest.
Classify: CODE, CONFIG, or PLATFORM. Justify why it ranks above alternatives.
Pair with a concrete first test.

SECTION 2 — Numbered build order
List every step, numbered, tagged with: [JS-ONLY], [DEVICE-TEST], or [ASYNC-STORAGE].
All [JS-ONLY] steps first. npx tsc --noEmit must pass before any [DEVICE-TEST] step.

Group by task but show the full interleaved order:
Task 13 steps → device verify Task 13 → Task 14 steps → device verify Task 14 →
Task 15 steps → device verify Task 15 → final regression.

SECTION 3 — Ship gates
Gate 1 (after Task 13): Camera guidance works. Shippable alone as accuracy improvement.
Gate 2 (after Task 14): Session insights work. Shippable with Gate 1.
Gate 3 (after Task 15): Age-aware tips. Full batch shippable.
For each gate: what's working, what's NOT yet working, is it safe to deploy?

SECTION 4 — Test gates with pass/fail criteria
Per task: what specific test passes or fails. What to do on failure (not just "debug").
Include regression check: after Task 15, re-verify Tasks 13 and 14 still work.

SECTION 5 — MUST SHIP vs BONUS vs FUTURE ONLY
Separate clearly. Every item from the spec categorized.

SECTION 6 — Time estimates with assumptions
Per task. State what's assumed (e.g., "assumes onboarding flow exists" or "assumes
tip content is in a single file").

SECTION 7 — What NOT to waste time on
Explicit list of rabbit holes to avoid.

SECTION 8 — Release compliance
- swing_debug new fields (additive only — no schema migration needed): ✅ or ❌
- New AsyncStorage key (honeyswing:ageTier): any privacy implications?
- App Privacy update needed? (age data collection)
- Export compliance: no change expected
- Does this bundle into v1.9 with bypass path fix?

SECTION 9 — Contradiction pass
Audit your own output:
- [ ] Plan targets correct compiled code (not dead code)
- [ ] No section assumes something Prompt 1 disproved
- [ ] Every task has a rollback point
- [ ] No silent contract changes between tasks
- [ ] Protected surfaces from Prompt 2 respected in build order

SECTION 10 — Action gate
What does the developer do FIRST when implementation begins? One concrete step.

SECTION 11 — Open questions
Any [DEVICE-TEST REQUIRED] or [UNCERTAIN] items. Save to
docs/accuracy-tasks-13-14-15/open-questions.md.
```

**After Prompt 3:** Score all three outputs using the V10 §13 rubric. Fix anything below 800 before proceeding to implementation.

---

### IMPLEMENTATION PROMPT 4 — Task 13 (Camera Guidance UI)

Run in a fresh Claude Code session (not Plan Mode).

```
Starter prompt: [paste V26 Appendix D starter prompt]

Read these files before starting:
- docs/accuracy-tasks-13-14-15/audit.md (Sections 1, 5)
- docs/accuracy-tasks-13-14-15/architecture.md (Task 13 decisions)
- docs/accuracy-tasks-13-14-15/release-plan.md (Task 13 build order)
- docs/accuracy-tasks-13-14-15-spec.md (Task 13 section)

HARD CONSTRAINTS (line 1 for a reason):
- Do NOT modify lib/analysisPipeline.ts core analysis logic
- Do NOT add logic inline to record.tsx — extract into new component(s)
- Do NOT touch grip pipeline, auth, video, persistSwing upload logic
- (joint.confidence ?? 0) always

Execute the Task 13 build order from release-plan.md. For each step:
1. Write the code
2. Verify with npx tsc --noEmit
3. Run tests with npx tsx

When complete:
- Report record.tsx line count (must not have grown significantly)
- Report test results
- List all files created/modified
- List swing_debug fields added
```

---

### IMPLEMENTATION PROMPT 5 — Task 14 (Historical Swing Averaging)

Fresh Claude Code session.

```
Starter prompt: [paste V26 Appendix D starter prompt]

Read these files before starting:
- docs/accuracy-tasks-13-14-15/audit.md (Sections 2, 3, 5)
- docs/accuracy-tasks-13-14-15/architecture.md (Task 14 decisions)
- docs/accuracy-tasks-13-14-15/release-plan.md (Task 14 build order)
- docs/accuracy-tasks-13-14-15-spec.md (Task 14 section)
- docs/accuracy-tasks-13-14-15/open-questions.md (if exists)

HARD CONSTRAINTS:
- Do NOT expand swingMotionStore beyond what architecture.md decided
- Do NOT persist session data to AsyncStorage or Supabase — in-memory only
- Do NOT touch grip pipeline, auth, video, persistSwing upload logic
- (joint.confidence ?? 0) always

Execute the Task 14 build order. For each step: write, tsc, test.

REGRESSION CHECK: After completion, verify Task 13 camera guidance still compiles
and tests pass.

When complete: report test results, files created/modified, swing_debug fields added.
```

---

### IMPLEMENTATION PROMPT 6 — Task 15 (Age-Aware Tip Language)

Fresh Claude Code session.

```
Starter prompt: [paste V26 Appendix D starter prompt]

Read these files before starting:
- docs/accuracy-tasks-13-14-15/audit.md (Sections 2, 4, 5)
- docs/accuracy-tasks-13-14-15/architecture.md (Task 15 decisions)
- docs/accuracy-tasks-13-14-15/release-plan.md (Task 15 build order)
- docs/accuracy-tasks-13-14-15-spec.md (Task 15 section)
- docs/accuracy-tasks-13-14-15/open-questions.md (if exists)

HARD CONSTRAINTS:
- Do NOT touch grip pipeline, auth, video, persistSwing upload logic
- Do NOT add new screens to the tab navigator — age picker is modal or inline
- (joint.confidence ?? 0) always
- Junior tip text: max 10 words, no technical terms, positive framing

Execute the Task 15 build order. For each step: write, tsc, test.

REGRESSION CHECK: After completion, verify Tasks 13 AND 14 still compile and
tests pass. Run full test suite: npx tsx lib/cameraGuidance.test.ts,
npx tsx lib/sessionAccumulator.test.ts, npx tsx lib/sessionInsights.test.ts,
npx tsx lib/ageTier.test.ts.

When complete: report test results, files created/modified, swing_debug fields added,
count of tip texts with junior variants, AsyncStorage keys added.
```

---

## Post-Implementation Checklist

- [ ] All tests pass (full suite from Prompt 6 regression check)
- [ ] record.tsx line count did NOT grow (Task 13 extracted to component)
- [ ] swing_debug fields added: camera_angle_at_start, camera_guidance_color, session_swing_number, session_insight_shown, age_tier
- [ ] AsyncStorage keys added: honeyswing:ageTier (update V27 Appendix A)
- [ ] No protected files modified (grep git diff for gripStore, purchases, referralAttribution, grip/)
- [ ] Pre-swing checklist passes (Settings → email → 1 swing → Metro logs)
- [ ] Device verify: camera guidance shows green/yellow/red correctly
- [ ] Device verify: 10+ swings → session insight card appears
- [ ] Device verify: junior age → simpler tips, youth → current tips
- [ ] App Privacy: age tier is "Health & Fitness" category — verify no new category needed
- [ ] Update Master Context V27: §10.14 accuracy table Tasks 13-15 ✅, new AsyncStorage key, new swing_debug fields
- [ ] Bundle into v1.9 with bypass path fix
- [ ] Score each implementation output with V10 §13 rubric before merging
