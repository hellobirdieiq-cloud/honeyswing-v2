# Open Questions — RevenueCat v1.8 Integration

## [OPEN QUESTION] RevenueCat API Key

The iOS public API key must be obtained from the RevenueCat dashboard (Project Settings → API Keys → iOS). This key is needed for `lib/purchases.ts` Step 2. **Action:** Provide the key before Step 2 begins, or create a RevenueCat project if one doesn't exist yet.

## [OPEN QUESTION] Product & Entitlement IDs

What is the subscription product?
- Product ID in App Store Connect (e.g., `com.honeyswing.pro.monthly`)
- Entitlement identifier in RevenueCat (e.g., `pro` or `unlimited`)
- Offering identifier (e.g., `default`)
- Price point and billing period (e.g., $4.99/month)

**Action:** Create product in App Store Connect + map in RevenueCat dashboard. Can be done in parallel with JS work (Step 14).

## [OPEN QUESTION] Subscription Terms Copy

The paywall screen needs:
- Price string (loaded dynamically from offerings)
- Subscription duration text
- Auto-renewal disclosure (required by App Store)
- Terms of Service and Privacy Policy URLs (required for auto-renewing subscriptions)

**Action:** Provide copy or URLs before Step 9 (paywall SDK wiring).

## [DEVICE-TEST REQUIRED] Sandbox vs Dev Build

Can sandbox purchases be made from an Xcode dev build, or is a TestFlight build required? This affects the feedback loop speed at Step 12.

**Likely answer:** Xcode dev builds can use sandbox with a sandbox Apple ID. TestFlight is not required for sandbox testing. But this must be verified on-device.

## [DEVICE-TEST REQUIRED] StoreKit Configuration File

For simulator testing (before device), a `.storekit` configuration file may be needed. This is optional if testing directly on device.

## [OPEN QUESTION] Paywall UX — "Not Now" Behavior

When a user dismisses the paywall ("Not now"), where should they go?
- Option A: Back to home tab (current plan — `router.replace('/(tabs)')`)
- Option B: Stay on record tab with a reduced experience message

Current plan assumes Option A. Confirm or override.

## [OPEN QUESTION] Coach Tier + Subscription Interaction

Coaches currently get unlimited swings via Supabase query (Section 1b). With RevenueCat, should coaches also bypass the paywall? Current plan: yes — the coach check in `swingLimit.ts` runs after the subscriber check and before the tier limits, so coaches are unaffected regardless of subscription status. **Confirm this is correct behavior.**

## [OPEN QUESTION] Existing User Migration

Users on the 6-week time limit (authenticated, non-coach, non-referred) will hit the paywall when v1.8 ships if their time has expired. Is this the intended behavior, or should there be a grace period?

## [OPEN QUESTION] App Review Notes

First IAP submission. Recommended review notes template:
- How to reach the paywall (record a swing after limit is reached)
- Sandbox test account credentials (if needed)
- Subscription terms location
- Restore purchases location (Settings screen)

**Action:** Draft review notes before Step 16 (submission).
