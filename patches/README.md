# patches/

## @clerk+expo+3.7.1.patch — keep GoogleSignIn out of the iOS build

*Re-rolled from 3.2.8 → 3.7.1 (2026-07-07, T2-20 Clerk bump) following the
procedure below: `podspecPath` pin re-applied AND `ClerkGoogleSignInModule`
removed from the new `apple.modules` array (the 3.6.x note case). Android
modules untouched, matching the original patch's scope. Autolinking re-verified:
resolves the single `ClerkExpo` pod.*

**What it does.** Adds the `apple.podspecPath` key to `@clerk/expo`'s
`expo-module.config.json`, pinning Expo autolinking to `ios/ClerkExpo.podspec`,
and removes `ClerkGoogleSignInModule` from `apple.modules` so the generated
modules provider doesn't reference a Swift module whose pod isn't linked.

**Why it exists.** `@clerk/expo` ships two podspecs (`ClerkExpo.podspec` and
`ClerkGoogleSignIn.podspec`) but its shipped `expo-module.config.json` declares
no `podspecPath`. When that key is absent, `expo-modules-autolinking` falls
back to globbing **every** `*.podspec` in the package
(`build/platforms/apple/apple.js` → `findPodspecFiles`), so `use_expo_modules!`
links `ClerkGoogleSignIn` too, dragging in the whole Google chain:
`GoogleSignIn → AppAuth, AppCheckCore, GTMAppAuth, GTMSessionFetcher,
GoogleUtilities, RecaptchaInterop` (~8 pods), plus the modular-headers
extraPods workaround that used to live in app.json solely to make that chain
compile.

HoneySwing is **email-only Clerk auth**: nothing imports `@clerk/expo/google`
or `google-one-tap`, so the entire chain was dead weight. With `podspecPath`
pinned, autolinking resolves exactly one pod (`ClerkExpo`) and the chain
disappears from Podfile.lock.

**Why patch-package (and not a config plugin or Podfile hook).** The patch
must be in effect whenever `pod install` runs, and this repo's documented
workflow runs `pod install` directly (see CLAUDE.md) — not always via
`expo prebuild`. patch-package applies on every `npm install` (postinstall),
which is upstream of every pod install path (local, prebuild, EAS). Its
failure mode is the right one: if a Clerk upgrade changes the file, the
install **fails loudly** instead of silently re-linking Google.

**Re-roll procedure on @clerk/expo upgrades.**
1. `npm install @clerk/expo@<new>` — expect patch-package to fail; that is the signal.
2. Inspect `node_modules/@clerk/expo/expo-module.config.json`.
3. Re-apply the intent: pin `apple.podspecPath` to the core podspec.
   ⚠️ **3.6.x note:** newer versions declare an `apple.modules` array that
   includes `ClerkGoogleSignInModule`. There you must ALSO remove
   `ClerkGoogleSignInModule` (and its Android twin
   `expo.modules.clerk.googlesignin.ClerkGoogleSignInModule` if trimming
   Android) from the modules list — otherwise the modules provider references
   a Swift module whose pod is no longer linked.
4. `npx patch-package @clerk/expo` to regenerate the patch file; delete the old one.
5. Re-run validation: autolinking resolve shows a single `ClerkExpo` pod;
   `pod install`; grep Podfile.lock for `GoogleSignIn|AppAuth|GTM|Recaptcha`
   (must be empty); build; email sign-in.

**Deletion trigger.** If a future `@clerk/expo` release adds a correct
`apple.podspecPath` (or otherwise stops autolinking `ClerkGoogleSignIn`),
delete this patch instead of re-rolling it. When you do, also remove the
`postinstall` script and the `patch-package` devDependency if this is the last
patch. Verify with the same validation steps.

**Known residue (accepted).** RN codegen (`ClerkExpoSpec`) still generates the
TurboModule *interface* for the Google spec — inert with no native
implementation, since email-only code paths never require it. The Android
build still bundles Clerk's Google ID libraries (`androidx.credentials:…`,
`…googleid`) — deliberately out of scope for this patch.
