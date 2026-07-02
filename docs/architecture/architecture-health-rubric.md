# HoneySwing Architecture-Health Rubric (1000 points)

**Scoring model: deduction-based.** Each axis starts at its maximum and loses
points only through explicit deductions. Every deduction in Phase 2 must cite
the measured evidence (command output) that justifies it — no deduction
without evidence, no qualitative banding. Deduction sizes are judgment calls,
labeled **EXTERNAL ASSUMPTION** throughout.

**Definition used throughout:** architecture quality = *how easy this codebase
is to safely evolve over time* — how cheaply a correct change can be made, how
loudly an incorrect change fails — not how clean the code looks today.

Global scoring rules:
- Each axis scores max(0, ceiling − Σ deductions). Health score = Σ axes (max 1000).
- If a measurement command cannot run (missing tooling, no network, no CLI
  auth), deduct **50% of the points that command guards** — unmeasurable is
  itself an evolvability defect. Each axis states what each command guards.
  **EXTERNAL ASSUMPTION.**
- A single finding deducts once, on the axis where it is most structural (no
  double-counting across axes).

Weights are deliberately unequal. They rank axes by *blast radius of silent
failure during evolution*: the test gate, the persisted data contract, and the
layer boundaries score highest (a quiet failure there invalidates everything
downstream); tooling-hygiene axes score lowest (their failures are loud).

| # | Axis | Weight / Max |
|---|---|--:|
| 1 | Layer & boundary integrity | 140 |
| 2 | Domain determinism & runtime purity | 70 |
| 3 | Capture-pipeline cohesion & rate-independence | 130 |
| 4 | Calibration single-sourcing | 90 |
| 5 | Data-contract integrity & evolution | 140 |
| 6 | Test health & gate integrity | 150 |
| 7 | Static-gate coverage | 90 |
| 8 | Dependency coupling & cycles | 90 |
| 9 | RN/Expo platform & native-bridge health | 60 |
| 10 | Dead code & change-amplification hotspots | 40 |
| | **Total** | **1000** |

---

## Axis 1 — Layer & boundary integrity

**Weight / maximum score.** 140.

**What it measures.** Whether the documented layering (`app → lib →
packages/domain` / `packages/pose` → native) holds at the import level, in
both directions, and whether `packages/` is relocatable.

**Why it matters in HoneySwing.** The repo's evolvability strategy rests on
one property: `packages/domain/swing` is pure TypeScript over `PoseFrame[]`,
runnable under `tsx` with no RN runtime — that is what makes biomechanics
changes cheap to test off-device and replayable against recorded swings.
Every upward import erodes it.

**ATTACK FIRST — what could be broken.**
- A domain module importing app/lib state at runtime couples biomechanics to
  UI lifecycle; the failure is silent until a glue refactor changes scoring.
- UI importing pipeline *internals* freezes the pipeline's internal shape —
  contributors stop refactoring, the evolvability death spiral.
- Imports escaping `packages/` make the package non-relocatable.
- Mixed import styles mean single-style grep audits under-report violations.

**Measurement commands.**

```bash
# (a) packages → lib/app/components imports, any style; classify runtime vs `import type`:
grep -rn -E "from ['\"](@/(lib|app|components)|\.\./\.\./\.\./(lib|app|components))" packages --include='*.ts' --include='*.tsx'
# (b) app/components → packages/domain direct imports; extract imported symbols:
grep -rn -E "from ['\"]@/packages/domain" app components --include='*.ts' --include='*.tsx'
# (c) relocatability: imports crossing the packages/ root:
grep -rn -E "from ['\"]\.\./\.\./\.\." packages --include='*.ts' --include='*.tsx'
# (d) platform imports inside the package layer:
grep -rn -E "from ['\"](react|react-native|expo|@expo|@react)" packages --include='*.ts' --include='*.tsx'
```

**Deduction schedule (each item EXTERNAL ASSUMPTION).**
- Runtime (non-type) upward import from packages/ on the analysis path: **−60 each**.
- Runtime upward import elsewhere in packages/: **−30 each**.
- Type-only upward import not enumerated in a written allowlist: **−10 each**.
- Platform (react/RN/expo) import inside packages/: **−40 each**.
- app/components file importing domain *internal* symbols (anything other
  than pipeline entry points, exported result/display types, or display
  helpers): **−3 per file, cap −30**.
- Import escaping packages/ root not on an allowlist: **−5 each, cap −20**.

**How deductions are justified.** Each deduction cites the grep hit
(file:line) and, for the runtime-vs-type distinction, the import statement
itself. "Analysis path" means reachable from `analyzePoseSequence`.

---

## Axis 2 — Domain determinism & runtime purity

**Weight / maximum score.** 70.

**What it measures.** Purity beyond imports: ambient reads (`Date.now()`,
`Math.random()`, `new Date()`, `globalThis`, `console`) inside
`packages/domain`, and whether identical `PoseFrame[]` input provably yields
identical output.

**Why it matters in HoneySwing.** The repo's validation style is replay:
production analysis re-run over recorded ground-truth swings, refactors proven
behavior-neutral by byte-identical comparison. That proof technique — the
cheapest safe-evolution tool this codebase has — collapses if any analyze-path
function reads the clock or randomness. Nondeterminism doesn't crash; it
quietly invalidates every regression baseline.

**ATTACK FIRST — what could be broken.**
- A clock read feeding a phase/tempo/score value makes identical swings score
  differently across runs; corpus baselines rot with no test failure.
- Randomness in a tie-break defeats byte-identical refactor proofs.
- Console output in pipeline stages buries real failures under a runner that
  inspects only exit codes.

**Measurement commands.**

```bash
# (a) enumerate ambient reads in non-test domain code:
grep -rn -E "(Date\.now\(\)|Math\.random\(\)|new Date\(|globalThis\.|console\.)" packages/domain --include='*.ts' | grep -v '\.test\.ts'
# (b) classify each hit: analyze-path (reachable from analyzePoseSequence) vs debug-only.
# (c) determinism spot-proof — run a domain suite twice, diff full output:
npm test -- scoring > /tmp/det_a.txt 2>&1; npm test -- scoring > /tmp/det_b.txt 2>&1; diff /tmp/det_a.txt /tmp/det_b.txt
```

**Deduction schedule (each item EXTERNAL ASSUMPTION).**
- Clock/randomness read demonstrably feeding a scored, phase, or persisted
  analysis value: **−35 each**.
- Ambient time read on the analyze path that is output-neutral (debug/telemetry
  fields only): **−5 each, cap −15**.
- `console.*` in non-test domain code: **−2 each, cap −10**.
- Determinism diff (c) non-empty: **−70** (axis floors at 0).
- Hit that cannot be classified analyze-path vs debug: **−3 each**.

**How deductions are justified.** Each cites the grep hit and the reachability
trace (what calls it, up to `analyzePoseSequence` or not). The determinism
deduction cites the diff output.

---

## Axis 3 — Capture-pipeline cohesion & rate-independence

**Weight / maximum score.** 130.

**What it measures.** Whether the capture chain (record screen → capture hook
→ processing → pose extraction → analysis) has a single source of truth for
frame-rate/decimation/duration constants, and whether time-based logic is in
milliseconds (rate-independent) rather than raw frame counts.

**Why it matters in HoneySwing.** Capture parameters (fps, decimation, clip
length) are the most frequently tuned knobs in this product. If any search
window or validity gate is a raw frame count sized for one fps, every future
rate change silently halves or doubles a time window — no type error, no test
failure, just wrong phases on-device. Rate-independence is what makes
capture-parameter evolution safe.

**ATTACK FIRST — what could be broken.**
- A frame-count constant sized for one fps covering half/double the intended
  wall-clock time after a rate change.
- The decimation factor defined or copied in more than one place.
- Cross-file couplings (timeout sized for a decimation; validity threshold
  sized for a clip length) stated nowhere in code.
- Orchestration invariants (ref identity, persist/retry mutual exclusion)
  enforced by nothing mechanical.

**Measurement commands.**

```bash
# (a) decimation single-source check:
grep -rn "ANALYZER_DECIMATION" app lib packages scripts --include='*.ts' --include='*.tsx' --include='*.mjs'
# (b) frame-count literals in the capture chain; each hit must be justified ms-derived or rate-neutral:
grep -rn -E "\b(180|240|120|60|90|45|50)\b" lib/cameraFormat.ts lib/captureProcessing.ts lib/useSwingCapture.ts lib/usePoseFrameHandler.ts lib/extractPoseFromVideo.ts | grep -v -iE "ms|percent"
# (c) ms-threshold inventory:
grep -rn -E "_MS\b|Ms\b *[:=]" packages/domain/swing/captureValidity.ts packages/domain/swing/confidenceScore.ts packages/domain/swing/phaseDetectionShared.ts lib/cameraFormat.ts
# (d) window constants consumed via ms→frame conversion:
grep -rn "msToFrames\|msPerFrame" packages/domain/swing --include='*.ts' | grep -v test
```

**Deduction schedule (each item EXTERNAL ASSUMPTION).**
- Rate/decimation constant duplicated (a second definition or literal copy of
  its value): **−40 each**.
- Phase/impact search window or validity gate consumed as a raw frame count
  with no ms derivation: **−30 each**.
- Unjustified frame-count literal elsewhere in the capture chain: **−10 each,
  cap −40**.
- Cross-file coupling (timeout↔decimation, validity↔clip-length) undocumented
  at both ends in code: **−10 each, cap −20**.

**How deductions are justified.** Each cites the file:line of the literal and
the reason the justification fails (no ms sibling, no conversion at use-site,
no coupling comment).

---

## Axis 4 — Calibration single-sourcing

**Weight / maximum score.** 90.

**What it measures.** Whether every tunable phase-detection constant lives in
the shared `EXTERNAL_ASSUMPTIONS` table (`phaseDetectionShared.ts`) and is
consumed *by reference* everywhere — detectors, debug/coach views, replay
scripts — with zero literal copies.

**Why it matters in HoneySwing.** The shared table's design goal is that a
clinic recalibration is *a single edit, not a hunt through the detectors*.
The product plan involves re-tuning thresholds against real coaching sessions;
any copy of a tunable silently desynchronizes on the first recalibration —
the coach tunes against rules the production detectors no longer run.

**ATTACK FIRST — what could be broken.**
- A literal copy of a shared tunable in any consumer → one recalibration,
  two divergent rule-sets, no error anywhere.
- Detector-private tunables accreting outside the shared table.
- The detectors' common 5-slot output contract drifting, forcing downstream
  code to branch on camera angle — multiplying every phase change by three.

**Measurement commands.**

```bash
# (a) enumerate shared tunables, then hunt copies of their names/values outside the shared file:
grep -n -E "[0-9]+\.[0-9]+|: [0-9]+," packages/domain/swing/phaseDetectionShared.ts
grep -rn -E "MIN_TRAVEL|VEL_NOISE|downswingBudget|velocityFloor|minTravel" app lib components scripts --include='*.ts' --include='*.tsx' --include='*.mjs' | grep -v '\.test\.'
# (b) detector-private numeric constants bypassing the shared table:
grep -rn -E "const [A-Z_]+ = [0-9]" packages/domain/swing/phaseDetectionDTL.ts packages/domain/swing/phaseDetectionFaceOn.ts packages/domain/swing/phaseDetectionLegacy.ts
# (c) output-contract unity — one declared phase type across detectors:
grep -rn "DetectedPhase" packages/domain/swing/phaseDetection*.ts | grep -E "type|interface|: DetectedPhase\[\]"
```

**Deduction schedule (each item EXTERNAL ASSUMPTION).**
- Literal copy of a shared tunable in a *decision* path: **−30 each**.
- Literal copy in a display-only surface: **−10 each** (−5 if commented with
  its shared source).
- Tunable (recalibratable) constant living detector-private: **−5 each,
  cap −20**.
- Detector output contracts diverged (shape/type not shared): **−40**.

**How deductions are justified.** Each cites the copy's file:line and the
shared constant it duplicates (name and value), plus decision-vs-display
classification from the consuming code.

---

## Axis 5 — Data-contract integrity & evolution

**Weight / maximum score.** 140.

**What it measures.** The analysis-output contract across time and process
boundaries: pipeline result → in-memory store → persisted row →
read-back/reconstruction → UI. Includes generated-DB-type freshness,
write-only fields, semantic contracts (score `null` ≠ `0`), timestamp-parsing
discipline, the raw-storage/read-time-correction invariant (requires
idempotency), and whether old persisted rows remain readable as the pipeline
evolves.

**Why it matters in HoneySwing.** Swings are captured once and re-read
forever: history, playback, trends, and an external inspector consume rows
written by *past* pipeline versions. Contract drift is the least detectable
failure in the system — nothing crashes when a persisted field's meaning
shifts, when a read-time correction stops being idempotent, or when a
timestamp parses into the wrong instant.

**ATTACK FIRST — what could be broken.**
- A field written but read by no in-repo consumer can be silently wrong
  indefinitely; external consumers inherit garbage.
- A read-time transformation regressing to non-idempotent double-transforms
  history playback with zero errors.
- Naive `new Date()` on an offset-less DB string shifts instants by device
  timezone — visible only to users in other timezones.
- Generated DB types drifting lets the compiler bless writes the DB rejects.
- Rows under an old `analysis_version` becoming unrenderable — history breaks
  retroactively.
- Two independent write paths to the same table double-inserting or diverging
  in row shape.

**Measurement commands.**

```bash
# (a) producer/consumer census for persisted analysis columns:
for col in category_scores metric_confidences trail_points pose_full swing_debug angles tempo phases; do echo "== $col =="; grep -rln "$col" app lib components --include='*.ts' --include='*.tsx' | grep -v database.types; done
# (b) idempotency guard for read-time correction exists as a test:
grep -rn -iE "idempot" packages/domain/swing/lowerBodyIdentity*.ts lib/swingStore*.ts
# (c) timestamp discipline — naive Date construction on DB values (triage each hit):
grep -rn "new Date(" app lib components --include='*.ts' --include='*.tsx' | grep -vE "datetime\.ts|\.test\.|new Date\(\)"
# (d) generated-types freshness (EXTERNAL ASSUMPTION: CLI auth + network):
npx supabase gen types typescript --linked > /tmp/dbtypes.ts && diff /tmp/dbtypes.ts lib/database.types.ts | head -40
# (e) write-path census — every insert/upsert into the swings table:
grep -rn -E "from\(['\"]swings['\"]\)" lib app --include='*.ts' --include='*.tsx'
# (f) version-compatibility seam — read-path handling of analysis_version:
grep -rn "analysis_version" lib app packages --include='*.ts' --include='*.tsx'
```

**Deduction schedule (each item EXTERNAL ASSUMPTION).**
- Persisted write-only field with no documentation at the write site:
  **−8 each, cap −40**.
- Read-time correction idempotency untested: **−15**.
- Confirmed naive parse of a DB timestamp column: **−25 each**; unresolved
  suspect hit: **−5 each, cap −15**.
- Generated types drift on columns the app reads: **−30**; drift confined to
  unread columns: **−10**. Command (d) unrunnable: **−15** (50% of the 30 it
  guards).
- More than one independent write path into `swings`: **−25**.
- No read-path tolerance/handling for older `analysis_version` rows: **−15**.

**How deductions are justified.** Each cites the census output (which files
read/write the field), the write-site code, or the diff. "Documented" means a
comment or doc reference at the write site naming the external/future consumer.

---

## Axis 6 — Test health & gate integrity

**Weight / maximum score.** 150.

**What it measures.** (1) The gate itself — the hand-rolled runner's file
discovery and exit-code propagation; (2) pass rate and handling of known-red
suites; (3) distribution of tests relative to where change risk lives.

**Why it matters in HoneySwing.** Every other axis's safety story terminates
here: domain refactors are only safe because `npm test` reruns the
biomechanics. The runner is hand-rolled (`scripts/run-tests.mjs`), so its
discovery rules and exit-code handling can regress like any other code — and
a gate that silently skips suites or swallows failures is strictly worse than
no gate: it manufactures false confidence in every future change.

**ATTACK FIRST — what could be broken.**
- Discovery regression: filename/extension matching quietly excluding a class
  of test files — they "exist" and never run.
- Exit-code propagation regression: suites fail, `npm test` exits 0.
- A permanently-parked red suite normalizing "some red is fine," masking a
  second, unrelated red.
- Risk-coverage mismatch: heavily-tested pure math beside zero-tested
  coordinate/render/persistence glue.

**Measurement commands.**

```bash
# (a) full run — counts, reds, and whether reds are documented as parked:
npm test 2>&1 | tail -15
# (b) discovery audit — on-disk test files vs runner-visible extensions:
find lib packages -name '*.test.ts' -not -path '*/node_modules/*' | wc -l
find . -path ./node_modules -prune -o \( -name '*.test.tsx' -o -name '*.spec.ts' \) -print
# (c) exit-code propagation intact in the runner source:
grep -n "process.exit" scripts/run-tests.mjs
# (d) distribution by area:
find . -path ./node_modules -prune -o -name '*.test.*' -print | sed 's|/[^/]*$||' | sort | uniq -c | sort -rn
# (e) sibling-test coverage of analysis-critical modules:
for m in phaseDetection phaseDetectionDTL phaseDetectionFaceOn phaseDetectionLegacy phaseDetectionShared scoring tempoAnalysis angles analysisPipeline captureValidity; do t="packages/domain/swing/$m.test.ts"; [ -f "$t" ] || echo "NO SIBLING TEST: $m"; done
```

**Deduction schedule (each item EXTERNAL ASSUMPTION).**
- Exit-code propagation broken (gate can be green on failure): **−110**.
- Discovery mismatch: runner executes fewer suites than exist on disk:
  **−40**.
- Runner-invisible test-file class with actual files present on disk:
  **−25**; blind spot exists by design but zero such files yet: **−5**.
- Red suite with no documented parking decision: **−25 each**; documented/
  parked red: **−5 each**.
- Analysis-critical module without a sibling suite: **−8 each, cap −40**.
- Zero tests over app/components while documented capture invariants live in
  that code: **−10**.

**How deductions are justified.** Each cites the run output, the find-vs-run
counts, or the runner source line. "Analysis-critical" is the fixed list in
command (e).

---

## Axis 7 — Static-gate coverage

**Weight / maximum score.** 90.

**What it measures.** What fraction of shipped code (and its tests) the
TypeScript and lint gates actually see — tsconfig `include` reach,
transitive-import coverage, and the fact that the test runner executes via
type-stripping `tsx`.

**Why it matters in HoneySwing.** Strict TypeScript is the primary static net
over the glue layer — capture orchestration, stores, persistence — where most
runtime wiring lives. What matters for evolvability is not whether `tsc`
passes but whether passing means anything for the file you just changed.

**ATTACK FIRST — what could be broken.**
- tsconfig `include` narrower than the source tree → unchecked islands whose
  type errors ship.
- Test files outside every tsconfig, executed by a type-stripping runner →
  they drift from real APIs and keep passing.
- Validation/replay scripts importing production code but sitting outside the
  gate → a domain refactor breaks the toolkit undetected.
- Lint baseline creeping until real signals drown.

**Measurement commands.**

```bash
# (a) the gate itself:
npx tsc --project tsconfig.json --noEmit
# (b) coverage census — files tsc loads vs on-disk, per top-level dir:
npx tsc -p tsconfig.json --noEmit --listFiles | grep -v node_modules | sed -E 's|.*/honeyswing-v2/([^/]+)/.*|\1|' | sort | uniq -c
for d in app lib components packages scripts; do echo "$d: $(find $d -name '*.ts' -o -name '*.tsx' | grep -v node_modules | wc -l) on disk"; done
# (c) test-file blind spot — are any *.test.* files loaded by the gate?
npx tsc -p tsconfig.json --noEmit --listFiles | grep -c "\.test\." || true
# (d) lint gate + baseline:
npx expo lint 2>&1 | tail -5
```

**Deduction schedule (each item EXTERNAL ASSUMPTION).**
- `tsc` gate itself fails: **−60**.
- Unchecked non-test file in a shipped tree (app/lib/components/packages):
  **−2 each, cap −35**.
- Test files entirely outside every tsconfig (type-stripped only): **−20**.
- Validation scripts importing production code, unchecked: **−10**.
- Lint errors above the recorded baseline: **−1 per error, cap −15**; lint
  cannot run: **−8**.

**How deductions are justified.** Each cites the listFiles-vs-find delta
(per directory, with counts) or the gate output. The lint baseline is the last
value recorded in repo docs/memory; if none exists, the current run becomes
the baseline and no deduction is taken.

---

## Axis 8 — Dependency coupling & cycles

**Weight / maximum score.** 90.

**What it measures.** Import cycles across `app/lib/packages/components`, and
package.json hygiene: dependency classification, duplicate/overlapping
runtimes for the same capability, survivability of a future workspace split.

**Why it matters in HoneySwing.** RN new-architecture with frame-processor
worklets is a stack where module cycles produce undefined-at-init failures
dependent on Metro load order, and native-adjacent packages must upgrade in
lockstep. Evolvability here = can you upgrade the stack or extract a package
without archaeology.

**ATTACK FIRST — what could be broken.**
- A cycle through stores / event bus / persistence: works by load-order luck,
  breaks on an unrelated import addition.
- Two packages providing the same capability with no documented reason: an
  upgrade of one silently breaks the other's consumers, on-device only.
- Runtime code importing a dep declared as dev: every tool that trusts
  dependency classes misjudges it later.

**Measurement commands.**

```bash
# (a) cycles (EXTERNAL ASSUMPTION: network for npx; version pinned):
npx --yes madge@8 --circular --extensions ts,tsx app lib packages components
# (b) duplicate-capability runtimes and their resolution:
npm ls react-native-worklets react-native-worklets-core react-native-reanimated
# (c) runtime imports of devDependencies:
for d in $(node -e "console.log(Object.keys(require('./package.json').devDependencies).join(' '))"); do grep -rln "from '$d" app lib components packages --include='*.ts' --include='*.tsx' | head -1 | sed "s|^|RUNTIME-IMPORT of devDep $d: |"; done
```

**Deduction schedule (each item EXTERNAL ASSUMPTION).**
- Cycle through capture/persist stores or event bus: **−50**.
- Cycle crossing app↔lib↔packages boundaries: **−30 each**.
- Intra-layer cycle: **−10 each, cap −30**.
- Duplicate-capability runtimes with no documented constraint requiring both:
  **−15**.
- Runtime import of a devDependency: **−10 each, cap −25**.
- Cycle tool unrunnable: **−23** (50% of the ~45 cycle-related points).

**How deductions are justified.** Each cites the cycle path (module list) or
the package.json entry plus the importing file:line.

---

## Axis 9 — RN/Expo platform & native-bridge health

**Weight / maximum score.** 60.

**What it measures.** Whether native glue evolves safely: source-of-truth vs
build-output copies of Swift plugins stay in sync via an *automated*
mechanism; new-architecture flags agree across config surfaces; installed
packages match SDK expectations.

**Why it matters in HoneySwing.** The frame-processor plugin is the app's
single data source. Keeping native sources in a dedicated tree with copies
materialized into the iOS project is only safe if the copy step is mechanical.
On RN 0.81 + React 19 + new-arch, config drift turns routine SDK upgrades
into native debugging sessions.

**ATTACK FIRST — what could be broken.**
- A fix applied to the build-output copy (the file Xcode shows) evaporates on
  the next prebuild; reviewed source ≠ shipped binary.
- No copy mechanism at all — hand-maintained "copies" are a drift generator.
- New-arch flags disagreeing between config surfaces → local and EAS builds
  behave differently.
- Package versions drifting from SDK expectations after manual native work.

**Measurement commands.**

```bash
# (a) source-vs-copy drift for every mirrored native file:
for f in native-assets/ios/*.swift; do b=$(basename "$f"); if [ -f "ios/honeyswing/$b" ]; then diff -q "$f" "ios/honeyswing/$b" || echo "DRIFT: $b"; fi; done
# (b) copy mechanism exists and is wired in:
grep -rn "native-assets" plugins app.json package.json 2>/dev/null | head
# (c) new-arch flag coherence:
grep -rn "newArchEnabled" app.json ios/Podfile.properties.json android/gradle.properties 2>/dev/null
# (d) SDK alignment (EXTERNAL ASSUMPTION: network):
npx expo-doctor 2>&1 | tail -10
```

**Deduction schedule (each item EXTERNAL ASSUMPTION).**
- Functional drift in the frame-processor plugin itself: **−45**.
- Functional drift in any other mirrored native file: **−20 each, cap −40**.
- No automated copy mechanism found: **−15**.
- New-arch flag disagreement across surfaces: **−15**.
- expo-doctor failures beyond documented waivers: **−5 each, cap −15**;
  doctor unrunnable: **−5**.

**How deductions are justified.** Each cites the diff output, the absence of
any plugin/script reference, or the flag values per surface.

---

## Axis 10 — Dead code & change-amplification hotspots

**Weight / maximum score.** 40.

**What it measures.** (1) Unreferenced modules/exports, measured with real
dead-code tooling (mixed import styles make grep unreliable); (2) files so
large that unrelated changes collide in them, tracked as a *trajectory*.

**Why it matters in HoneySwing.** Dead modules still compile, appear in
searches, and mislead contributors sizing a change. Oversized files matter
mechanically: when one file hosts capture UI, state wiring, and effects, every
feature touches it and every merge conflicts in it. Weighted lowest because
both taxes fail loudly compared to contract drift — but they compound.
Phase 2 caveat: intentionally parked code (features paused by product
decision) must be allowlisted before tooling runs, never counted as dead or
deleted.

**ATTACK FIRST — what could be broken.**
- Dead-code tooling run naively deletes intentionally parked code — a product
  decision made by a linter.
- Orphaned experimental modules accrete until upgrades must migrate code
  nobody runs.
- Previously decomposed screens silently regrow as new features land in the
  path of least resistance.

**Measurement commands.**

```bash
# (a) unused files/exports/deps (EXTERNAL ASSUMPTION: network for npx; expo-router entry config may need flags):
npx --yes knip@5 --include files,exports,dependencies 2>&1 | head -60
# (b) god-file census with trajectory — compare against the previous recorded census:
find app lib packages components -type f \( -name '*.ts' -o -name '*.tsx' \) ! -name '*.test.ts' ! -name 'database.types.ts' -exec wc -l {} + | sort -rn | awk '$1 > 600 {print}'
# (c) parked-code allowlist: build from product docs BEFORE running (a); diff knip output against it.
```

**Deduction schedule (each item EXTERNAL ASSUMPTION).**
- Orphaned module on the capture/persist path: **−10 each, cap −20**.
- Off-path orphans beyond the first 5: **−1 each, cap −10**.
- God-file count grew vs prior recorded census: **−5 per new file, cap −15**.
- No parked-code allowlist built before tooling ran: **−5**.
- Dead-code tool unrunnable: **−10** (50% of the ~20 orphan-related points).

**How deductions are justified.** Each cites the tool output line (triaged
against the allowlist) or the census delta with both counts.

---

## Self-audit (retained from the banded revision; conclusions unchanged)

**1. Risk almost missed:** version compatibility of persisted rows — added to
Axis 5 (command (f), version-tolerance deduction).
**2. Weakest axis:** Axis 10 — tooling-dependent, most style-adjacent;
mitigated by lowest weight, trajectory-based deductions, allowlist step.
**3. Overlap/merge:** "analysis-output consumption" merged into Axis 5;
Axes 1/2 and 6/7 kept separate (different measurement planes, independent
failure modes).
**4. Architecture vs style:** 9 of 10 axes measure structural properties
(dependency direction, contract stability, single-sourcing, gate
trustworthiness, cycles, artifact provenance). File size is defended as
change-amplification, weighted lowest; console-noise counts only because the
gate is exit-code-only.

**Mechanical checks:** weights sum 140+70+130+90+140+150+90+90+60+40 = 1000 ✓;
every deduction schedule labeled EXTERNAL ASSUMPTION ✓; no current findings
named in this rubric ✓ (discovery lives in the Phase 2 score report).
