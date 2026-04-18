# Phase 5.6 Handoff — delete-account Edge Function

**Status:** SHIPPED ✅
**Date:** April 17, 2026
**Tag:** `phase-5-6-complete`
**Commits pushed:** `03ee163` (server) + `9a3dd18` (client) on `clean-release`

---

## What shipped

Replaced client-side `deleteAccount` with a service-role edge function (`delete-account`) that verifies Clerk JWTs via jose + JWKS, then deletes all user data (swing-videos, grip-photos, grip_analyses, swings, profiles) with pagination and per-table counts. Client became a thin 60s-timeout fetch wrapper that signs out Clerk only on 200.

## Files touched

| File | Change |
|------|--------|
| `supabase/functions/delete-account/index.ts` | **Created** (124 lines) — jose + JWKS verification, pagination helper, 6-step destructive sequence, structured logging |
| `supabase/functions/delete-account/deno.json` | **Created** — mirrors `classify-grip/deno.json` |
| `supabase/config.toml` | **Appended** `[functions.delete-account]` block at line 408, `verify_jwt = false` |
| `lib/supabase.ts:58-82` | **Modified** — replaced client-side deletes with fetch wrapper + AbortController timeout |

## Critical gotcha — read before adding any Clerk-authenticated edge function

**Supabase platform `verify_jwt = true` does NOT accept Clerk's RS256 JWTs.**

Platform default validates HS256 (project JWT secret). Clerk signs with RS256. Setting `verify_jwt = true` causes gateway to reject valid Clerk tokens with:

```
401 UNAUTHORIZED_UNSUPPORTED_TOKEN_ALGORITHM: Unsupported JWT algorithm RS256
```

**Rule:** For any edge function that accepts Clerk-authenticated requests, set `verify_jwt = false` and handle auth inside the function (jose + JWKS, following `delete-account/index.ts` as template). Do NOT rely on platform-layer JWT verification.

Platform-layer RS256 support may become available if Supabase Third-Party Auth for Clerk is enabled at the project level — not yet done, not planned for Phase 6.

## Architecture decisions locked in this phase

1. **Option B (edge function) over Option A (client+RLS)** — single trusted backend path for destructive ops
2. **Option 3 (jose + JWKS) over probe-first or supabase.auth.getUser** — own the auth verification path
3. **classify-grip stays on supabase.auth.getUser** — no retrofit migration until a second use case forces the consolidation (defer per Playbook Rule 9)
4. **Pagination invariant:** `offset: 0` every iteration, never incremented (`remove()` mutates the set)
5. **Per-table deletion counts in response body** — surfaces silent partial-success failure mode
6. **60s AbortController timeout on client** — prevents unbounded hang on bad network
7. **Commit ordering discipline:** server commit → deploy → client local-only → device test → push both + tag. No atomic push pre-test.

## What's next — roadmap state

Pick from these for the next working session:

| Phase | Goal | Effort | Risk | Blockers |
|-------|------|--------|------|----------|
| **5.5c** | `_layout.tsx` dead code cleanup (dead `getSession`, dead `auth/callback.tsx`) | ~1h | Low | None |
| **.single() cleanup** | Replace `.single()` with `.maybeSingle()` in `referralAttribution.ts` + `swingLimit.ts` coaches read | ~30 min | Low | None |
| **5.5b** | Deep-link routing fix | ~2-3h | **Higher** | Native config, potentially needs rebuild cycle |
| **6** | E2E + cleanup + tag post-Clerk-migration + pre-Clerk UUID grip-photo orphan | ~3-4h | Medium | All above done first |

### Recommended next session

**Start with `.single()` cleanup OR 5.5c** — both are low-risk, mechanical, and fit a 1-2 hour working session. Save 5.5b for a session when you have clean head + native build infrastructure ready.

Do NOT start 5.5b in the same session as any other phase.

## Open watchlist items (N=1, not yet codified)

From V17→V18 House Standard audit — carry forward, codify if they recur:

1. **JWT algorithm × platform auth compatibility** (Rule 33 extension candidate) — 25 min lost this phase. If next edge function hits the same pattern, codify.
2. **AI library-export verification** (Rule 67 extension candidate) — ChatGPT suggested `JWKSFetchError` and `globalThis.Response`, both wrong. If pattern recurs, extend Rule 67 with "verify against published type definitions."
3. **Architecture-locked-before-investigation labeling** (Rule 36 enforcement tightening) — use "GROUND TRUTH" not "HARD CONSTRAINTS" for decisions already made pre-investigation.

## Artifacts saved

- `~/.claude/plans/objective-read-only-investigation-for-declarative-harbor.md` — investigation output (965/1000)
- `~/.claude/plans/objective-implement-phase-5-6-optimized-beaver.md` — implementation plan (978/1000)
- Git tags: `phase-5-5a-complete` (334e3ba), `phase-5-6-complete` (9a3dd18)

## Starter prompt for next session

```
HoneySwing working session.

Repo: ~/Desktop/HoneySwing/honeyswing-v2
Branch: clean-release
Last tag: phase-5-6-complete (9a3dd18)
Master context: HoneySwing_Master_Context_V36.md (project knowledge)

Current state: Clerk auth migration complete through Phase 5.6.
Remaining: Phase 5.5c (_layout.tsx cleanup), .single() cleanup,
Phase 5.5b (deep-link routing, higher risk), Phase 6 (E2E + tag).

Critical Clerk constraint: Any new Supabase edge function that
accepts Clerk-authenticated requests MUST use verify_jwt = false
in supabase/config.toml and handle auth in-function via jose + JWKS.
Template: supabase/functions/delete-account/index.ts.

Task for this session: [specify]
```

## Known unknowns carried forward

- `analyze-swing` deployed at v18 in prod, source absent from repo — unknown auth pattern
- 1 pre-Clerk UUID-prefixed grip-photos object persists as orphan (not cleanable by `delete-account` by design)
- Supabase Third-Party Auth for Clerk at project level still disabled — may allow `verify_jwt = true` for RS256 in future, not scheduled

## Verification you did before closing this session

- ✅ `git status` — clean
- ✅ `git log origin/clean-release..HEAD` — empty (all pushed)
- ✅ Tag `phase-5-6-complete` on origin
- ✅ Device test: all 5 post-delete SQL verification queries returned 0
- ✅ Gates 1, 2, 3 all passed after verify_jwt fix

---

*End of handoff. Open next chat cold with the starter prompt above.*
