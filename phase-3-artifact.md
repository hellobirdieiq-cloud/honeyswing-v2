# HoneySwing Clerk Migration — Phase 3 Artifact

**Phase:** 3 (3B + 3C)
**Completed:** April 16, 2026
**Branch:** `clean-release`
**Starting tag:** `phase-3a-complete` (commit `f088dee`)
**Closing tag:** `phase-3-complete`

---

## 1. Scope Completed

### Phase 3B — Delete PKCE scaffolding from `app/_layout.tsx`

Removed:
- `extractCodeFromUrl` helper
- `pkceSessionEstablished` module-level flag
- `exchangeWithTimeout` function
- `handleAuthUrl` function (entire body was PKCE-only, per plan verification)
- Cold-start PKCE call (`if (initialUrl) await handleAuthUrl(initialUrl)`)
- Warm-start PKCE branch (`if (url.includes('code=')) { … }`)
- `pkceSessionEstablished = true` write inside `SIGNED_IN` handler

Preserved:
- `ClerkProvider` mount
- `/r/` referral URL handling (`handleReferralUrl` + `commitPendingReferral`)
- `resetNavigationLock` wiring
- Deep link subscription (`Linking.addEventListener` / `Linking.getInitialURL`)
- Supabase `onAuthStateChange` effect (minus the deleted flag write)

Comment updates (two stale references corrected to match new behavior):
- `"magic link or referral link"` → `"referral link"` (cold-start comment)
- `"magic link while app is already open"` → `"deep links while app is already open"` (warm-start comment)

### Phase 3C — Rewrite `app/settings.tsx` auth with Clerk

Removed:
- `useState<string | null>(null)` for `userEmail`
- Supabase `getSession` call inside `useFocusEffect` (only that line; wrapper, `useCallback`, dep array, and three non-auth loaders untouched)
- Entire `useEffect` block subscribing to `onAuthStateChange`
- `supabase.auth.signOut()` in handler
- `supabase` from the named import (kept `deleteAccount`)
- `useEffect` from React imports (no longer used)

Added:
- `import { useUser, useAuth } from '@clerk/expo'`
- `const { user, isLoaded, isSignedIn } = useUser()`
- `const { signOut } = useAuth()`
- `const email = user?.primaryEmailAddress?.emailAddress ?? null`
- Three-branch render: `!isLoaded → ActivityIndicator` → `isSignedIn → email + Sign Out` → `else → Not signed in + Sign In`
- Sign-out navigates to `/signin` (was `/(tabs)`)

Style changes: **zero** — reused existing `signInButton`, `signInText`, `signOutButton`, `signOutText`, `coachLabel`, `coachStatus`, `accountSection`.

---

## 2. Key Decisions Locked in Phase 3

1. **Render gate discipline** — Settings Account section gates on `isLoaded` first. `isSignedIn` is the sole authority for signed-in state. Email renders conditionally inside the signed-in branch (`email ?? 'Signed in'`) so a null email never demotes the user to "Not signed in."

2. **Sign-out route target** — Post-`signOut()`, navigate to `/signin` (not `/(tabs)`). Rationale: signing out inside Settings should not drop the user back on tabs content they can no longer meaningfully use.

3. **Sign-out order** — `await signOut()` must complete before `router.replace('/signin')`. Never reordered. Wrapped in try/catch/finally with `signingOut` state gating the button.

4. **Deletion-only scope enforcement** — 3B and 3C both executed as deletion-only (plus additive Clerk hook calls in 3C). No renames, no restructures. One scope-drift attempt in 3C Edit 7 (introducing `styles.accountLoading`) was caught pre-approval and reverted to the approved inline style.

5. **Warm-start `/r/` behavior change accepted** — Post-3B, warm deep links unconditionally flow through `handleReferralUrl` then `router.replace('/(tabs)')`. The pre-3B `code=` early-return no longer exists. Safe because `handleReferralUrl` self-filters to `/r/` URLs (verified at `lib/referralAttribution.ts:73`) and no code path in the repo produces new `code=` URLs post-Clerk migration.

---

## 3. Verification

### Code-layer
- `npx tsc --noEmit` — clean after 3B ✓
- `npx tsc --noEmit` — clean after 3C ✓
- No unused-import warnings

### Device (physical iPhone)
- **3B boot test:** app launches cleanly, no PKCE-related crashes, Metro bundle includes all imports ✓
- **Test 1 — Existing-user sign-in:** sign out → `/signin` → OTP → tabs → Settings shows email ✓
- **Test 2 — `/r/` warm start (`https://honeyswing.com/r/rafael`):** deep link routed successfully, Settings rendered correctly, **known issue**: "Not signed in" error modal on coach linking (see §4)
- **Test 3 — `/r/` cold start (same URL):** app opened cold from link, flow completed. Metro black-screen glitches observed during test but classified as Metro flakiness, not app bug; will re-verify against TestFlight build.

### Lessons captured
- Physical device stale-bundle bug: after JS changes, `npx expo start --clear` alone did not force the phone to pick up the new bundle. Required full app delete + `npx expo run:ios --device` rebuild to see Phase 3C changes on device. This cost a diagnostic detour mid-3C verification.

---

## 4. Known Issues — Deferred to Later Phases

### Coach linking throws "Not signed in" on Clerk sessions

**Symptom:** Warm-start `/r/<code>` deep link routes correctly, but coach attribution path raises a "Not signed in" error modal over Settings.

**Root cause hypothesis:** `lib/referralAttribution.ts` (likely inside `linkCoach` or `commitPendingReferral`) still queries Supabase with an assumed Supabase-native auth context. Per the Phase 3A locked decision, Clerk user IDs are not UUIDs — `auth.uid()` returns empty; RLS must read `auth.jwt()->>'sub'`. The referral library has not been migrated.

**Scope:** Phase 5 (`lib/referralAttribution.ts` is a Phase 5-scoped file per handoff §5 hard constraint #3).

**Impact:** Settings auth display, sign-in/out, and deep-link routing all work correctly. The modal is non-blocking (dismiss with OK). Referral attribution likely not being stored for Clerk users until Phase 5.

---

## 5. Hard Constraints Preserved

Every constraint from the handoff was preserved:

1. `lib/supabase.ts` — not modified ✓ (Phase 4)
2. `lib/referralAttribution.ts` — not modified ✓ (Phase 5)
3. `lib/migrateAnonSwings.ts` — not modified ✓ (Phase 5)
4. `lib/navigationLock.ts` — not modified ✓
5. Database schema / RLS policies — not modified ✓
6. `app/signin.tsx` — not modified ✓ (Phase 3A locked)
7. `/r/` referral URL handling — intact in `_layout.tsx` ✓
8. Non-PKCE, non-auth logic — intact ✓

---

## 6. Files Changed

- `app/_layout.tsx` — 3B deletions
- `app/settings.tsx` — 3C Clerk migration + sign-out redirect change

No other files touched.

---

## 7. Handoff to Next Phase

Next phases per master context:
- **Phase 4** — migrate `lib/supabase.ts` usage patterns (unblocked; Phase 3 did not touch this)
- **Phase 5** — migrate `lib/referralAttribution.ts` + `lib/migrateAnonSwings.ts` to Clerk-aware auth context; resolves the coach-linking known issue from §4
