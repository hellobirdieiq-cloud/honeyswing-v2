# Phase 1 — Setup Summary

**Status: CONFIG-COMPLETE, RUNTIME-UNVERIFIED**

Do NOT treat Clerk↔Supabase integration as validated until the Phase 3 hard gate passes.

## 1. Clerk application config
- Name: HoneySwing
- Plan: Hobby (free tier)
- Environments: Development (active), Production (not yet configured)
- Sign-in options: Email ONLY (Google, Apple, phone, username, GitHub, Facebook all OFF)
- Primary sign-in method configured in Clerk Development: Email verification code (6-digit OTP)
- Rationale for OTP: eliminates deep-link/PKCE bug class experienced on previous Supabase Auth stack; simpler UX for assisted signup
- Session max lifetime: 90 days (dev only — prod will likely revert to 7 on Hobby)
- Inactivity timeout: OFF
- Multi-session: OFF

## 2. Clerk Frontend API URL (Development)
https://blessed-marlin-24.clerk.accounts.dev

## 3. Supabase Third-Party Auth
- Provider: Clerk
- Status: ENABLED
- Domain configured: https://blessed-marlin-24.clerk.accounts.dev
- Project: xutbbirehugrrbkauhnl (main, production branch)

## 4. Runtime verification DEFERRED to Phase 3

Runtime auth claim verification deferred to first real Clerk-authenticated app request in Phase 3.

**Phase 3 MUST begin with these 3 SQL verifications before any broader app testing.** If any fail → STOP, fix config, do not proceed.

Hard gate tests (run from a Clerk-authenticated Supabase request):
1. `SELECT auth.role();` → must return `'authenticated'`
2. `SELECT auth.jwt()->>'sub';` → must return Clerk user_id (format `user_...`)
3. `SELECT auth.uid();` → must return same Clerk user_id as (2)

Rationale for deferral: generating a Clerk session token without app code requires ~45min of API scaffolding that duplicates Phase 3's real test. Running these SQLs from the first real signed-in app request gives identical assurance with zero scaffolding cost.

## 5. Decision log
- Magic link → OTP: rejected magic link due to PKCE/deep-link bug class experienced on previous Supabase Auth stack
- 90-day session: accepted Clerk's "premium features free in dev" provision; may need Pro ($25/mo) upgrade when Production environment is created if 7-day default is unacceptable
- Wipe-and-reseed chosen over atomic user ID migration (zero real users, zero Track D data)

## 6. Master context updates needed (not making these here — list only)
- Target stack line "Auth: Clerk... handles magic links" → update to "handles email OTP (6-digit code)"
- Add Clerk dev Frontend API URL to Section 1 (Identity)
- Add Phase 1 completion to milestones
- Add "Phase 3 hard gate" to Section 8 (Open Questions / Blocks current work)
