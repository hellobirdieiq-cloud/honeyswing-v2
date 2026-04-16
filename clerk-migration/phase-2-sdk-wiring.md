# Phase 2 — Clerk Expo SDK Wiring

**Status: SDK-WIRED, BOOT-UNVERIFIED**

App must be launched manually on a dev client built from this phase to confirm boot + existing Supabase sign-in still works.

## 1. Dependencies added

| Package | Version | Section |
|---------|---------|---------|
| `@clerk/expo` | ^3.1.12 | dependencies |
| `expo-secure-store` | ~15.0.8 | dependencies |

## 2. npm overrides added

`@clerk/react@6.4.1` (transitive via `@clerk/expo`) declares peer deps on `react@~19.1.4` and `react-dom@~19.1.4`. The project pins `react@19.1.0` and `react-dom@19.1.0` (Expo SDK 54 defaults). To satisfy `npm ci` on EAS without bumping React, overrides were added:

```json
"overrides": {
  "react-native-worklets": "~0.8.1",
  "@clerk/react": { "react": "$react", "react-dom": "$react-dom" },
  "@clerk/shared": { "react": "$react", "react-dom": "$react-dom" }
}
```

## 3. `.env` entry

```
EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
```

- `.env` is gitignored (line 31 of `.gitignore`)
- `.env` is NOT committed

## 4. `ClerkProvider` wrap location

**File:** `app/_layout.tsx`

**Imports added (lines 5-6):**
```ts
import { ClerkProvider } from '@clerk/expo';
import { tokenCache } from '@clerk/expo/token-cache';
```

**Key constant + guard (lines 25-28):**
```ts
const publishableKey = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;
if (!publishableKey) {
  throw new Error('EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY is not set');
}
```

**Wrap:** `<ClerkProvider publishableKey={publishableKey} tokenCache={tokenCache}>` wraps the root `<Stack>` component.

**Token cache:** Built-in `@clerk/expo/token-cache` (uses `expo-secure-store` internally). No custom token cache module created.

**Existing code untouched:** All PKCE handling, Supabase auth, navigation lock, referral attribution, session timeout, and AppState listeners remain exactly as before.

## 5. `react-dom` pin

`react-dom` was changed from `^19.1.0` to `19.1.0` (pinned) to prevent npm from resolving 19.2.5, which would conflict with the pinned `react@19.1.0`.

## 6. Podfile.lock refresh

`pod update PurchasesHybridCommon --repo-update` was run locally to resolve a stale Podfile.lock conflict:

- `PurchasesHybridCommon` 17.54.0 → 17.55.1
- `RevenueCat` 5.67.0 → 5.67.1
- `RNPurchases` 9.15.1 → 9.15.2

New pods from Clerk/SecureStore:
- `ClerkGoogleSignIn` 3.1.12
- `ExpoSecureStore` 15.0.8
- `AppAuth` 2.0.0, `AppCheckCore` 11.2.0, `GoogleSignIn` 9.1.0, `GoogleUtilities` 8.1.0, `GTMAppAuth` 5.0.0, `GTMSessionFetcher` 3.5.0, `PromisesObjC` 2.4.0

Incidental patch bumps: `RNGestureHandler` 2.30.0→2.30.1, `RNSVG` 15.12.1→15.15.4.

## 7. Build

- **Profile:** `development` (EAS, `developmentClient: true`, `distribution: internal`)
- **Build URL:** https://expo.dev/accounts/honeyswing/projects/honeyswing-v2/builds/d4c5baf0-7dce-4f90-bdec-9bbec2dfc3f5
- **Type check:** `npx tsc --noEmit` passes

## 8. Boot status

**NOT VERIFIED YET** — manual app launch on the dev client required.

## Decision log

### Overrides vs. React bump
`@clerk/react@6.4.1` wants `react@~19.1.4`. Two options:
1. **Override** — force Clerk's transitive deps to accept our pinned `react@19.1.0`
2. **Bump** — upgrade react + react-dom to `~19.1.4`

Chose **overrides** because:
- Expo SDK 54 ships with `react@19.1.0`. Bumping React outside the Expo-blessed range risks subtle incompatibilities with other Expo modules.
- The override is scoped to `@clerk/react` and `@clerk/shared` only — no other packages affected.
- Clerk's peer range `~19.1.4` is a minor patch boundary; 19.1.0 is ABI-compatible. The peer constraint is conservative, not a hard technical requirement.
- If Clerk actually breaks on 19.1.0 at runtime, we'll discover it in Phase 3 testing and can bump then with evidence.

### Podfile.lock refresh
`PurchasesHybridCommon` conflict was pre-existing — the committed Podfile.lock pinned 17.54.0 but `react-native-purchases@^9.15.1` resolved to 9.15.2 (requiring 17.55.1) after `npm install` regenerated the lockfile. Fix: `pod update PurchasesHybridCommon --repo-update` locally.

### react-dom pin
Changed `"react-dom": "^19.1.0"` to `"react-dom": "19.1.0"` to prevent npm from resolving 19.2.5 (which requires `react@^19.2.5`, conflicting with pinned `react@19.1.0`).
