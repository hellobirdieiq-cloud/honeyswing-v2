# App Store / TestFlight Readiness — HoneySwing v2

Audited 2026-07-02 at v1.10.1, EAS remote build 91 (next build: 92), ASC app `6760777790`. Method: two static sweeps (native/config + JS compliance) on 2026-07-02, plus live checks (EAS CLI, Supabase security advisors, git payload analysis) run this pass. Every P0/P1 claim cites `file:line` or pasted command output.

## MINIMUM TO SUBMIT TO TESTFLIGHT

**Internal TestFlight (≤100 internal testers): nothing blocks it — you can submit today.** Internal distribution skips Beta App Review entirely. Requirements are only: a successful `eas build --profile production` + `eas submit` (credentials wired: team `B3774Z5A69`, ASC app `6760777790`), and export compliance — already declared (`ITSAppUsesNonExemptEncryption: false`). No P1 item applies; processing is automatic once the build uploads.

**External TestFlight (Beta App Review) — only these block it:**
1. ~~Camera-denied dead-end on the core screen (record.tsx)~~ — RESOLVED for the record screen [T2-91, `519d3f7`]; the grip-capture siblings still lack a Settings CTA — P1.1
2. ~~Reachable crash paths (`app/clinic/physical-check.tsx`, `app/clinic/retention.tsx`)~~ — RESOLVED: both files removed in the coach pivot (`b758584`) — P1.3
3. ASC Test Information: privacy policy URL + feedback email (no code change) — P1.4

The remaining P1 items (bogus location string, deep-linkable dev routes) reduce reviewer risk but are unlikely hard blockers for beta review. Everything in P2 is full-App-Store-review scope, not TestFlight.

## P0 — TestFlight build/upload blockers

**None found.** Both candidates were disproven by live checks this pass:

- ~~Version incoherence~~ — `eas build:version:get -p ios` → `iOS buildNumber - 91`. `eas.json` sets `appVersionSource: "remote"` + `production.autoIncrement: true`, so local `app.json` (49), generated `Info.plist` (1.10.0/49), and `pbxproj` (1.0/1) are all non-authoritative. Next TestFlight build = **1.10.1 (92)**.
- ~~EAS upload bloat~~ — all heavy artifacts are outside git's view (`git check-ignore`: `HoneySwing_V2.zip` 343 MB, `HoneySwing_Source.zip`, `.venv/` 680 MB, `exports/` 59 MB ignored; `models/` 111 MB untracked). EAS archives via git → tracked payload is 132 MB / 437 files, 109 MB of it the required `native-assets/ios/rtmw_l_256x192.mlpackage` CoreML weights.
- ~~Public-writable tables with shipped anon key~~ — Supabase security advisors returned **no RLS-disabled or ERROR-level findings** (raw output in appendix). WARNs ranked P2 below.

## P1 — external TestFlight (Beta App Review) risks

1. **Camera-denied dead-end** — RESOLVED on the core screen [T2-91, `519d3f7`]: `app/(tabs)/record.tsx:500-507` now renders "Camera access is off. Enable it in Settings…" + an **Open Settings** button (`Linking.openSettings()`, `:505`). STILL OPEN for the `app/grip/capture.tsx:245-255` siblings, which have only "Go Back" (repo-wide grep: record.tsx has the codebase's only `openSettings` call).
2. **Bogus location permission string** — `app.json` declares `NSLocationWhenInUseUsageDescription`: *"HoneySwing does not use your location. This message may appear because of underlying system components."* No location API exists anywhere (grep clean, no `expo-location`). A purpose string admitting the app doesn't use the permission invites reviewer questions. Fix: delete the key.
3. **Deep-linkable dev/orphaned routes ship in the bundle** —
   - Entire `app/grip/*` subtree (incl. explicit test screen `app/grip/outline-test.tsx`) is unreachable from normal UI (`(tabs)/grip` has `href: null`; no inbound nav) but routable via `honeyswingv2://grip/outline-test`.
   - `app/clinic/imu-debug.tsx` (writes files to `documentDirectory`; the only clinic screen surviving the coach pivot, kept pending the watch-IMU decision) is gated only at the Settings entry (`isCoach`), not inside the screen — deep links bypass the gate.
   - ~~`physical-check.tsx` / `retention.tsx` reachable `throw new Error('Not implemented')` crash paths~~ — RESOLVED: both files (and the dave-dashboard / phase-inspector screens) removed in the coach pivot (`b758584`).
   Fix options: runtime-gate inside screens, or exclude routes from production builds.
4. **External-TestFlight prerequisites (ASC-side, not code)** — Beta App Review requires a privacy policy URL + feedback email in Test Information. Note: in-app, privacy/terms links exist only inside the paywall (`app/paywall.tsx:159-163`); Settings has none. Internal TestFlight (≤100 internal testers) requires none of this.

## P2 — required for full App Store review, not TestFlight

1. **App-authored `PrivacyInfo.xcprivacy` missing.** Pod aggregation is enabled (`Podfile.properties.json` `apple.privacyManifestAggregationEnabled: "true"`) so SDK manifests (MediaPipe 0.10.33, RevenueCat 5.67.1 — GoogleSignIn is EXCLUDED from the build by the `@clerk/expo` podspecPath patch, see `patches/README.md`; `grep GoogleSignIn ios/Podfile.lock` = 0) aggregate at build, but the app's own data-collection declaration and the ASC privacy nutrition labels must cover: swings/pose/video uploaded to Supabase, first-party `events` telemetry (`lib/eventBus.ts:186`), Clerk identity, RevenueCat purchase data, and **kid player profiles** (`lib/playerProfiles.ts` + the `player_profiles` table — minors' data; the former `lib/clinic/kidProfileStore.ts` was deleted in the coach pivot, but the collection obligation is unchanged).
2. **Privacy/terms/support links absent from Settings** — only reachable via paywall. Add to `app/(tabs)/settings.tsx` (expected by reviewers, especially with account deletion + minors' data present).
3. **Supabase advisor WARNs (5)** — `merge_swing_debug` mutable `search_path`; `get_coach_by_code` and `rls_auto_enable` are SECURITY DEFINER executable by `anon`/`authenticated` (`rls_auto_enable` callable by anon is the eyebrow-raiser). Not user-data-writable, but fix before wider beta. Raw advisor output in appendix; remediation links: database-linter lints [0011](https://supabase.com/docs/guides/database/database-linter?lint=0011_function_search_path_mutable), [0028](https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable), [0029](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable).
4. **OTA runtime targeting** — `runtimeVersion: "1.0.0"` hardcoded while `updates.url` is live and `_layout.tsx:91-94` auto-applies updates on launch. Any native-module change without a manual bump mis-targets OTA. Fix: `{ "policy": "appVersion" }`.

## P3 — hygiene

1. Add `.easignore` anyway (defense if archiving mode ever changes; also excludes `models/` from any future tracking).
2. Remove `ios.buildNumber` from `app.json` (EAS CLI explicitly recommends this under remote version source).
3. Stale prebuild artifacts: Apple Sign In entitlement in `ios/honeyswing/honeyswing.entitlements` with zero social login in code (email-code only, verified this pass — Guideline 4.8 not triggered), `Info.plist` 1.10.0, pbxproj 1.0/1. Fix: `npx expo prebuild --clean` before next native build.
4. 255 `console.*` calls across `app`/`lib`/`components`; stray unreferenced `icon-1024.png` (1.1 MB, tracked).
5. `app/analysis/result.tsx:53-63` dead-but-parked state (`coachName`/`limitHit`/`gripCloud`/`positiveResult`) — **report-only; deletion is a parked product decision, do not touch in fix batches.**

## Verified clean

*Re-verified this pass:* email-only auth (no social login → Sign in with Apple not required); no entitlement/signin config in `app.json`; heavy artifacts excluded from EAS payload; no RLS-disabled tables.

*Prior sweep (2026-07-02) — not re-verified this pass:* in-app account deletion via edge function (5.1.1(v)); Restore Purchases + auto-renew disclosure + legal links on paywall (3.1.2); guest mode; mic/photo-library keys correctly absent (`audio={false}` on every `<Camera>`, no media-library APIs); no ATT/tracking/third-party analytics SDKs; `ITSAppUsesNonExemptEncryption: false`; `.env` untracked, service-role key not bundled; ATS not disabled; 1024px no-alpha icon; bitcode off; `__DEV__` gating clean (6 uses, all strip correctly); standard expo-updates OTA only.

## Appendix — raw evidence

### A. EAS remote version (`npx eas-cli build:version:get -p ios`, 2026-07-02)

```
Resolved "production" environment for the build.
Environment variables with visibility "Plain text" and "Sensitive" loaded from the "production" environment on EAS: EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY.

ios.buildNumber field in app config is ignored when version source is set to remote, but this value will still be in the manifest available via expo-constants. It's recommended to remove this value from app config.
iOS buildNumber - 91
```

### B. EAS upload payload (git analysis, 2026-07-02)

```
$ git check-ignore -v HoneySwing_V2.zip HoneySwing_Source.zip .venv models exports
.gitignore:26:*.zip     HoneySwing_V2.zip
.gitignore:26:*.zip     HoneySwing_Source.zip
.gitignore:41:.venv/    .venv
.gitignore:34:exports/  exports
(models: not ignored, but untracked except models/coco_wholebody_index.json — 1 tracked file)

Untracked-but-present heavy dirs: HoneySwing_V2.zip 343M, HoneySwing_Source.zip 1.4M,
.venv 680M, models 111M, exports 59M

Total git-tracked payload: 132 MB across 437 files
Top tracked files:
  109.1 MB  native-assets/ios/rtmw_l_256x192.mlpackage/Data/com.apple.CoreML/weights/weight.bin
    9.0 MB  native-assets/ios/pose_landmarker_full.task
    7.5 MB  native-assets/ios/hand_landmarker.task
    1.1 MB  icon-1024.png

.easignore: does not exist
```

### C. Supabase security advisors (`get_advisors type=security`, project `xutbbirehugrrbkauhnl`, 2026-07-02)

Zero ERROR-level lints; zero RLS-disabled findings. Five WARNs:

```json
[
  {"name":"function_search_path_mutable","level":"WARN",
   "detail":"Function `public.merge_swing_debug` has a role mutable search_path"},
  {"name":"anon_security_definer_function_executable","level":"WARN",
   "detail":"Function `public.get_coach_by_code(coach_code text)` can be executed by the `anon` role as a SECURITY DEFINER function via /rest/v1/rpc/get_coach_by_code"},
  {"name":"anon_security_definer_function_executable","level":"WARN",
   "detail":"Function `public.rls_auto_enable()` can be executed by the `anon` role as a SECURITY DEFINER function via /rest/v1/rpc/rls_auto_enable"},
  {"name":"authenticated_security_definer_function_executable","level":"WARN",
   "detail":"Function `public.get_coach_by_code(coach_code text)` can be executed by the `authenticated` role as a SECURITY DEFINER function"},
  {"name":"authenticated_security_definer_function_executable","level":"WARN",
   "detail":"Function `public.rls_auto_enable()` can be executed by the `authenticated` role as a SECURITY DEFINER function"}
]
```
