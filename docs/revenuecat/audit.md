# RevenueCat SDK Integration Audit — HoneySwing v1.8

Baseline: v1.7 (build 25), live on App Store as of 2026-04-01.

---

## SECTION 1 — Swing Limit System (current state)

### a) Function signature and return type

```ts
export async function checkSwingLimit(): Promise<SwingLimitStatus>
```

`SwingLimitStatus` is `{ allowed: boolean; remaining: number; reason: 'ok' | 'swing_limit' | 'time_limit' }`.

The function is **async** — it awaits `getUser()`, then conditionally queries Supabase.

There is also a helper:

```ts
export async function incrementLocalSwingCount(): Promise<void>
```

**Citation:** `lib/swingLimit.ts:9-13` (type), `lib/swingLimit.ts:21` (checkSwingLimit signature), `lib/swingLimit.ts:15` (incrementLocalSwingCount signature).

### b) Three tiers and exact limit values

| Tier | Constant | Value | Condition |
|------|----------|-------|-----------|
| Free (anonymous) | `FREE_SWING_LIMIT` | **15** | No authenticated user (`getUser()` returns null); count stored in AsyncStorage under key `honeyswing:localSwingCount` |
| Referred (authenticated) | `REFERRED_SWING_LIMIT` | **50** | Authenticated user whose `profiles.referral_coach_id` is not null |
| Coach (authenticated) | — | **unlimited** (returns `remaining: 9999`) | Authenticated user with a matching row in `coaches` table (`auth_user_id = user.id`) |

There is also a **time limit**: authenticated users are cut off after `WEEKS_LIMIT = 6` weeks from `user.created_at`, regardless of tier (`lib/swingLimit.ts:37-41`).

**Citation:** `lib/swingLimit.ts:5-7` (constants), `lib/swingLimit.ts:24-33` (anonymous tier), `lib/swingLimit.ts:43-55` (referred tier), `lib/swingLimit.ts:57-68` (coach tier), `lib/swingLimit.ts:37-41` (time limit).

### c) How tier is determined (Supabase queries)

1. `getUser()` — calls `supabase.auth.getUser()` (`lib/supabase.ts:17-20`). If null → anonymous tier.
2. Time-limit check against `user.created_at` — pure date math, no query (`lib/swingLimit.ts:37-41`).
3. `supabase.from('profiles').select('referral_coach_id').eq('id', user.id).single()` — determines referred vs. free (`lib/swingLimit.ts:45-49`).
4. `supabase.from('coaches').select('id').eq('auth_user_id', user.id).single()` — determines coach tier (`lib/swingLimit.ts:58-63`).
5. `supabase.from('swings').select('*', { count: 'exact', head: true }).eq('user_id', user.id)` — counts swings used (`lib/swingLimit.ts:71-74`).

Total: **3 Supabase queries** for an authenticated non-coach user.

### d) Where `checkSwingLimit` is called

| Call site | File:Line | Context |
|-----------|-----------|---------|
| `checkSwingLimit().then(...)` | `app/analysis/result.tsx:91` | After swing is persisted, checks if limit hit; sets `limitHit` state |
| `incrementLocalSwingCount()` | `lib/persistSwing.ts:100` | Called at end of `persistSwing()` to bump AsyncStorage counter |
| (definition) | `lib/swingLimit.ts:21` | — |

`checkSwingLimit` is called in **one place only**: the result screen.

### e) What happens when the limit is reached

When `checkSwingLimit()` returns `{ allowed: false }`, the result screen checks if the user is anonymous (`getUser()` returns null). If so, it sets `limitHit = true` (`app/analysis/result.tsx:91-97`).

When `limitHit` is true, a sign-in prompt card renders at the bottom of the result screen:

> "Want to keep practicing? Create a free account to save your swings and keep going."
> "Sign up free →" (navigates to `/signin`)

**Citation:** `app/analysis/result.tsx:257-268`.

**Crucially:** nothing prevents the user from tapping "Record Again" — the limit check is **advisory only**, not a gate. The "Record Again" CTA at `app/analysis/result.tsx:248-254` always renders, unconditionally.

### f) VERDICT

The current check is **async** (returns `Promise<SwingLimitStatus>`). The caller **does not await it** — it uses `.then()` fire-and-forget style (`app/analysis/result.tsx:91`). The limit is checked **after** the swing is already recorded and persisted. It is purely a post-hoc nudge, not a pre-recording gate. **There is no paywall gate anywhere in the current codebase.**

---

## SECTION 2 — Record/Capture Flow

### a) Navigation path from "Record Swing" to camera

1. Home screen (`app/(tabs)/index.tsx`) renders "Start Swinging" button at line 56-60.
2. `onPress={() => router.push('/(tabs)/record')}` — navigates to the Record tab (`app/(tabs)/index.tsx:58`).
3. Record tab (`app/(tabs)/record.tsx`) immediately initializes camera permissions and starts the camera feed on mount (`app/(tabs)/record.tsx:331-362`).
4. Once camera is ready, record buttons appear ("3-2-1" countdown or "Record Now") at `app/(tabs)/record.tsx:519-536`.
5. User taps a record button → `startCountdownCapture()` or `startInstantCapture()` → `beginRecording()` → 4s capture → `finalizeCapture()` → `router.push('/analysis/result')` at `app/(tabs)/record.tsx:127`.

**There is no intermediate screen between home and camera.** The record tab IS the camera screen.

### b) Possible paywall gate insertion points

| Option | Location | Pros | Cons |
|--------|----------|------|------|
| **A. Before navigation** | In `index.tsx:58`, before `router.push('/(tabs)/record')` | Clean gate, camera never opens | Would need to intercept tab bar tap too (record is a tab) |
| **B. Inside record screen** | Before `beginRecording()` in `app/(tabs)/record.tsx:258-286` | Camera is already open; user sees themselves | Jarring to open camera then block; camera resources wasted |
| **C. Intermediate modal route** | New route e.g. `app/paywall.tsx`, navigate there first | Clean separation of concerns | Extra navigation step |
| **D. At persist time** | In `finalizeCapture()` or `persistSwing()` | Swing is already recorded; user has value | Punishes after the fact; bad UX |

### c) Existing pattern for intercepting navigation (auth gate)

Yes. The app has an auth-gated flow: after magic link sign-in, `_layout.tsx:62-63` checks `onboarded` and redirects to `/onboarding` if needed. However, this is a redirect-after-auth pattern, not a pre-navigation gate.

The result screen's sign-in prompt (`app/analysis/result.tsx:257-268`) is the closest existing pattern — it conditionally shows a CTA based on a status check. But it's post-hoc, not blocking.

**No existing pre-navigation gate pattern exists in the codebase.**

### d) Navigation search results (capture/record related)

| File:Line | Navigation call |
|-----------|----------------|
| `app/(tabs)/index.tsx:58` | `router.push('/(tabs)/record')` — "Start Swinging" button |
| `app/(tabs)/record.tsx:127` | `router.push('/analysis/result')` — after capture completes |

These are the only two navigation calls in the record flow.

### e) VERDICT: Best insertion point for paywall gate

**Option A — gate before `router.push('/(tabs)/record')` in `app/(tabs)/index.tsx:58`.**

Rationale:
- Cleanest UX: user taps "Start Swinging", paywall appears if needed, camera never opens unnecessarily.
- However, the record screen is also a **tab** — the user can reach it by tapping the "Record" tab icon in the tab bar. This means the gate must also work when the Record tab is tapped directly.

**Recommended approach:** A hybrid of A and B. Add an `async` entitlement check that runs:
1. In `index.tsx` before pushing to record (gate the CTA button).
2. In `record.tsx` on mount/focus (gate the tab-bar entry — show a paywall overlay or redirect if not entitled).

This ensures both entry paths are covered.

---

## SECTION 3 — App Initialization & Auth State

### a) Where app initialization happens

`app/_layout.tsx:43-65` — `RootLayout` has a `useEffect` with an `async function init()` that runs on mount. This is the cold-start initialization point. It:

1. Checks for initial URL (magic link / referral) (`_layout.tsx:46-51`)
2. Commits pending referral (`_layout.tsx:52`)
3. Checks auth session and onboarding state (`_layout.tsx:55-56`)
4. Hides splash screen (`_layout.tsx:59`)
5. Redirects if needed (`_layout.tsx:62-63`)

**`Purchases.configure()` should go at the top of `init()`, before any auth checks**, since RevenueCat should be configured as early as possible (it's idempotent and fast).

**Citation:** `app/_layout.tsx:43-65`.

### b) Supabase onAuthStateChange listener

Located at `app/_layout.tsx:87-97` in a **separate** `useEffect`:

```ts
const { data: { subscription } } = supabase.auth.onAuthStateChange(
  async (event) => {
    if (event === 'SIGNED_IN') {
      await commitPendingReferral();
      router.replace('/(tabs)' as Href);
    }
  }
);
```

On `SIGNED_IN`: calls `commitPendingReferral()`, then navigates to tabs.
On `SIGNED_OUT`: **nothing** — there is no SIGNED_OUT handler.

**Citation:** `app/_layout.tsx:87-97`.

### c) Other logic on auth state change

Beyond the `onAuthStateChange` listener, the warm-start URL listener at `_layout.tsx:70-82` handles:
- Magic link auth via `handleAuthUrl()` (`_layout.tsx:71`)
- Onboarding redirect (`_layout.tsx:73-78`)
- Referral attribution via `handleReferralUrl()` (`_layout.tsx:80`)

The referral system (`lib/referralAttribution.ts`) stores a pending referral code in AsyncStorage and commits it to Supabase when the user signs in (via `commitPendingReferral()`).

### d) Is user ID available at SIGNED_IN?

Yes. When `SIGNED_IN` fires, the Supabase session is already set. `getUser()` / `getUserId()` will return the user's UUID string. The user ID format is a standard UUID string (e.g., from `supabase.auth.getUser()` returning `user.id`).

**Citation:** `lib/supabase.ts:17-20` (getUser), `lib/supabase.ts:27-29` (getUserId returns `user?.id`).

### e) VERDICT

Yes. `Purchases.logIn(userId)` can be added directly inside the `SIGNED_IN` handler at `_layout.tsx:90-93`, after `commitPendingReferral()`:

```ts
if (event === 'SIGNED_IN') {
  await commitPendingReferral();
  const userId = (await supabase.auth.getUser()).data.user?.id;
  if (userId) await Purchases.logIn({ appUserID: userId });
  router.replace('/(tabs)' as Href);
}
```

For `Purchases.logOut()`, a `SIGNED_OUT` case needs to be **added** to the same listener (currently missing):

```ts
if (event === 'SIGNED_OUT') {
  await Purchases.logOut();
}
```

`Purchases.configure()` goes in `init()` at `_layout.tsx:44`, before any auth checks, with the RevenueCat API key only (no user ID — anonymous until sign-in).

**No restructuring required.** This is additive-only — adding a case to an existing listener and one line to `init()`.

---

## SECTION 4 — Settings Screen

### a) Current sections/rows

The settings screen (`app/settings.tsx:82-157`) has this layout:

1. **Title** — "Settings" (`settings.tsx:83`)
2. **Back button** — navigates back (`settings.tsx:85-91`)
3. **Coach section** — shows connected coach name or "No coach linked"; "Remove Coach" button if linked (`settings.tsx:93-107`)
4. **Dominant hand section** — right/left toggle (`settings.tsx:109-137`)
5. **Delete account section** — at bottom (`marginTop: 'auto'`), red "Delete My Account" button with confirmation alert (`settings.tsx:139-155`)

### b) Where "Restore Purchases" fits

Between the handedness section and the delete account section. The delete section uses `marginTop: 'auto'` (`settings.tsx:239`) to push itself to the bottom. A "Restore Purchases" row should go between the handedness toggle and the delete button, in the natural middle area.

### c) Existing pattern for action rows

There are two patterns:

- **Toggle row** (handedness): renders inline options that update state on tap (`settings.tsx:109-137`)
- **Destructive action** (delete, remove coach): `TouchableOpacity` → `Alert.alert()` confirmation → async action (`settings.tsx:47-78`, `settings.tsx:29-44`)

"Restore Purchases" matches the **destructive action pattern** but non-destructive: a `TouchableOpacity` that calls an async function (`Purchases.restorePurchases()`) and shows a success/failure alert.

### d) VERDICT

Add a "Restore Purchases" `TouchableOpacity` in a new `View` section **between the handedness section and the delete section**, following the existing action-button pattern. Visually: a bordered button similar to `removeCoachButton` style, with text "Restore Purchases". On tap: call `Purchases.restorePurchases()`, then show `Alert.alert()` with result.

Insert point: after `</View>` closing the `handednessSection` at `settings.tsx:137`, before `<View style={styles.section}>` at `settings.tsx:139`.

---

## SECTION 5 — Navigation Structure

### a) Routing pattern

Expo Router file-based routing with a **Stack** navigator at root and a **Tabs** navigator nested inside.

Root Stack (`app/_layout.tsx:99-110`):
- `(tabs)` — tab navigator (Home + Record)
- `onboarding` — full-screen
- `signin` — full-screen
- `settings` — full-screen (pushed from Home)
- `auth/callback` — magic link handler
- `analysis/result` — full-screen (pushed from Record)
- `grip/capture` — full-screen
- `grip/result` — full-screen

Tabs (`app/(tabs)/_layout.tsx:1-21`):
- `index` (Home) — with home icon
- `record` (Record) — with videocam icon

All Stack.Screen entries use `headerShown: false`.

### b) Where a paywall screen fits

Three options:

| Option | Implementation | UX |
|--------|---------------|-----|
| **Modal route** | Add `<Stack.Screen name="paywall" options={{ presentation: 'modal' }}/>` to `_layout.tsx` | Slides up over current screen; user can swipe to dismiss; feels lightweight |
| **Full-screen route outside tabs** | Add `<Stack.Screen name="paywall" />` to `_layout.tsx` (like `signin`) | Full takeover; consistent with how `signin` and `onboarding` work |
| **Inside tabs** | Would need to be a tab screen | Doesn't make sense — paywall isn't a persistent destination |

### c) Existing modal or overlay pattern

Yes — the home screen uses a `<Modal>` component for the coach code entry (`app/(tabs)/index.tsx:93-139`). This is a React Native `Modal` with `transparent` + `animationType="fade"`, not an Expo Router modal route.

There are **no** Expo Router modal routes currently defined (no `presentation: 'modal'` in any Stack.Screen options).

### d) VERDICT

**Full-screen route outside tabs**, matching the existing `signin` and `onboarding` pattern. Add `<Stack.Screen name="paywall" />` to `app/_layout.tsx:108` (before `analysis/result`). Create `app/paywall.tsx`.

Rationale: A modal could be dismissed by swipe, which would let users bypass the paywall. A full-screen route is a harder gate and consistent with how `signin` already works. The paywall screen handles its own back navigation (e.g., "Not now" button that goes to `/(tabs)`).

---

## SECTION 6 — Native Dependencies

### a) Is react-native-purchases already installed?

**No.** Zero matches for `purchases`, `revenuecat`, `billing`, or `storekit` across all `.ts`, `.tsx`, `.json`, and `.swift` files. No RevenueCat pods in `Podfile.lock`. The package is not in `package.json` dependencies or devDependencies.

**Citation:** Grep search across `*.{ts,tsx,json,swift}` returned no matches. `Podfile.lock` grep returned no matches.

### b) React Native version

**0.81.5** (`package.json:36`).

### c) Expo SDK version

**Expo 54** (`package.json:20`: `"expo": "~54.0.33"`). New Architecture is **enabled** (`app.json:10`: `"newArchEnabled": true`).

### d) Known compatibility issues

`react-native-purchases` v8+ supports React Native 0.71+ and New Architecture. Expo SDK 54 with RN 0.81.5 is well within the supported range. RevenueCat provides an Expo config plugin (`expo-purchases`) but the raw `react-native-purchases` package also works with manual native setup.

Key consideration: The project uses `use_frameworks!` conditionally (`Podfile:44-45`) — RevenueCat's iOS SDK supports both static and dynamic frameworks.

### e) Expo config plugins

Yes, the project uses config plugins (`app.json:11-31`): `expo-router`, `expo-splash-screen`, `expo-build-properties`, `expo-video`.

`react-native-purchases` does **not** require an Expo config plugin if native setup is done manually. However, RevenueCat offers `expo-purchases` as a convenience wrapper that auto-links. Since this project uses **bare workflow** (builds from Xcode, not EAS Build), manual Podfile addition is preferred over a config plugin to avoid `prebuild --clean` churn.

### f) Current entitlements and IAP capability

`ios/HoneySwingV2/HoneySwingV2.entitlements` currently has only:

```xml
<key>com.apple.developer.associated-domains</key>
<array>
  <string>applinks:honeyswing.com</string>
</array>
```

**The In-App Purchase capability (`com.apple.developer.in-app-payments`) is NOT present.** It must be added:
1. In Xcode: target → Signing & Capabilities → + Capability → In-App Purchase
2. This will add `com.apple.developer.in-app-payments` to the entitlements file

**Citation:** `ios/HoneySwingV2/HoneySwingV2.entitlements:1-10`.

### g) StoreKit 1 vs StoreKit 2

`react-native-purchases` v8+ uses **StoreKit 2** by default on iOS 15+. The project's deployment target is **iOS 16.0** (`app.json:35`, `Podfile:19` sets minimum `15.1`), so StoreKit 2 will be used. No constraints from Expo SDK.

### h) VERDICT: Install command and prebuild requirement

```bash
npm install react-native-purchases
cd ios && pod install && cd ..
```

Then manually add IAP entitlement in Xcode. **No `prebuild --clean` needed** — `react-native-purchases` auto-links via CocoaPods. The existing Podfile uses `use_native_modules!` which will pick it up.

Build from Xcode as usual: `HoneySwingV2.xcworkspace → Cmd+R`.

---

## SECTION 7 — Unmatched Route Fix (bundled into v1.8)

### a) Is `router.replace('/(tabs)')` already in the code?

Yes, `router.replace('/(tabs)' as Href)` appears in multiple places in `app/_layout.tsx`.

### b) Coverage across entry points

| Entry point | Location | Has `router.replace('/(tabs)')` fallback? |
|-------------|----------|------------------------------------------|
| **Cold start** (initial URL) | `_layout.tsx:50` | Yes — `if (initialUrl)` block ends with `router.replace('/(tabs)')` |
| **Warm start** (URL listener) | `_layout.tsx:77` | Yes — inside `if (success)` after onboarding check. Also unconditional `router.replace('/(tabs)')` at `_layout.tsx:81` after `handleReferralUrl` |
| **Auth state change** | `_layout.tsx:92` | Yes — `SIGNED_IN` handler ends with `router.replace('/(tabs)')` |

However, there is a **potential issue**: the warm-start URL listener at `_layout.tsx:70-82` has a logic flow where `router.replace` can be called **twice** — once inside the `if (success)` block at line 77, and again unconditionally at line 81. If `handleAuthUrl` succeeds AND the URL is also a referral URL, both replacements fire. This is a minor bug (double navigation) but not a crash.

### c) Where the fix needs to go (if missing)

The `router.replace('/(tabs)')` fallback exists in all three entry points. No TODO or FIXME comments related to unmatched routes were found in `_layout.tsx`.

### d) VERDICT

**Already coded and shipped** (in v1.7). The `router.replace('/(tabs)')` fallback is present in all three entry points. The minor double-navigation issue in the warm-start handler (lines 77 + 81) is pre-existing and non-blocking for v1.8.

---

## SECTION 8 — Quality Bar Self-Check

### 1. What is actually compiled and running?

- **Swing limit** (`lib/swingLimit.ts`): 3-tier system (15/50/unlimited) + 6-week time limit. Async, queries Supabase. Called post-hoc on result screen only — advisory nudge, not a gate.
- **Auth listener** (`app/_layout.tsx:87-97`): Handles `SIGNED_IN` only. Calls `commitPendingReferral()` and navigates to tabs. No `SIGNED_OUT` handler.
- **Nav structure**: Stack root with nested Tabs (Home + Record). 8 full-screen routes. Record screen is a tab (reachable via tab bar, not just CTA).
- **Persist flow** (`lib/persistSwing.ts`): Inserts swing row to Supabase `swings` table, increments local count. No purchase/billing logic.
- **Settings** (`app/settings.tsx`): Coach section, handedness toggle, delete account. No restore purchases or subscription management.

### 2. What is dead code?

**No purchase/billing remnants exist anywhere.** Zero matches for `purchases`, `revenuecat`, `billing`, `storekit`, or `in-app` across the entire codebase. This is a greenfield integration.

### 3. Where does new logic attach?

| Layer | File | What to add |
|-------|------|-------------|
| **Init** | `app/_layout.tsx` init() | `Purchases.configure({ apiKey })` |
| **Auth** | `app/_layout.tsx` onAuthStateChange | `Purchases.logIn()` on SIGNED_IN, `Purchases.logOut()` on SIGNED_OUT (new case) |
| **Navigation** | `app/_layout.tsx` Stack.Screen list | Add `<Stack.Screen name="paywall" />` |
| **Paywall gate** | `app/(tabs)/index.tsx` + `app/(tabs)/record.tsx` | Entitlement check before recording; redirect to `/paywall` if not entitled |
| **Limit check** | `lib/swingLimit.ts` | Add a 4th tier: "subscriber" — `Purchases.getCustomerInfo()` checks entitlement, returns unlimited if active |
| **Settings** | `app/settings.tsx` | "Restore Purchases" button between handedness and delete |
| **New screen** | `app/paywall.tsx` | Paywall UI with offering display and purchase flow |

### 4. What will fail first and why?

1. **Missing IAP entitlement** — if `com.apple.developer.in-app-payments` is not added to entitlements before building, StoreKit will refuse to load products. This is a silent failure (no crash, just empty offerings). **Must add in Xcode before first test.**
2. **RevenueCat API key misconfiguration** — if `Purchases.configure()` is called with a wrong key, all `getOfferings()` / `getCustomerInfo()` calls return errors. **Test with a sandbox Apple ID first.**
3. **Tab bar bypass** — if paywall gate is only on the CTA button but not on the Record tab, users can bypass it via the tab bar. **Both entry paths must be gated** (see Section 2e).
4. **Race condition in auth listener** — `Purchases.logIn()` is async. If `router.replace` fires before `logIn` completes, the user arrives at tabs with anonymous RevenueCat state. **Must await `logIn` before navigating.**

### 5. What should the developer test first to validate feasibility?

1. **Install `react-native-purchases`**, run `pod install`, add IAP entitlement in Xcode, build. Confirm the app launches without crash.
2. **Call `Purchases.configure({ apiKey: '<rc_api_key>' })` in `init()`**. Confirm no error in console.
3. **Call `Purchases.getOfferings()` from a test button.** Confirm offerings load (requires products configured in RevenueCat dashboard + App Store Connect).
4. **Make a sandbox purchase.** Confirm `Purchases.getCustomerInfo()` returns an active entitlement.
5. **Gate the record flow.** Confirm an un-subscribed user sees the paywall and a subscribed user goes straight to camera.

---

*Audit complete. All claims verified against source files read in full.*

---
---

# Architecture Decisions — RevenueCat SDK Integration

## Verified State Summary (from Prompt 1)

- **Swing limit is async** (`checkSwingLimit(): Promise<SwingLimitStatus>`) with 3 Supabase queries for authenticated users; called post-hoc on result screen only; advisory nudge, not a gate (Section 1f)
- **Two entry paths to Record screen**: "Start Swinging" CTA button (`index.tsx:58`) and Record tab bar icon; no pre-navigation gate exists in the codebase (Section 2a, 2e)
- **App init in `_layout.tsx` useEffect `init()`** (line 43-65); auth listener at lines 87-97 handles SIGNED_IN only (no SIGNED_OUT); user UUID available at SIGNED_IN; additive changes sufficient, no restructuring needed (Section 3a-e)
- **Greenfield integration**: zero RevenueCat/purchase/billing code exists; IAP entitlement missing from entitlements file; `react-native-purchases` not installed; no prebuild needed, just `npm install` + `pod install` + Xcode IAP capability (Section 6a-h)
- **Nav structure**: Stack root + nested Tabs; 8 full-screen routes all with `headerShown: false`; no modal routes exist; `signin` and `onboarding` are the pattern for full-screen gates (Section 5a-d)

All decisions below use ONLY this verified state as ground truth.

---

## DECISION 1 — SDK Configuration Placement

| Option | Description | Pros | Cons | What breaks if it fails |
|--------|-------------|------|------|------------------------|
| A | Inside `_layout.tsx` useEffect `init()`, before auth listener | Single init location, runs early | Adds to already-complex `_layout.tsx` | App crashes on launch if misconfigured |
| **B** | **Dedicated `lib/purchases.ts` init function, called from `_layout.tsx`** | **Clean separation, testable** | **One more import in `_layout.tsx`** | **Same crash risk, extra file** |
| C | Expo config plugin handles native init, JS just calls API | Zero JS init code | May not exist for this SDK, config plugin complexity | Build fails if plugin misconfigured |

### SELECTED: Option B

**Reject A:** `_layout.tsx` already has 97 lines handling splash, deep links, referral attribution, auth state, and onboarding routing (Section 3a). Adding RevenueCat configure + logIn + logOut inline makes the file harder to reason about. The starter prompt says "add alongside, don't restructure" for `_layout.tsx` — a thin `lib/purchases.ts` keeps `_layout.tsx` changes to two import-and-call lines.

**Reject C:** The project builds from Xcode (hard constraint), not EAS Build. Section 6e confirmed config plugins are used but the project is bare workflow. A config plugin would require `prebuild --clean` + restoring `ios/` from git — unnecessary churn for something a single `Purchases.configure()` call achieves.

**Why B:** `lib/purchases.ts` holds the API key constant, `configurePurchases()`, and any helpers (`isSubscribed()`, `syncAuthState()`). `_layout.tsx` calls `configurePurchases()` in `init()` and `syncAuthState(userId)` in the auth listener. One file for all RevenueCat concerns, one import per call site.

---

## DECISION 2 — Entitlement Check Integration with swingLimit.ts

The current `checkSwingLimit` is **async** (Section 1f). `Purchases.getCustomerInfo()` is also async.

**HARD CONSTRAINT:** If entitlement status is unknown, loading, or errored, default to ALLOWING the swing.

| Option | Description | Pros | Cons | What breaks if it fails |
|--------|-------------|------|------|------------------------|
| **A** | **Add `Purchases.getCustomerInfo()` as first check in `checkSwingLimit`, return unlimited if active entitlement** | **Single function, clean hierarchy** | **Every caller must handle async (they already do)** | **Callers that don't await get undefined** |
| B | Separate `isSubscriber()` check before `checkSwingLimit`, pass boolean as param | `checkSwingLimit` signature unchanged, callers choose when to check | Two-step check, callers must coordinate | Caller forgets to check subscription first |
| C | Cache entitlement status in memory on auth and on app foreground, `checkSwingLimit` reads cache synchronously | `checkSwingLimit` stays fast, no async change | Cache can be stale, needs refresh strategy | Stale cache shows paywall to paying user |

### SELECTED: Option A

**Reject B:** Introduces a coordination burden. Section 1d shows `checkSwingLimit` is called in one place (`analysis/result.tsx:91`) and the gate will add one more call site (record screen). Two call sites is manageable, but B requires every call site to remember two steps — check subscription, then check limit, then combine. This is a bug surface. A single function that returns the canonical answer is simpler.

**Reject C:** Stale cache violates the hard constraint in a subtle way. If a user subscribes mid-session, a stale "not subscribed" cache would show the paywall to a paying user. Yes, the default-allow constraint mitigates the reverse case (blocking a subscriber), but showing a paywall to someone who just paid is a support ticket generator. A fresh `getCustomerInfo()` call uses RevenueCat's built-in cache (returns instantly if fresh, network call if stale) — this already provides the caching benefit without maintaining a separate cache layer.

**Why A:** `checkSwingLimit` is already async (Section 1f). All callers already handle it as a Promise (Section 1d: `.then()` in result screen). Adding a subscriber check as the first branch in `checkSwingLimit` adds zero new async burden. The function becomes: subscriber? → return unlimited. Then fall through to existing tier logic. On error, the hard constraint is satisfied by the existing error fallback pattern (`lib/swingLimit.ts:77-78` already returns `allowed: true` on Supabase errors).

---

## DECISION 3 — Paywall Screen Type

Section 5d established the nav structure. Requirement: dismiss goes to home, must not be bypassable by swipe.

| Option | Description | Pros | Cons | What breaks if it fails |
|--------|-------------|------|------|------------------------|
| **A** | **Full-screen route outside tabs (like `signin`/`onboarding`)** | **Consistent with existing patterns, not swipe-dismissable** | **Navigation feels like leaving the app** | **Dismiss requires explicit back nav** |
| B | Modal route with `presentation: 'modal'` | Standard iOS purchase UX, lightweight feel | Swipe-to-dismiss bypasses paywall | User closes paywall by swiping down |
| C | Inline component rendered conditionally on record screen | No navigation needed | Record screen becomes dual-purpose, camera may init behind paywall | Mixing concerns |

### SELECTED: Option A

**Reject B:** Section 5c confirmed no Expo Router modal routes exist in the app — this would be a new pattern. More critically, iOS modal presentation allows swipe-to-dismiss by default. Expo Router's `presentation: 'modal'` enables this gesture. The requirement explicitly says "must not be bypassable by swipe gesture." While `gestureEnabled: false` could disable it, that fights the modal paradigm and may break on future Expo Router updates.

**Reject C:** Record screen (`app/(tabs)/record.tsx`) is already 712 lines (Section 2) handling camera, frame processing, capture phases, video recording, and skeleton overlay. Making it also conditionally render a paywall violates single-responsibility and risks the camera initializing behind the paywall (camera `isActive={true}` at line 433 runs regardless of what's rendered on top).

**Why A:** Matches the `signin` and `onboarding` patterns exactly (Section 5d). Add `<Stack.Screen name="paywall" />` to `_layout.tsx`. Create `app/paywall.tsx`. Dismiss navigates via `router.replace('/(tabs)')` — same pattern used by `onboarding.tsx:64` and `signin` flow. Not swipe-dismissable because Stack screens in this app have no gesture-based back navigation (`headerShown: false` on all routes per Section 5a).

---

## DECISION 4 — Paywall Gate Location

Section 2 found **two entry paths** to the record screen:
1. "Start Swinging" CTA → `router.push('/(tabs)/record')` (`index.tsx:58`)
2. Record tab bar icon (direct tab switch, no code intercept)

| Option | Description | Pros | Cons | What breaks if it fails |
|--------|-------------|------|------|------------------------|
| A | Gate in `record.tsx` on mount/focus — single check covers all entry paths | One location, one check, covers every way user reaches record | Camera may briefly initialize before gate fires | User sees camera flash before paywall |
| B | Gate before `router.push` in `index.tsx` + disable Record tab when over limit | Camera never opens | Two locations to maintain, tab disabling adds complexity | Tab state gets out of sync with limit status |
| **C** | **Replace Record tab content with paywall when over limit (conditional render in `record.tsx`)** | **Single file, no navigation needed, camera never inits** | **Tab component complexity increases** | **Tab component complexity increases** |

### SELECTED: Option C

Wait — let me reconsider. Decision 3 selected a full-screen route. Let me reconcile.

**Revised analysis after Decision 3:** Decision 3 says the paywall is a full-screen route at `app/paywall.tsx`. That means the gate must **navigate to `/paywall`**, not render inline. This eliminates Option C as stated (inline render). Reframing Option C:

**Revised Option C:** On `record.tsx` mount/focus, check entitlement. If not entitled, `router.replace('/paywall')` before camera initializes. Single check location, camera never inits because the replace happens in the `useEffect` before `setCameraReady(true)`.

### SELECTED: Revised Option A (gate in `record.tsx` on focus, navigates to `/paywall`)

**Reject B:** Two locations to maintain. Section 2d confirms only one `router.push` to record (`index.tsx:58`), but the tab bar is a second entry that B addresses by disabling the tab — which requires state management in the parent tab layout (`(tabs)/_layout.tsx`). This crosses a component boundary and requires the tab layout to know about subscription state.

**Reject original C:** Contradicts Decision 3 (paywall is a separate route, not inline).

**Why revised A:** `record.tsx` already has a `useFocusEffect` (line 320-329, Section 2a) that runs every time the tab gains focus. Adding an entitlement check here catches both entry paths with a single mechanism. If not entitled, `router.replace('/paywall')` fires before `beginRecording` is ever callable. The camera does init (`useEffect` at line 331), but the user never sees the record buttons — the replace happens during the same render cycle. To prevent even the camera init, the check can be placed in the `setupScreen` function at line 338, before camera permission request.

---

## DECISION 5 — Auth Sync with RevenueCat

| Option | Description | Pros | Cons | What breaks if it fails |
|--------|-------------|------|------|------------------------|
| **A** | **Add `Purchases.logIn`/`logOut` directly in existing `onAuthStateChange` in `_layout.tsx`** | **Minimal change, co-located with auth logic** | **`_layout.tsx` grows more complex** | **Subscription doesn't transfer across devices if logIn fails** |
| B | Create `lib/purchases.ts` with `syncAuthState(userId?)` that `_layout.tsx` calls | Clean separation, reusable | Extra indirection | Same transfer risk, plus extra file |
| C | Use RevenueCat anonymous ID only, never call logIn/logOut | Zero auth integration complexity | Subscription tied to device not user, no cross-device sync | Paying user gets new phone and loses subscription until restore |

### SELECTED: Option A (executed via the `lib/purchases.ts` from Decision 1)

**Clarification:** Decision 1 selected Option B (dedicated `lib/purchases.ts`). The auth sync logic lives in `lib/purchases.ts` as a `syncAuthState(userId: string | null)` function. `_layout.tsx` calls it from the auth listener. So this is effectively A's placement (in the auth listener) with B's encapsulation (helper function in `lib/purchases.ts`). This is not a hybrid — it's A with the implementation detail that the `Purchases.logIn`/`logOut` calls are wrapped in a helper from the file already created in Decision 1.

**Reject pure B (separate from auth listener):** There's no other place to call it. The auth listener IS where auth state changes. B as a standalone concept (call it "somewhere else") has no meaning — it must be called from the auth listener regardless.

**Reject C:** Section 3d confirms the user UUID is available at SIGNED_IN. Cross-device subscription sync is table-stakes for a paid app. A user who pays on their iPhone and opens the app on an iPad (or reinstalls) should see their subscription immediately. C requires manual restore every time, which generates support tickets.

**Implementation in `_layout.tsx`:** In the existing `onAuthStateChange` handler (Section 3b, `_layout.tsx:88-96`):
- `SIGNED_IN`: `await syncAuthState(userId)` (which calls `Purchases.logIn`)
- `SIGNED_OUT` (new case): `await syncAuthState(null)` (which calls `Purchases.logOut`)

Section 3e confirmed this is additive — no restructuring.

---

## DECISION 6 — Product ID & API Key Constant Location

| Option | Description | Pros | Cons | What breaks if it fails |
|--------|-------------|------|------|------------------------|
| **A** | **Centralized in `lib/purchases.ts` alongside SDK init** | **Single file for all RevenueCat concerns** | **Paywall imports from lib/** | **None meaningful** |
| B | Hardcoded in paywall screen component | Co-located with usage | Duplicated if referenced elsewhere (restore, analytics) | Constants drift on refactor |
| C | In `app.json` extra config, read at runtime | Config-driven | Parsing complexity, may not survive prebuild | Breaks if config parsing fails |

### SELECTED: Option A

**Reject B:** The API key is used in `Purchases.configure()` (called from `_layout.tsx` init), and product/entitlement IDs are referenced in both the paywall screen and the entitlement check in `checkSwingLimit`. That's at minimum 3 consumers. Hardcoding in the paywall means duplicating constants.

**Reject C:** `app.json` is for Expo/build configuration. RevenueCat API keys are runtime constants, not build config. Section 6e confirmed the project uses config plugins but doesn't need one for RevenueCat. Putting the key in `app.json` would require `expo-constants` to read it at runtime — adding a dependency for no benefit.

**Why A:** Decision 1 already created `lib/purchases.ts`. The API key, entitlement identifier string, and offering identifier live there alongside `configurePurchases()`. Single source of truth. The paywall screen imports the entitlement/offering constants from `lib/purchases.ts`.

---

## Protected Surfaces

### Files that WILL change

| File | Change | Classification |
|------|--------|---------------|
| `lib/purchases.ts` | **NEW FILE** — API key, configure, syncAuthState, isSubscribed helpers | MUST SHIP |
| `app/_layout.tsx` | Add `configurePurchases()` call in `init()`, add `syncAuthState()` calls in auth listener (SIGNED_IN + new SIGNED_OUT case), add `<Stack.Screen name="paywall" />` | MUST SHIP |
| `lib/swingLimit.ts` | Add subscriber tier as first check in `checkSwingLimit()` — call `isSubscribed()` from `lib/purchases.ts`, return unlimited if true | MUST SHIP |
| `app/(tabs)/record.tsx` | Add entitlement check in `useFocusEffect` or `setupScreen`, redirect to `/paywall` if not entitled | MUST SHIP |
| `app/paywall.tsx` | **NEW FILE** — paywall UI, offering display, purchase flow, dismiss-to-home | MUST SHIP |
| `app/settings.tsx` | Add "Restore Purchases" button between handedness and delete sections | MUST SHIP |
| `package.json` | Add `react-native-purchases` dependency | MUST SHIP |
| `ios/Podfile.lock` | Updated by `pod install` (auto-generated) | MUST SHIP |
| `ios/HoneySwingV2/HoneySwingV2.entitlements` | Add `com.apple.developer.in-app-payments` capability | MUST SHIP |
| `app.json` | Bump version to `1.8`, bump buildNumber | MUST SHIP |
| `lib/persistSwing.ts` | Bump `APP_VERSION` to `'1.8'` | MUST SHIP |

### Files that must NOT change

| File | Reason |
|------|--------|
| `packages/domain/grip/**` | Protected surface (grip pipeline) |
| `lib/gripStore.ts` | Protected surface (holds photoUri + acceptedAt ONLY) |
| `app/grip/capture.tsx` | Protected surface (grip flow) |
| `lib/persistSwing.ts` upload section | Protected surface (upload logic) — version bump is allowed, upload logic is not |
| `app/_layout.tsx` deep link handlers | Protected surface — `handleReferralUrl`, `storePendingReferral`, `commitPendingReferral` must not be restructured |
| `packages/domain/swing/canonicalTransform.ts` | Protected surface |
| Camera format/frame skipping logic in `record.tsx` | Protected surface — only the focus-check gate is added, capture pipeline untouched |
| Supabase schema | Hard constraint — no new tables, no new columns |
| Any `swing_debug` schema | Hard constraint — additive only, this feature doesn't need it |

### No files classified as BONUS or FUTURE ONLY

Every change listed is required for a functional RevenueCat integration. There are no optional extras.

---

## Consistency Check

- [x] Every decision uses ground truth from Prompt 1, not assumptions
- [x] No decision contradicts another decision (Decision 1→B creates `lib/purchases.ts`; Decision 5→A calls it from auth listener; Decision 6→A puts constants there; Decision 2→A calls its helper from `swingLimit.ts`; Decision 3→A and 4→A work together: paywall is a route, gate navigates to it)
- [x] No hybrid or combined options selected (Decision 5 clarification: A's placement with Decision 1's file is composition, not hybridization — the auth listener is the only valid call site regardless of option)
- [x] Protected surfaces list complete (matches starter prompt protected surfaces + audit findings)
- [x] Every recommendation label present (MUST SHIP on all changes; no BONUS/FUTURE items)

---
---

# Risk Assessment, Build Order & Release Plan — v1.8

## Ground Truth (carried from Prompt 2)

- **Swing limit is async** — 3 Supabase queries, post-hoc advisory only, no gate (Section 1f)
- **Two entry paths to Record** — CTA button + tab bar; no pre-navigation gate exists (Section 2a, 2e)
- **App init in `_layout.tsx` init()** — auth listener SIGNED_IN only; user UUID available; additive changes only (Section 3a-e)
- **Greenfield integration** — zero RC code; IAP entitlement missing; no prebuild needed (Section 6a-h)
- **Nav structure** — Stack + Tabs; `signin`/`onboarding` pattern for full-screen gates (Section 5a-d)

## Locked Architecture Decisions

| # | Decision | Selected |
|---|----------|----------|
| 1 | SDK Config | B — `lib/purchases.ts`, called from `_layout.tsx` |
| 2 | Entitlement + swingLimit | A — First check in `checkSwingLimit()` |
| 3 | Paywall Screen | A — Full-screen route `app/paywall.tsx` |
| 4 | Gate Location | A (revised) — `record.tsx` on focus → `router.replace('/paywall')` |
| 5 | Auth Sync | A — logIn/logOut in auth listener via `lib/purchases.ts` helper |
| 6 | Constants | A — All in `lib/purchases.ts` |

---

## SECTION A — Contradiction Pass

Reviewed Prompt 1 (Sections 1-8) and Prompt 2 (Decisions 1-6 + Protected Surfaces).

**One potential inconsistency identified and resolved:**

Decision 4 says the gate fires in `record.tsx` `useFocusEffect`, redirecting to `/paywall`. But the camera `useEffect` (line 331) runs independently on mount and calls `Camera.requestCameraPermission()`. If the paywall redirect and camera init race, the user might see a camera permission prompt before the paywall. **Resolution:** The entitlement check must go in `setupScreen()` (line 338), before `Camera.getCameraPermissionStatus()`, and `return` early if not entitled. This prevents the permission prompt from firing. This is consistent with Decision 4's note: "the check can be placed in the `setupScreen` function at line 338."

No other contradictions found.

---

## SECTION B — Risk Assessment

| # | Risk | Class | Fires when | Impact |
|---|------|-------|-----------|--------|
| 1 | `react-native-purchases` install + `pod install` incompatible with RN 0.81.5 / Expo 54 / New Arch | CODE/CONFIG | Step 1 (first action) | Dead stop — no SDK, no feature |
| 2 | `Purchases.configure()` crash on launch with wrong API key | CONFIG | Step 5 (first native run) | App unusable; fixable by correcting key |
| 3 | Async entitlement check breaking existing `swingLimit` callers | CODE | Step 7 (swingLimit edit) | Existing limit behavior regresses; caught by tsc + manual test |
| 4 | Paywall navigation/dismiss broken with Expo Router | CODE | Step 8 (gate wiring) | Users stuck on paywall or bypass it; testable in simulator |
| 5 | Sandbox purchase flow failing in dev build | PLATFORM | Step 12 (device test) | Can't verify end-to-end; may need TestFlight build |
| 6 | StoreKit configuration file needed for simulator testing | CONFIG | Step 12 | No products available in simulator; need `.storekit` config or device |
| 7 | Sandbox requires TestFlight, not Xcode dev build | PLATFORM | Step 12 | Slower feedback loop; adds ~30min per iteration |

### BLOCKING RISK: #1 — SDK install compatibility

**Why it ranks above others:** Every other risk assumes the SDK is installed and compiling. If `pod install` fails or the native build breaks due to New Architecture incompatibility, no subsequent step is reachable. Risks 2-7 are all downstream. Risk 1 is the root dependency.

**Concrete first test:**
```bash
npm install react-native-purchases
cd ios && pod install && cd ..
# Open Xcode → HoneySwingV2.xcworkspace → Cmd+R
# Pass criterion: app launches to home screen without crash
```

**Fallback trigger threshold:** "If `pod install` fails or Xcode build fails with RevenueCat-related errors after 2 hours of debugging, stop and evaluate: (a) pin to an older `react-native-purchases` version known to work with RN 0.81, or (b) use the `expo-purchases` wrapper with `prebuild --clean` + ios restore."

---

## SECTION C — Numbered Build Order

### Step 1: [JS-ONLY] — Install `react-native-purchases`
- Files touched: `package.json`, `package-lock.json`
- Depends on: none
- Produces: SDK available for import in JS
- Test gate: `node -e "require('react-native-purchases')"` exits without error
- Fail action: Check npm registry for version compatible with RN 0.81.5; try pinning to specific version

### Step 2: [JS-ONLY] — Create `lib/purchases.ts`
- Files touched: `lib/purchases.ts` (NEW)
- Depends on: Step 1
- Produces: `configurePurchases()`, `syncAuthState()`, `getSubscriptionStatus()`, `restorePurchases()` exports; API key + entitlement ID constants
- Test gate: File imports cleanly, `tsc` passes (Step 10)
- Fail action: Fix type errors against `react-native-purchases` API

### Step 3: [JS-ONLY] — Create paywall screen (UI shell, no SDK wiring)
- Files touched: `app/paywall.tsx` (NEW)
- Depends on: none
- Produces: Static paywall UI with placeholder price text, "Subscribe" button (no-op), "Not now" → `router.replace('/(tabs)')`. Matches `signin`/`onboarding` visual pattern (dark bg, centered content).
- Test gate: Screen renders in isolation (navigable by typing URL in dev tools)
- Fail action: Fix layout/styling issues

### Step 4: [JS-ONLY] — Wire `Purchases.configure()` into app init
- Files touched: `app/_layout.tsx` (add import + call in `init()`)
- Depends on: Step 2
- Produces: `configurePurchases()` called before auth check in `init()` (line ~44)
- Test gate: `tsc` passes; console shows no configure error on launch (verified after native build)
- Fail action: Check API key format, ensure `configure` is called only once

### Step 5: [JS-ONLY] — Wire `logIn`/`logOut` into auth state listener
- Files touched: `app/_layout.tsx` (add SIGNED_IN sync + new SIGNED_OUT case)
- Depends on: Step 2, Step 4
- Produces: `syncAuthState(userId)` on SIGNED_IN (after `commitPendingReferral`, before `router.replace`); `syncAuthState(null)` on SIGNED_OUT
- Test gate: `tsc` passes; auth flow still works (verified after native build)
- Fail action: Check that `await` is used before `router.replace` (Section 8.4 race condition)

### Step 6: [JS-ONLY] — Update `swingLimit.ts` with subscriber tier
- Files touched: `lib/swingLimit.ts`
- Depends on: Step 2
- Produces: New first branch in `checkSwingLimit()`: if `getSubscriptionStatus()` returns active → `{ allowed: true, remaining: 9999, reason: 'ok' }`. On error → fall through to existing logic (default-allow).
- Test gate: `tsc` passes; existing tier logic unchanged below the new branch
- Fail action: Ensure try/catch wraps the RevenueCat call; error = continue to existing tiers

### Step 7: [JS-ONLY] — Wire paywall gate into record flow
- Files touched: `app/(tabs)/record.tsx`
- Depends on: Step 2, Step 3, Step 6
- Produces: In `setupScreen()` (line 338), before camera permission: call `checkSwingLimit()`. If `!status.allowed`, `router.replace('/paywall')` and return early. Camera never inits for gated users.
- Test gate: `tsc` passes; gated path navigates to paywall (verified after native build)
- Fail action: Check that the check runs before `Camera.getCameraPermissionStatus()`

### Step 8: [JS-ONLY] — Add restore purchases to `settings.tsx`
- Files touched: `app/settings.tsx`
- Depends on: Step 2
- Produces: "Restore Purchases" TouchableOpacity between handedness and delete sections. On tap: calls `restorePurchases()` from `lib/purchases.ts`, shows Alert with result.
- Test gate: `tsc` passes; button renders in correct position
- Fail action: Fix layout; check Alert messaging

### Step 9: [JS-ONLY] — Wire paywall SDK calls
- Files touched: `app/paywall.tsx`
- Depends on: Step 2, Step 3
- Produces: Paywall loads offerings via `Purchases.getOfferings()`, displays price from current offering, "Subscribe" button calls `Purchases.purchasePackage()`. On success → `router.replace('/(tabs)/record')`. On cancel/error → stay on paywall.
- Test gate: `tsc` passes; offerings display (verified after native build with sandbox)
- Fail action: Check offering/product IDs match RevenueCat dashboard config

### Step 10: [JS-ONLY] — TypeScript check
- Files touched: none
- Depends on: Steps 1-9
- Produces: Clean `tsc --noEmit` output
- Test gate: Zero errors
- Fail action: Fix all type errors before proceeding to native build

### Step 11: [NATIVE-BUILD-REQUIRED] — `pod install` + IAP entitlement + Xcode build
- Files touched: `ios/Podfile.lock` (auto), `ios/HoneySwingV2/HoneySwingV2.entitlements` (add IAP capability in Xcode)
- Depends on: Step 1, Step 10
- Produces: Running app on simulator/device with RevenueCat SDK linked
- Test gate: App launches to home screen; console shows `[Purchases] - INFO: Configuring Purchases SDK` (or similar); no crash
- Fail action: **This is the blocking risk (Section B).** If pod install fails: check `react-native-purchases` version pins. If build fails: check New Arch compatibility, framework linkage. Fallback: 2-hour threshold → try `expo-purchases` + prebuild.

### Step 12: [PLATFORM] — Sandbox purchase test on device
- Files touched: none
- Depends on: Step 11
- Produces: Verified end-to-end: sandbox Apple ID → purchase → `getCustomerInfo()` returns active entitlement → paywall gate opens
- Test gate: Purchase succeeds; `checkSwingLimit()` returns unlimited for subscriber; record screen accessible
- Fail action: Check sandbox account config, App Store Connect product setup, RevenueCat dashboard product mapping. If sandbox unavailable on dev build, create TestFlight build.

### Step 13: [CONFIG] — Version bump
- Files touched: `app.json` (version → `1.8`, buildNumber → `26`), `lib/persistSwing.ts` (APP_VERSION → `'1.8'`), `ios/HoneySwingV2/Info.plist` (CFBundleShortVersionString → `1.8`, CFBundleVersion → `26`)
- Depends on: Step 12 passing
- Produces: Version-stamped build ready for submission
- Test gate: App displays correct version; persisted swings show `app_version: '1.8'`
- Fail action: Check all three files are in sync

### Step 14: [CONFIG] — RevenueCat dashboard configuration
- Files touched: none (external: RevenueCat dashboard + App Store Connect)
- Depends on: none (can be done in parallel with Steps 1-10)
- Produces: Product created in App Store Connect; mapped in RevenueCat; offering configured; entitlement created
- Test gate: `Purchases.getOfferings()` returns non-empty on device
- Fail action: Check product status in App Store Connect (must be "Ready to Submit" or "Approved")

### Step 15: [PLATFORM] — Regression test pass (see Section F)
- Files touched: none
- Depends on: Step 12
- Produces: All 7 regression checks pass
- Test gate: See Section F
- Fail action: Fix regressions before proceeding

### Step 16: [PLATFORM] — Archive + App Store submission
- Files touched: none
- Depends on: Steps 13, 14, 15
- Produces: Build uploaded to App Store Connect
- Test gate: Build appears in App Store Connect; no processing errors
- Fail action: Fix signing/entitlement issues; re-archive

### Step 17: [CONFIG] — git tag
- Command: `git tag v1.8-submitted`
- Depends on: Step 16
- Produces: Tagged commit for release reference
- Test gate: Tag exists on correct commit
- Fail action: Re-tag

---

## SECTION D — Ship Gates

**Gate 1 (after Step 11):** SDK installed, configured, builds, and launches. **Shippable as a no-op integration** — RevenueCat configured but no paywall gate active. Existing behavior unchanged. This is a safe checkpoint if paywall UX needs more iteration.

**Gate 2 (after Step 15):** Full feature — paywall gate active, purchase flow works, regressions pass. **This is the v1.8 release candidate.**

---

## SECTION E — Cross-Phase Dependencies

| Step | Depends on | What specifically |
|------|-----------|-------------------|
| 2 | 1 | `react-native-purchases` types available for import |
| 4 | 2 | `configurePurchases()` export exists |
| 5 | 2, 4 | `syncAuthState()` export exists; configure already called before auth listener |
| 6 | 2 | `getSubscriptionStatus()` export exists |
| 7 | 2, 3, 6 | `checkSwingLimit()` updated; paywall route exists to navigate to |
| 8 | 2 | `restorePurchases()` export exists |
| 9 | 2, 3 | `Purchases` API available; paywall shell exists to wire into |
| 10 | 1-9 | All JS files must compile |
| 11 | 1, 10 | Package installed; TS clean before native build |
| 12 | 11 | Running app with SDK linked |
| 13 | 12 | Verified feature works before stamping version |
| 15 | 12 | Running app needed for regression checks |
| 16 | 13, 14, 15 | Version bumped, dashboard configured, regressions pass |

**Step 14 (dashboard config) is independent** — can be done in parallel with Steps 1-10. Start it early; it's a common bottleneck (App Store Connect product review can take hours).

---

## SECTION F — Regression Checks

| # | Check | How to verify | Verified at step |
|---|-------|--------------|-----------------|
| 1 | Organic user (no coach, no subscription) → 15 swing limit | Sign out, use app anonymously, verify `checkSwingLimit()` returns `remaining: 15` (or lower based on local count) | Step 15 |
| 2 | Referred user (`referral_coach_id` set) → 50 swing limit | Sign in with referred test account, verify `remaining` against 50-limit tier | Step 15 |
| 3 | Coach user (`coaches` row exists) → unlimited | Sign in with coach test account, verify `remaining: 9999` | Step 15 |
| 4 | Left-handed toggle still works | Toggle in settings, record swing, verify canonical transform applies | Step 15 |
| 5 | Universal Links still fire | Open `https://honeyswing.com/refer/TEST` from Notes app, verify app opens and referral handled | Step 15 |
| 6 | Grip capture still works | Tap "Capture Grip" from home, take photo, verify grip photo appears | Step 15 |
| 7 | Coach name still persists on swings | Link coach code, record swing, check Supabase `swings` row has `coach_name` | Step 15 |

---

## SECTION G — Release Compliance

### 1. App Privacy

`react-native-purchases` (RevenueCat SDK) collects:
- **Purchase history** (what the user bought, subscription status)
- **Device identifiers** (IDFV for anonymous user tracking)

Current App Privacy declarations: Contact Info (Name, Email), Health & Fitness (Fitness), User Content (Photos/Videos, Other User Content), Identifiers (User ID).

**VERDICT: Update needed. MUST SHIP.** Add:
- **Purchases → Purchase History** (linked to User ID, used for App Functionality)
- **Identifiers → Device ID** (IDFV, used for App Functionality — RevenueCat uses this for anonymous IDs)

### 2. Export Compliance

RevenueCat SDK uses HTTPS (TLS) for API communication. This is standard exempt encryption (uses only Apple-provided system TLS). The current app already uses HTTPS (Supabase). **No change to export compliance answer.**

### 3. In-App Purchase Review

This is the first IAP submission for HoneySwing. Known gotchas:
- **Reviewer must be able to test the purchase flow.** Ensure the paywall is reachable without a real subscription. A sandbox account is not enough — the reviewer uses their own environment. Provide clear instructions in App Review notes.
- **Restore Purchases button is REQUIRED by App Store guidelines.** This is included in Step 8 (settings screen).
- **Subscription terms must be visible before purchase.** The paywall screen must show price, duration, and auto-renewal terms.
- **First IAP review often takes longer** (1-3 extra business days) and has a higher rejection rate. Common rejection: missing subscription terms, missing restore button, or paywall not reachable from review path. Include screenshots and navigation instructions in review notes.
- **Subscription group** must be created in App Store Connect before submission.

---

## SECTION H — MUST SHIP / BONUS / FUTURE ONLY

### MUST SHIP (release blockers)
- Step 1: Install SDK
- Step 2: Create `lib/purchases.ts`
- Step 3: Create paywall screen
- Step 4: Wire configure into init
- Step 5: Wire auth sync
- Step 6: Update swingLimit with subscriber tier
- Step 7: Wire paywall gate into record flow
- Step 8: Restore purchases in settings
- Step 9: Wire paywall SDK calls
- Step 10: tsc clean
- Step 11: Native build
- Step 12: Sandbox purchase test
- Step 13: Version bump (app.json + persistSwing.ts + Info.plist)
- Step 14: RevenueCat dashboard + App Store Connect product setup
- Step 15: Regression test pass
- Step 16: Archive + submission
- Step 17: git tag v1.8-submitted
- App Privacy update (Section G.1)

### BONUS
- None. Every item above is required for a functional, reviewable IAP integration.

### FUTURE ONLY
- Webhook integration (server-side subscription event handling)
- Subscription management UI (cancel/change plan — Apple handles this via Settings)
- Analytics dashboard for conversion tracking
- Promotional offers / free trial configuration
- Android IAP (Google Play Billing)

---

## SECTION I — Time Estimates

| Step | Estimate | Assumptions |
|------|----------|-------------|
| 1 | 10 min | npm install + verify |
| 2 | 30 min | Straightforward SDK wrapper; types well-documented |
| 3 | 45 min | Static UI matching existing app style |
| 4 | 10 min | Two lines in `_layout.tsx` |
| 5 | 15 min | Add SIGNED_OUT case + syncAuthState calls |
| 6 | 20 min | Add one branch + try/catch in `checkSwingLimit` |
| 7 | 20 min | One check in `setupScreen()` + early return |
| 8 | 20 min | One button + Alert in settings |
| 9 | 45 min | Wire offerings display + purchasePackage + success/error handling |
| 10 | 10 min | Fix any type errors |
| 11 | 30 min | pod install + Xcode IAP capability + build (assumes no blocking risk) |
| 12 | 30-60 min | Sandbox test; may need TestFlight build |
| 13 | 10 min | Three files, mechanical change |
| 14 | 60-120 min | App Store Connect product creation can be slow; dashboard mapping |
| 15 | 30 min | 7 regression checks on device |
| 16 | 20 min | Archive + upload |
| 17 | 2 min | git tag |

**Total range: 6-8 hours** (single developer, assuming no blocking risk fires). Step 14 (dashboard config) can run in parallel with Steps 1-10, saving ~1-2 hours of wall-clock time.

If blocking risk #1 fires: add 2-4 hours for debugging or fallback path.

---

## SECTION J — Go/No-Go Rule

**Ship v1.8 if and only if:** Gate 2 passes (all 17 steps complete, all 7 regressions green, sandbox purchase verified end-to-end, App Privacy updated) — otherwise hold on `v3-dev` and ship only the Gate 1 checkpoint (SDK configured but no paywall active).

---

## SECTION K — What NOT to Waste Time On

- **Stripe Connect** — manual payouts while under 10 coaches; RevenueCat handles Apple's payment processing
- **Server-side receipt validation** — RevenueCat validates receipts server-side automatically; no custom backend needed
- **Custom subscription management UI** — Apple's Settings → Subscriptions handles cancel/change; App Store guidelines prefer this
- **Webhook integration** — not needed for v1.8; useful later for server-side entitlement checks or churn analytics
- **RevenueCat Offerings A/B testing** — premature; get one offering working first
- **Expo config plugin (`expo-purchases`)** — Decision 1 rejected this; manual setup is simpler for bare workflow
- **Custom paywall animations or design library** — match existing app style; RevenueCat's PaywallUI SDK is not needed
- **Android billing** — iOS only for v1.8; Android can follow later with the same `lib/purchases.ts` and platform-specific API key
- **Supabase schema changes for subscription status** — Hard constraint. RevenueCat is source of truth; no columns needed.
- **Free trial logic** — Can be configured later in RevenueCat dashboard without code changes

---

## SECTION L — Open Questions Registry

See `docs/revenuecat/open-questions.md` (written separately).

---

## SECTION M — Action Gate

**Single fastest proof test on a real device:**

After Step 11 (native build succeeds), add a temporary test button on the home screen that calls `Purchases.getOfferings()` and logs the result. If offerings load (non-null, has `current`), the entire SDK stack is proven: install, pod linking, IAP entitlement, configure, network call, App Store Connect product mapping. This one call exercises every layer. Remove the test button before Step 13 (version bump).

If `getOfferings()` returns null/empty: check App Store Connect product status + RevenueCat dashboard mapping before touching any other code.

---

## Consistency Self-Check

- [x] Plan targets correct compiled code (not dead code) — all changes target live files identified in Prompt 1
- [x] No section assumes something Prompt 1 disproved — all references cite audit sections
- [x] Every phase has a rollback point and gate condition — Gate 1 at Step 11, Gate 2 at Step 15; fail actions on every step
- [x] No silent contract changes between steps — `checkSwingLimit` return type unchanged; `_layout.tsx` auth listener adds cases, doesn't restructure
- [x] All [JS-ONLY] before [NATIVE-BUILD-REQUIRED] — Steps 1-10 are JS-ONLY; Step 11 is first native build
- [x] tsc gate before native build — Step 10 precedes Step 11
- [x] Version bump checklist (app.json + persistSwing.ts + Info.plist) — Step 13
- [x] git tag v1.8-submitted reminder present — Step 17
- [x] Default-allow constraint honored — Step 6 specifies try/catch with fall-through to existing tiers on error
