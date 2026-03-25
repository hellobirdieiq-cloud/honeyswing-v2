# HoneySwing Master Context V17 — Operator Cut

**Version:** 17.2  
**Date:** March 24, 2026  
**Sources:** V16.1 Operator Cut, March 24 2026 Engineering Extraction (dependency fixes, EAS dev client, Supabase persistence, SwingArt exploration), March 26 2026 session (honeyswing.com landing page build + deployment), March 24 2026 session (auth timing principle added)  
**Authority:** This document is the single working source of truth for sessions. The live repository overrides this document where they conflict.

---

> **⚠️ DO NOT start new feature work before reading Section 0 and Section 10.**

---

## Evidence Labels
- **[VERIFIED March 26, 2026]** = confirmed in the March 26 session
- **[VERIFIED March 24, 2026]** = confirmed in the March 24 session
- **[VERIFIED March 23, 2026]** = confirmed in the March 23 session
- **[VERIFIED March 21, 2026]** = confirmed in the March 21 engineering extraction
- **[VERIFIED PRIOR]** = confirmed in earlier HoneySwing docs and not contradicted here
- **[INFERENCE]** = strong conclusion derived from verified evidence
- **[RECOMMENDATION]** = suggested operational rule, not a code-state fact
- **[SUPERSEDED]** = older guidance that should not drive current work

---

## How To Use This Document

### For the human
- Read **Section 0**, **Section 10**, and **Section 13** first.
- Treat **Section 2** as canonical architecture truth unless the repo proves otherwise.
- Treat **Section 8** as mandatory before any release action.
- When this doc and code disagree, **code wins**.
- When older HoneySwing docs disagree with this doc, **this doc wins**.

### For the AI (paste this when uploading to a new session)
> You are starting a development session on HoneySwing, a React Native golf swing analysis app for junior golfers. The attached document is the single source of truth for project state. Treat Section 2 as the canonical architecture. Do not suggest changes to architecture, pose backend, or data flow unless the repo proves Section 2 wrong. Do not suggest features listed in Section 0.6 as "not yet built" unless I specifically ask about them. When generating code, verify types against the PoseFrame structure in Section 2.3. When I ask what to work on, consult Section 10 for priorities. Default to concrete file paths and terminal commands, not open-ended suggestions. Before generating any code, state which files you'll change and what assumptions you're making — wait for confirmation before proceeding. When I share suggestions from another AI, your job is to judge whether my system actually needs them — not to find the best parts. Rejecting everything is a valid answer.

---

## SECTION 0 — Current State Snapshot

### 0.1 What the app is right now
- [VERIFIED March 23, 2026] **v1 (1.0.0, build 5) is LIVE on the App Store** as of March 23, 2026.
- [VERIFIED March 23, 2026] **v1.1.0 (build 10) is Waiting for Review** at Apple. Submitted March 23.
- [VERIFIED March 24, 2026] App runs on device via **EAS dev client** + Metro hot-reload.
- [VERIFIED March 23, 2026] Live swing capture → analysis → result screen flow works on real iPhone.
- [VERIFIED March 23, 2026] Multi-swing recording sessions work (Record Again loop verified after router.back() fix).
- [VERIFIED March 21, 2026] Current pose backend is **MediaPipe Pose** with **33 landmarks**.
- [VERIFIED March 21, 2026] `analyzePoseSequence()` produces score, tempo ratio, backswing/downswing timing, angles, and phase segmentation.
- [VERIFIED March 21, 2026] Result screen renders real non-fallback outputs including score, coaching cue, tempo, key metrics, and skeleton visualization.
- [VERIFIED March 24, 2026] Supabase swing persistence works end-to-end.

### 0.2 Submission status
- [VERIFIED March 23, 2026] v1 (1.0.0, build 5) **LIVE on App Store** — approved and released March 23.
- [VERIFIED March 23, 2026] v1.1.0 (build 10) **Waiting for Review** — submitted March 23.
- [VERIFIED March 23, 2026] v1.1.0 changes: lowercase display name ("honeyswing"), Today's Focus AsyncStorage persistence fix, all v3-dev features (Trust Stack, Swing Art, etc.).
- [VERIFIED March 23, 2026] v1.1.0 does NOT change App Privacy — stays "Data Not Collected."
- [SUPERSEDED] v1 "In Review" status — v1 is now live.

### 0.3 Real example outputs observed
- [VERIFIED March 21, 2026] ~114 frames, ~3867 ms duration
- [VERIFIED March 21, 2026] Tempo ~4.2 (backswing ~1400 ms, downswing ~333 ms)
- [VERIFIED March 21, 2026] Score ~51
- [VERIFIED March 23, 2026] ~60–114 frames captured per swing; real-time pipeline viable

### 0.4 Shipped and working
- [VERIFIED March 23, 2026] Full capture → analysis → result → record again loop (multi-swing verified)
- [VERIFIED March 23, 2026] Today's Focus on home screen persists via AsyncStorage across navigation
- [VERIFIED March 21, 2026] 33-joint pipeline with valid outputs
- [VERIFIED PRIOR] Practice engine: streaks, personal bests, session reconstruction, current-vs-best comparison, weekly snapshot
- [VERIFIED PRIOR] Intervention layer: one-focus-per-session, drill system with 3 reps, Today's Focus, current drill on Result
- [VERIFIED March 21, 2026] Trust Stack first pass (implemented but not fully validated): capture validity gate, weak-capture recovery, pre-record framing guidance, phase/tempo sanity rules, visual coach card, record-again loop polish
- [VERIFIED March 21, 2026] Skeleton overlay alignment
- [VERIFIED March 21, 2026] Directional coaching cues
- [VERIFIED March 21, 2026] Swing Art renderer
- [VERIFIED March 21, 2026] Recording modes: countdown and instant
- [VERIFIED March 23, 2026] `@react-native-async-storage/async-storage` installed and linked
- [VERIFIED March 24, 2026] Supabase swing persistence (`lib/persistSwing.ts`) — integer fields rounded
- [VERIFIED March 24, 2026] EAS dev client installed on device, device UDID registered
- [VERIFIED March 24, 2026] Onboarding screen exists (`app/onboarding.tsx`) — temporarily bypassed in `_layout.tsx`
- [VERIFIED March 24, 2026] Left-handed support wired into onboarding, VisualCoachCard, computeFocus, result screen
- [VERIFIED March 26, 2026] honeyswing.com live — landing page with app icon, real screenshot in phone mockup, QR code to App Store, Dave Donnellan coach section. Hosted on GitHub Pages, DNS via Namecheap, HTTPS enforced.

### 0.5 Shipped but still validation-sensitive
- [VERIFIED March 21, 2026] Capture validity logic exists, but hard thresholds still need real-swing validation.
- [VERIFIED March 21, 2026] Phase/tempo sanity rules exist, but phase ordering is still trust-sensitive.
- [VERIFIED March 21, 2026] Result flow is improved, but full confidence-aware suppression is not finished.
- [VERIFIED March 21, 2026] Scoring is usable for testing, but still needs calibration against real swings.

### 0.6 Not yet built
- [VERIFIED March 21, 2026] Fully hardened capture quality gating
- [VERIFIED March 21, 2026] Confidence-aware result display across the whole UI
- [VERIFIED March 21, 2026] Structured server-side validation logging (`swing_debug`) — target fields: capture quality, phase source, failure modes
- [VERIFIED March 21, 2026] `coach_name` column + UI (onboarding captures coach selection, but not yet persisted to Supabase `profiles` table in production)
- [VERIFIED PRIOR] Outcome tracking / recurrence detection
- [VERIFIED PRIOR] Coach dashboard
- [VERIFIED PRIOR] Video cloud storage
- [VERIFIED PRIOR] Adult age tier

### 0.7 Active blockers
- [VERIFIED March 21, 2026] Phase detection can misorder events and produce unrealistic tempo ratios.
- [VERIFIED March 21, 2026] The system can still present clean-looking numbers from weak data.
- [VERIFIED PRIOR] HoneySwing still needs **20–40 real swings** to separate trustworthy outputs from noisy ones.
- [VERIFIED March 24, 2026] Onboarding screen renders black on fresh dev client install (splash screen timing issue). Temporarily bypassed.

### 0.8 Immediate operating rule
- HoneySwing is in **validate + launch + learn**, not blank-slate rebuild mode.
- **Do not let motion validation freeze all other progress.**
- **Trust beats novelty.**

---

## SECTION 1 — App Identity

### 1.1 Canonical identity

| Field | Value |
|-------|-------|
| **Product Name** | HoneySwing |
| **Home screen display name** | honeyswing (lowercase, fits under icon) |
| **App Store App ID** | 6760777790 |
| **Bundle ID** | `com.honeyswing.honeyswing-v2` |
| **Apple Developer Account** | Samuel Mazzeo (`sammazzeo31@gmail.com`) |
| **Expo/EAS Project** | `@honeyswing/honeyswing-v2` |
| **Repo Path** | `/Users/sammazzeo/Desktop/HoneySwing/honeyswing-v2` |
| **GitHub** | `hellobirdieiq-cloud/honeyswing-v2` |
| **Website Repo** | `hellobirdieiq-cloud/honeyswing-site` |
| **Website Local Path** | `~/Desktop/honeyswing-site` |
| **Website Domain** | honeyswing.com (Namecheap → GitHub Pages) |
| **Live Version** | 1.0.0 (build 5) |
| **Waiting for Review** | 1.1.0 (build 10) |
| **Active Branch** | `v3-dev` |
| **Latest Commit** | `d75626d` |
| **Git Tags** | `v1.0-trust-stack-complete`, `v1-current-checkpoint`, `v2-candidate`, `v1.1.0-submitted` |

### 1.2 Identity rules
- [VERIFIED PRIOR] **Bundle ID + App Store App ID + EAS project are the real identity.**
- [VERIFIED PRIOR] Display names are unreliable unless they match the IDs above.
- [VERIFIED PRIOR] V3 / V4 / later labels are internal evolution only, not separate apps.
- [VERIFIED PRIOR] Never create a new App Store app record for updates.
- [VERIFIED PRIOR] Never run `eas init` in an existing project.
- [VERIFIED PRIOR] Never refer to a build without version + build + app identity.
- [VERIFIED PRIOR] Never clean up duplicate records during an active review cycle.

### 1.3 Naming rules
- User-facing name: **HoneySwing**
- Home screen display name: **honeyswing** (lowercase to avoid truncation — "HoneySwing V2" truncated to "HoneySwin…")
- Internal repo language: `honeyswing-v2`
- Internal roadmap language: V3 / Sprint / Batch / Stage is fine internally, never as public app identity

---

## SECTION 2 — Architecture Truths

### 2.1 Canonical pipeline
```text
Camera (VisionCamera)
→ Native Pose Plugin (MediaPipe Pose)
→ Frame → PoseFrame (33 joints)
→ PoseSequence accumulation
→ analyzePoseSequence()
→ swingMotionStore
→ Result Screen
→ persistSwing() → Supabase
```

### 2.2 Backend truth
- [VERIFIED March 21, 2026] Current backend is **MediaPipe Pose**.
- [VERIFIED March 23, 2026] MediaPipe pod is `MediaPipeTasksVision ~> 0.10.14`.
- [SUPERSEDED] Apple Vision as the current active backend.
- [SUPERSEDED] Older MLKit backend descriptions as the live runtime truth.

### 2.3 Joint system
- [VERIFIED March 21, 2026] Full **33-landmark BlazePose** structure is the current joint model.
- [VERIFIED March 21, 2026] `PoseFrame` shape: `timestampMs`, `joints: Record<JointName, NormalizedJoint>`, `frameWidth`, `frameHeight`
- [VERIFIED March 21, 2026] `analyzePoseSequence()` depends on: complete and correctly mapped joints, consistent timestamps, correct normalization

### 2.4 PoseFrame compatibility warning
- V1 PoseFrame uses `landmarks: PoseLandmark[]` with `timestamp` and `frameIndex`.
- V2 PoseFrame uses `joints: Record<JointName, NormalizedJoint>` with `timestampMs`.
- **These are incompatible. Never mix them.**

### 2.5 Data architecture
- [VERIFIED March 21, 2026] Active session data is **in-memory first** through `swingMotionStore`.
- [VERIFIED March 23, 2026] Today's Focus data is persisted via **AsyncStorage** so it survives navigation back to home screen.
- [VERIFIED March 24, 2026] Supabase swing persistence via `lib/persistSwing.ts`. Stores frames, analysis, classification, timing. Integer fields (`duration_ms`, `backswing_ms`, `downswing_ms`) must be `Math.round()`ed.
- [VERIFIED PRIOR] Sessions reconstructed client-side from `swings.created_at` using 30-minute gap rule.
- [VERIFIED PRIOR] Video is device-local only.
- [VERIFIED PRIOR] Free swing limit enforced by swing rows in the database.

### 2.6 Provider abstraction
- [VERIFIED March 21, 2026] Pipeline separation is provider → analysis → UI.
- [VERIFIED March 21, 2026] Provider abstraction allows backend swapping without rewriting downstream analysis code.

### 2.7 Guard architecture
- [VERIFIED PRIOR] Three-layer invalid capture guard: AI prompt returns `analysis_failed` → server exits early → client blocks persistence.
- [VERIFIED March 21, 2026] Client-side capture validity gate exists in first-pass form, needs hardening.

### 2.8 Scoring architecture
- [VERIFIED PRIOR] On-device scoring uses angle deviation from ideal values with tolerance bands.
- [VERIFIED PRIOR] Honey Boom threshold is **85**.

### 2.9 Phase detection and tempo
- [VERIFIED March 21, 2026] Current phases: Top and Impact with derived timing segments.
- [VERIFIED March 21, 2026] Heuristic-first with fallback; each phase carries `source: 'heuristic' | 'fallback'`.
- [VERIFIED March 21, 2026] Major trust risk: bad phase ordering causes unrealistic tempo.
- [INFERENCE] Tempo should be considered invalid unless phase ordering is trusted.

### 2.10 Navigation architecture
- [VERIFIED March 23, 2026] Result screen → Record Again must use `router.back()`, not `router.replace()`.
- [VERIFIED March 23, 2026] `router.replace('/(tabs)/record')` remounts the tab navigator, destroys camera state, causes "preparing camera" hang.
- [VERIFIED March 23, 2026] `router.back()` pops to the already-mounted tab — camera stays initialized, `useFocusEffect` handles reset.

### 2.11 Today's Focus data flow
- [VERIFIED March 23, 2026] `computeFocus()` in `swingMotionStore.ts` finds the worst metric from angles (same scoring logic as VisualCoachCard).
- [VERIFIED March 23, 2026] Result screen `useEffect` calls `computeFocus(angles)` and persists via `saveFocus()` to AsyncStorage.
- [VERIFIED March 23, 2026] Home screen `useFocusEffect` calls `loadFocus()` from AsyncStorage on every tab visit.
- [VERIFIED March 23, 2026] Bug: focus data was not persisting because it was previously in-memory only — did not survive navigation back to home.

### 2.12 Session architecture
- [VERIFIED PRIOR] Session auto-starts on first analyzed swing.
- [VERIFIED PRIOR] Session context accumulates in memory and drives drill / CTA behavior.
- [VERIFIED PRIOR] Cross-screen handoff is intentionally lightweight.

### 2.13 Dev workflow architecture
- [VERIFIED March 24, 2026] Primary dev path is **EAS dev client** + Metro hot-reload. Not local Xcode builds.
- [VERIFIED March 24, 2026] Start Metro: `npx expo start --dev-client --clear`
- [VERIFIED March 24, 2026] JS changes hot-reload without rebuilding. Only need a new EAS build when native dependencies change.
- [VERIFIED March 24, 2026] Device UDID: `00008130-001E15491A8A001C` (Sam Mazzeo's iPhone), registered with Expo.
- [INFERENCE] The Worklets `checkCppVersion` only runs in `__DEV__` mode. EAS release builds were never affected by the Worklets conflict.

### 2.14 Architecture assumptions to keep until disproven
- `swingMotionStore` remains the active session handoff.
- Supabase remains non-blocking for core analysis.
- Media stays local unless a clear product need changes that.
- Trust gating stays in front of product expansion.

---

## SECTION 3 — What Works (Verified)

### 3.1 Core loop
- [VERIFIED March 23, 2026] Record → Result → Record Again works across multiple consecutive swings.
- [VERIFIED March 21, 2026] Real pose data drives analysis (not fallback).
- [VERIFIED March 21, 2026] Processing time acceptable for this stage.

### 3.2 Trust Stack — shipped first pass
1. **Capture Validity Gate**
2. **Weak-Capture Recovery**
3. **Pre-Record Framing Guidance**
4. **Phase / Tempo Sanity Rules**
5. **Visual Coach Card**
6. **Record-Again Loop Polish** (router.back() fix applied March 23)

### 3.3 Analysis pipeline
- 33-joint pipeline produces valid outputs
- Angle calculations work
- Phase segmentation produces usable outputs
- Skeleton overlay aligns with joint system
- Directional coaching cues implemented

### 3.4 Practice engine (Batch 1 complete)
- Current-vs-best comparison, personal best celebration, Beat Your Best, weekly snapshot, streak tracking, score trend chart, session reconstruction

### 3.5 Intervention layer (Batch 2 complete)
- One-focus-per-session, issue detection, Today's Focus (now persisted via AsyncStorage), current drill on Result, drill completion tracking, 3 reps

### 3.6 Platform cleanup (Stage 6 complete)
- Coaching-tone tuning, result-screen progress framing, structured angle assessment, drill off-by-one fix, analytics cleanup, paywall copy, logging foundation

### 3.7 Release surface
- Privacy/support URLs live, App Privacy = "Data Not Collected", screenshots aligned
- [VERIFIED March 23, 2026] v1 live on App Store, v1.1.0 waiting for review
- [VERIFIED March 26, 2026] honeyswing.com live on GitHub Pages with custom domain
- [VERIFIED March 26, 2026] Landing page includes: app icon, real result screen screenshot in phone mockup, feature cards, 3-step how-it-works, Dave Donnellan coach quote, QR code pointing to App Store listing
- [VERIFIED March 26, 2026] Footer links: privacy → `hellobirdieiq-cloud.github.io/honeyswing-privacy/`, support/contact → `sammazzeo31@gmail.com`
- [VERIFIED March 26, 2026] DNS: Namecheap A records (4x GitHub IPs) + CNAME (www → hellobirdieiq-cloud.github.io)

### 3.8 Website deployment
- [VERIFIED March 26, 2026] Repo: `hellobirdieiq-cloud/honeyswing-site` on GitHub
- [VERIFIED March 26, 2026] Local path: `~/Desktop/honeyswing-site/`
- [VERIFIED March 26, 2026] Files: `index.html`, `icon.png`, `screenshot.png`, `CNAME`
- [VERIFIED March 26, 2026] Deploy process: edit files → `git add -A && git commit -m "msg" && git push` → auto-deploys in ~30 seconds
- [VERIFIED March 26, 2026] Domain: honeyswing.com registered at Namecheap, pointed to GitHub Pages via A records + CNAME
- [VERIFIED March 26, 2026] HTTPS via GitHub Pages Let's Encrypt auto-provisioning

---

## SECTION 4 — What Broke + Lessons Learned

### 4.1 Product trust failures
- The biggest failure mode is **false confidence**. Users cannot tell "low-confidence correct" from "high-confidence wrong." The system must withhold before it overstates.

### 4.2 Pipeline / data-shape failures
- Incorrect joint mapping breaks analysis entirely. **Root cause:** PoseFrame.joints mapping was wrong.
- `analyzePoseSequence()` is shape-sensitive; partial structures create silent bad outputs.
- Phase ordering errors invert tempo. **Root cause:** fallback misplaces Top/Impact.
- Registration mismatch in native plugins fails silently. **Root cause:** string must match in three places.

### 4.3 Navigation / state failures
- [VERIFIED March 23, 2026] Record Again using `router.replace()` caused tab remount → camera hang on second swing. **Fix:** `router.back()`.
- [INFERENCE] Any navigation from result back to record must use `router.back()`, never `router.replace()` to a tab route.

### 4.4 Today's Focus persistence failure
- [VERIFIED March 23, 2026] Today's Focus did not appear on home screen after analyzed swings. **Root cause:** focus data was computed but stored only in memory — did not persist across navigation. **Fix:** `computeFocus()` writes to AsyncStorage via `saveFocus()`; home screen reads via `loadFocus()` in `useFocusEffect`.

### 4.5 Build / native dependency failures
- [VERIFIED March 23, 2026] `prebuild --clean` deletes ALL custom native files in `ios/`. **Root cause:** prebuild regenerates from config; manual files get wiped.
- [VERIFIED March 23, 2026] Recovered files must be re-added to `project.pbxproj` — presence on disk is not enough.
- [VERIFIED March 23, 2026] `prebuild --clean` also stripped `MediaPipeTasksVision` from Podfile and wiped code signing settings.
- [VERIFIED March 23, 2026] `@react-native-async-storage/async-storage` was missing from `package.json` — caused NativeModule null error at runtime.
- [INFERENCE] **Never run `prebuild --clean` without a git tag first.**

### 4.6 Version / build submission failures
- [VERIFIED March 23, 2026] Uploading build 8 (version 1.0.0) to Transporter failed: "Invalid Pre-Release Train. The train version '1.0.0' is closed for new build submissions." **Root cause:** once a version ships, Apple locks that version train. New builds must use a new version number (e.g., 1.1.0).
- [VERIFIED March 23, 2026] `app.json` version and buildNumber were ignored by EAS because an `ios/` directory exists. **Root cause:** when native `ios/` directory is present, EAS reads version from `Info.plist` and `project.pbxproj`, not `app.json`. **Fix:** update `CFBundleShortVersionString` in `ios/HoneySwingV2/Info.plist` directly.
- [VERIFIED March 23, 2026] EAS auto-increments build numbers when remote versioning is enabled (buildNumber went from 6 → 7 → 8 → 9 → 10 across attempts).
- [VERIFIED March 23, 2026] Home screen display name "HoneySwing V2" truncated to "HoneySwin…". **Fix:** changed to lowercase "honeyswing" in `app.json` name field.

### 4.7 Worklets version mismatch failure
- [VERIFIED March 24, 2026] `react-native-reanimated@4.1.6` pulled in `react-native-worklets@0.7.4`. `react-native-vision-camera@4.7.3` depends on `react-native-worklets-core@1.6.3`. Both register native modules. The version check in `checkCppVersion.js` only runs in `__DEV__` mode — EAS release builds never crashed, only local debug builds. Clearing DerivedData exposed the conflict by removing a cached binary that happened to work. **Fix:** pinned `react-native-worklets@~0.8.1` explicitly in package.json with overrides. Upgraded reanimated to 4.1.7.
- [VERIFIED March 24, 2026] `react-native-gesture-handler@2.28` had peer dependency `react-native-reanimated: "^3.18.0"` (<4.0.0). After upgrading reanimated to 4.1.7, gesture-handler crashed with "Exception in HostFunction: <unknown>." **Fix:** upgraded to 2.30 which dropped the strict peer constraint.

### 4.8 Supabase persistence failure
- [VERIFIED March 24, 2026] `persistSwing.ts` inserted float values (e.g., `1300.1130000054836`) into Supabase integer columns (`duration_ms`, `backswing_ms`, `downswing_ms`). **Fix:** `Math.round()` on all three fields.

### 4.9 Onboarding screen failure
- [VERIFIED March 24, 2026] Fresh EAS dev client install has empty AsyncStorage. `_layout.tsx` redirects to `/onboarding`, but the screen renders black. Likely splash screen timing issue with dev client. **Workaround:** bypassed with `if (false)` in `_layout.tsx`. Needs proper fix.

### 4.10 Validation lessons
- Indoor swings compress motion and reduce phase separation. Outdoor and varied conditions matter.
- Do not over-tune before 20–40 real swings exist.

### 4.11 Release / build lessons
- Build truth lives in the artifact, not the config. Apple permanently burns seen versions.
- App Privacy must be published, not merely filled out.
- Never mix EAS and Xcode release paths in one cycle.
- [VERIFIED March 23, 2026] Once a version ships, that version train is closed. Must create a new version (e.g., 1.1.0) before uploading the next build.
- [VERIFIED March 23, 2026] When `ios/` directory exists, version source is `Info.plist`, not `app.json`.
- [VERIFIED March 23, 2026] `supportsTablet: true` in `app.json` requires iPad screenshots for App Store submission. Set to `false` to skip iPad requirement.
- [VERIFIED March 23, 2026] EAS build credits are finite per month. Monitor usage; pay-as-you-go kicks in after included credits are exhausted.
- [VERIFIED March 24, 2026] EAS build credits were exhausted this month (March 2026). Pay-as-you-go active.

### 4.12 Durable anti-patterns
- Do not patch with `as any`. **Because:** type model is wrong.
- Do not treat hidden routes as harmless. **Because:** any file under `app/` is a live route.
- Do not treat first-pass trust features as "done forever." **Because:** thresholds need validation.
- Do not describe the codebase to an AI — upload files. **Because:** assumptions compound.
- Do not run `prebuild --clean` without a git tag. **Because:** it wipes custom native files.
- Do not upload a new build under a shipped version number. **Because:** Apple locks version trains after release.
- Do not assume `app.json` controls version/build when `ios/` directory exists. **Because:** native directory takes precedence.
- Do not clear DerivedData without a known-good rebuild path. **Because:** the cached binary may be the only thing making a conflicted dependency tree work.
- Do not spend more than 30 minutes clearing caches to fix a dependency conflict. **Because:** upgrading the conflicting packages is almost always the right fix.

---

## SECTION 5 — Coding / Engineering Rules

### 5.1 TypeScript
- `packages/pose/PoseTypes.ts` is the single source of truth for pose types.
- Re-export types; never redefine in barrels.
- `tsconfig.json` must include every source directory explicitly.
- Multiple `as any` casts = the type model is wrong.

### 5.2 React Native / Expo / routing
- Every file in `app/` is a route. `typedRoutes: true` requires real route files.
- If both `app/index.tsx` and `app/(tabs)/index.tsx` exist, root index wins.
- After file-structure changes, restart Metro with `--clear`.
- VisionCamera requires a native build, not Expo Go.
- `expo-av` is deprecated in SDK 54; use `expo-audio`.
- [VERIFIED March 23, 2026] Result → Record must use `router.back()`. `router.replace()` destroys camera state.

### 5.3 Native plugins / vision pipeline
- Registration strings must match exactly across native and JS boundaries.
- Wrong image orientation fails silently.
- Clamp x/y after normalization; do not clamp z.
- Reuse processor instances across frames.
- [VERIFIED March 23, 2026] Custom native files must be referenced in `project.pbxproj` — files on disk without Xcode references are silently ignored.
- [VERIFIED March 23, 2026] `prebuild --clean` wipes all custom native files. Always tag before running it.

### 5.4 Version / build management
- [VERIFIED March 23, 2026] When `ios/` directory exists, EAS ignores `app.json` version and buildNumber. Update `CFBundleShortVersionString` in `ios/HoneySwingV2/Info.plist` directly.
- [VERIFIED March 23, 2026] EAS auto-increments build number via remote versioning. Don't rely on local config for build number truth.
- [VERIFIED March 23, 2026] After shipping a version, create a new version in App Store Connect (e.g., 1.1.0 → 1.2.0) before uploading the next build.

### 5.5 Dependency management
- [VERIFIED March 24, 2026] `react-native-worklets@~0.8.1` must be pinned explicitly in package.json with overrides. Without this, reanimated pulls in a version that conflicts with worklets-core at runtime.
- [VERIFIED March 24, 2026] When upgrading `react-native-reanimated`, check and pin `react-native-worklets` explicitly. Also check `react-native-gesture-handler` peer deps.
- [VERIFIED March 24, 2026] After any dependency upgrade that touches native code, do: `cd ios && rm -rf Pods && pod install && cd ..` then rebuild.
- [RECOMMENDATION] When a dependency fix stalls past 30 minutes of cache-clearing, upgrade the conflicting packages instead of clearing more caches.

### 5.6 State management
- Order matters in the session pipeline.
- When session state expands, every clear/reset path must clear new fields.
- Prefer current simple in-memory model.
- [VERIFIED March 23, 2026] Data that must survive navigation (like Today's Focus) needs AsyncStorage, not just in-memory state.

### 5.7 Supabase / persistence
- [VERIFIED March 24, 2026] Round all numeric values before inserting into Supabase integer columns. JS timestamp math produces floats.
- `insertError === null` means success.
- Server response shape changes require client updates. Edge deploys instantly; client requires a build.
- Model strings: Standard = `claude-sonnet-4-5`; Pro = `claude-opus-4-6`.
- Coaching prompts: no negative language. One cue per section.

### 5.8 UI / copy
- Verify contrast, not just layout.
- Numeric copy must sync with constants. Use `[HoneySwing]` log prefixes.
- [VERIFIED March 23, 2026] Display names longer than ~10 characters truncate under the home screen icon.

---

## SECTION 6 — Debugging & Verification Practices

### 6.1 First debugging sequence
1. Verify app/build actually running on device.
2. Verify route/file existence.
3. Verify data shape.
4. Verify native registration string.
5. Verify orientation / normalization.
6. Only then tune heuristics.

### 6.2 Native plugin debugging
- Distinguish plugin-null vs detection-empty vs handler-error with sentinel returns.
- Registration mismatch is the first thing to rule out.
- [VERIFIED March 23, 2026] `grep "FileName" project.pbxproj` confirms Xcode references.

### 6.3 Data persistence debugging
- [VERIFIED March 23, 2026] When data doesn't appear on a screen after navigation, add console.log traces at: write point (save), read point (load), and the screen's mount/focus lifecycle. Filter logs by a tag like `[TodaysFocus]`.
- [VERIFIED March 23, 2026] Common failure: data computed and displayed on one screen but not persisted — disappears when navigating away.

### 6.4 Data-shape first
- Debug `PoseFrame` content before touching scoring or coaching logic.

### 6.5 Key verification commands
- `wc -l` to catch empty scaffolds
- `find app -type f | sort` for Expo Router routes
- `grep -rn "term" --include="*.ts"` for codebase searches
- `grep "FileName" ios/HoneySwingV2.xcodeproj/project.pbxproj` for native file linking
- `npm ls react-native-worklets react-native-worklets-core` to check worklets versions

### 6.6 Build debugging
- Sync `package-lock.json` before EAS build.
- After `prebuild --clean`, verify custom native files are still in pbxproj.
- [VERIFIED March 23, 2026] If "preparing camera" hangs on second swing, suspect navigation method.
- [VERIFIED March 23, 2026] If Transporter says "train is closed," you need a new version number.
- [VERIFIED March 23, 2026] If Transporter shows wrong version, check `Info.plist` — not `app.json`.
- [VERIFIED March 24, 2026] If Worklets version mismatch error, check `npm ls react-native-worklets` and pin explicitly.

---

## SECTION 7 — Workflow / Development Process

### 7.1 Dev workflow
- [VERIFIED March 24, 2026] Primary dev path: **EAS dev client** on device + `npx expo start --dev-client --clear`
- [VERIFIED March 24, 2026] JS changes hot-reload instantly. No rebuild needed.
- [VERIFIED March 24, 2026] New EAS build only required when native dependencies change.
- [SUPERSEDED] Local Xcode builds as the primary dev path. Use EAS dev client instead.

### 7.2 Multi-AI workflow
- **Claude**: architecture, synthesis, code review, consolidation
- **ChatGPT**: stress-testing, adversarial review
- **Cursor**: in-editor editing (not yet in active use)
- **Claude Code**: repo-aware debugging, cross-file native issues, dependency conflict resolution. Used successfully on prebuild recovery, recording bug, Today's Focus fix, and Worklets version fix. **Shift+Tab twice** to enter Plan Mode (read-only research before execution).
- One AI builds, another reviews. Reviewer does NOT see builder's explanation.
- When forwarding AI suggestions: "Rejecting everything is a valid answer."

### 7.3 Session checklists
**Start:** Read Section 0, 10, 13. Upload files. Verify branch. Check App Privacy implications.
**End:** Update master context if truth changed. Distinguish verified vs suggested.

### 7.4 Build rules
- Batch changes before building. Deploy edge functions separately when possible.
- [VERIFIED March 23, 2026] Tag in git before any `prebuild --clean` or major native change.
- [VERIFIED March 23, 2026] EAS build credits are limited per month. Monitor usage.
- [VERIFIED March 24, 2026] EAS build credits exhausted for March 2026. Pay-as-you-go active.
- [VERIFIED March 23, 2026] EAS builds require interactive Apple login — run from local terminal, not Claude Code.

---

## SECTION 8 — Release / Submission Truths

### 8.1 Current release status
- [VERIFIED March 23, 2026] v1 (1.0.0, build 5) is **LIVE on App Store**.
- [VERIFIED March 23, 2026] v1.1.0 (build 10) is **Waiting for Review**.
- [VERIFIED March 23, 2026] v1.1.0 release notes: "Improved swing analysis with real-time coaching feedback. Added Today's Focus to help you know what to work on each practice session."

### 8.2 Submission plan
- **v1** (1.0.0, build 5): LIVE. Basic HoneySwing. Privacy = "Data Not Collected."
- **v1.1.0** (build 10, waiting for review): Trust Stack, Swing Art, Today's Focus fix, lowercase display name. Privacy unchanged.
- **v2 / next version** (later): `coach_name` + `swing_debug` + App Privacy update. Remove iPad support if desired (`supportsTablet: false`).

### 8.3 Default release path
1. Verify highest build in TestFlight
2. Create new version in App Store Connect if current version train is closed
3. Bump version in `ios/HoneySwingV2/Info.plist` (NOT just `app.json`)
4. `npx tsc --noEmit`
5. `npx eas build --platform ios --clear-cache` (from local terminal for Apple login)
6. Download `.ipa` → Transporter → verify version number shows correctly → Deliver
7. Wait for build to appear in TestFlight (5–15 min)
8. Manage export compliance (select "None of the algorithms")
9. Attach build → add release notes → Submit for Review

### 8.4 Build number rules
- Next build must be higher than highest Apple has seen. Reusing = permanent rejection.
- Artifact truth beats config truth.
- [VERIFIED March 23, 2026] EAS auto-increments build number with remote versioning. Local config may not reflect actual build number.

### 8.5 Version train rules
- [VERIFIED March 23, 2026] Once a version (e.g., 1.0.0) ships, that version train is permanently closed for new builds.
- [VERIFIED March 23, 2026] Must create a new version (e.g., 1.1.0, 1.2.0) in App Store Connect before uploading the next build.
- [VERIFIED March 23, 2026] "Invalid Pre-Release Train" error = you're uploading to a closed version.

### 8.6 Frozen surfaces during active review
Do not change: Bundle ID, App Store App ID, app name, privacy declarations, permission strings, screenshots, review notes, privacy/support URLs.

### 8.7 Pre-release checklist
- Verify `pwd`, app record, highest TestFlight build
- Verify version train is open (or create new version in App Store Connect)
- Verify `Info.plist` has correct version string (not just `app.json`)
- Publish App Privacy before data-collecting builds
- Verify artifact in Transporter shows correct version before delivering
- Manage export compliance after build appears in TestFlight

---

## SECTION 9 — Product Truths

### 9.1 What makes HoneySwing feel real
Fast capture loop → praise-first framing → one next cue → obvious retry path. Trust > metrics.

### 9.2 Result-screen hierarchy
Score first → one coaching cue → metrics tertiary → primary CTA is Record Again → skeleton visualization.

### 9.3 Coaching tone
No "bad/wrong/failed." Frame corrections as opportunities. One cue per section. Youth age-tier tone.

### 9.4 Durable principles
- One issue, one cue, one drill, one session focus
- Completed practice should feel like progress
- Result screens direct action, not just explain
- Reward showing up, not just elite outcomes
- No dead ends
- Withhold > mislead

### 9.5 Auth timing principle
- **Never block the first swing with a login gate.** Open app → record → result must be frictionless.
- Auth appears only when the user hits the swing limit or tries to subscribe.
- By that moment the user has already seen their swing visualized, received a coaching cue, and felt what the app does.
- They are logging in to **keep** something, not to **try** something. Completely different psychological moment.
- This is a hard product rule, not a UX preference.

### 9.6 Moat
**issue → drill → reps → outcome → retention → better next recommendation**

---

## SECTION 10 — Roadmap State

### 10.1 Completed
- Batch 1 — Practice Engine Foundation
- Batch 2 — Intervention Layer + Coach Pilot Prep + Launch Prep
- Batch 3 / Stage 6 — Platform Cleanup
- V3 Sprint 1 Phase A — Trust Stack
- [VERIFIED March 23, 2026] Record Again bug fix, Today's Focus AsyncStorage fix, native file recovery
- [VERIFIED March 23, 2026] v1 launched on App Store
- [VERIFIED March 23, 2026] v1.1.0 submitted for review
- [VERIFIED March 24, 2026] Dependency conflict resolved (worklets pinned, reanimated 4.1.7, gesture-handler 2.30)
- [VERIFIED March 24, 2026] EAS dev client built and running on device
- [VERIFIED March 24, 2026] Supabase swing persistence working end-to-end
- [VERIFIED March 26, 2026] honeyswing.com landing page built and deployed on GitHub Pages with custom domain
- [VERIFIED March 26, 2026] Namecheap DNS configured (A records + CNAME), HTTPS provisioned
- [VERIFIED March 24, 2026] honeyswing.com footer links fixed (privacy URL, support mailto)

### 10.2 Active now
- **v1.1.0 Waiting for Review** — waiting on Apple
- **Stage 7 — Motion Validation** — collect 20–40 swings (can start now, v1 is live)

### 10.3 Immediate next steps (in order)
1. Wait for v1.1.0 approval
2. Fix onboarding screen (black screen on dev client)
3. Collect 20–40 real swings at simulator with Dave (parallel — app is live)
4. Share honeyswing.com link + QR code with Dave for referrals
5. After v1.1.0 approved: build next version (coach_name + swing_debug + privacy update)
6. Optionally set `supportsTablet: false` in next version to drop iPad screenshot requirement
7. Swap honeyswing.com screenshot for a cleaner one (current shows debugger banner)

### 10.4 Later batches
- Batch 4 — Outcome Tracking + Coach Reinforcement
- Batch 5 — Practice Intelligence
- Batch 6 — Advanced Sensing
- Batch 7 — Coach Business Layer

### 10.5 Dataset milestones
- 20–40 swings → validation
- 100 → algorithm sanity
- 500 → benchmarking
- 1,000 → early moat
- 5,000+ → pattern discovery

### 10.6 Roadmap rules
- **CODE PROGRESS > WAITING ON SWINGS**
- Validation is parallel, not a freeze
- Do not pull advanced sensing forward
- Do not build coach dashboards before demand exists

---

## SECTION 11 — Open Questions

### Blocks next tuning (answer with 20–40 swings)
- What % produce reliable phase detection vs fallback?
- How often does tempo fall outside realistic range?
- Minimum viable capture threshold?
- How to quantify and surface confidence?

### Blocks next version
- When does coach demand justify tooling beyond attribution?

### Answer when data arrives
- Scoring evolution path?
- Android MediaPipe landmark ordering match?
- Drill auto-assignment after completion?
- Adult tier timing?
- Optimal free swing limit?

### New from March 24
- Why does the onboarding screen render black on the dev client? (splash screen timing? Supabase connection?)
- Should `tempo_ratio` also be rounded, or is it expected to be a float in the schema?
- Will the Worklets pin need updating when vision-camera or reanimated next upgrade?

---

## SECTION 12 — Future Considerations

### Next version (after v1.1.0 approval)
- `coach_name` infrastructure — Dave is ready to refer users
- `swing_debug` logging: frame_count, pose_success_rate, phase_source, phase_confidence, tempo_raw_ms, failure_reason
- App Privacy update required before shipping
- Score calibration
- `supportsTablet: false` to drop iPad screenshot requirement
- Fix onboarding screen properly (currently bypassed)

### SwingArt iteration
- swing-art-lab-neon.html exists in Downloads — browser-based art tuning tool with controls for all 5 layers
- SwingArtContour.tsx created (contour ribbon style) — downloadable from Claude chat, not wired in
- Direction: enhance existing neon glow style rather than replace with contour style

### Later batches
- Batch 4: outcome tracking, recurrence, coach reinforcement
- Batch 5: issue → drill → outcome instrumentation, pattern detection
- Batch 6: advanced sensing (benchmark on real clips first)
- Batch 7: coach business layer (after demand)

### Product evolution
- Five-skill graph: Setup, Tempo, Balance, Rotation, Sequencing
- Session types: Quick Fix, Focused Practice, Benchmark
- Mastery + Confidence model
- Parent/coach summary (progress, not biomechanics cockpit)

---

## SECTION 13 — Top Rules Going Forward

1. **Debug data shape before tuning algorithms.**
2. **Never show confident output from low-confidence data.** Withhold > mislead.
3. **Phase detection must be trusted before tempo is shown.**
4. **Trust the repo over the docs.**
5. **Verify the artifact, not the config.** Transporter version > app.json version.
6. **Protect app identity.** Bundle ID + App Store App ID are the real identity.
7. **One issue, one cue, one drill, one session focus.**
8. **Update and publish App Privacy before shipping data-collecting features.**
9. **Batch changes, then build once.**
10. **Tag in git before any prebuild --clean or major native change.**
11. **Do not let validation freeze all progress.**
12. **Real swings beat theory.**
13. **Do not expand scope before pipeline trust is stronger.**
14. **Do not build coach business layer before demand exists.**
15. **Record key decisions in durable docs, not only chats.**
16. **When ios/ directory exists, update Info.plist — not just app.json.**
17. **Create a new App Store Connect version before uploading builds after a release.**
18. **Pin transitive native dependencies explicitly.** Especially react-native-worklets.
19. **When a dependency fix stalls past 30 minutes, upgrade — don't clear more caches.**
20. **Use EAS dev client for day-to-day development, not local Xcode builds.**

---

## Appendix A — Reference Constants

| Item | Value |
|------|-------|
| Honey Boom threshold | 85 |
| Free swing limit | 15 |
| Drill reps per focus | 3 |
| Capture minimum frames | ≥30 |
| Capture minimum pose success | ≥70% |
| Validation target | 20–40 swings |
| Edge function model (Standard) | `claude-sonnet-4-5` |
| Edge function model (Pro) | `claude-opus-4-6` |
| MediaPipe pod version | `~> 0.10.14` |
| Latest shipped build | 10 (v1.1.0, waiting for review) |
| Live build | 5 (v1.0.0) |
| react-native-reanimated | 4.1.7 |
| react-native-worklets | ~0.8.1 (pinned) |
| react-native-worklets-core | 1.6.3 |
| react-native-gesture-handler | 2.30.0 |
| expo-dev-client | installed |
| Device UDID | 00008130-001E15491A8A001C |

---

## Appendix B — Business Context

### Market position
- U.S. junior golfers ages 6–17: ~4 million. Growth since 2019: ~+58%.
- No mobile-only AI swing app targets junior golfers ages 8–17.
- Compete on coaching quality and practice engagement, not raw CV accuracy.

### Coach partnership
- Dave Donnellan first-referral deal: 100% of first-year revenue from his referrals, cap at 100 referrals or $6K, then 25% ongoing.
- Dave being ready to refer users justifies `coach_name` infrastructure in next version.

### Revenue planning (directional)
- ~500 paying users ≈ $30K ARR at $60/year
- ~2,500 paying users ≈ $150K ARR at $60/year

---

*One repo. One bundle ID. One app record. Verify before acting. Trust beats novelty.*
