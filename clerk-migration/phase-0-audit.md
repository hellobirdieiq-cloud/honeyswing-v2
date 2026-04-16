# Phase 0 — Clerk Migration Gate Check + RLS Audit + Integration-Mode Decision

**Date:** 2026-04-15
**Branch:** `clean-release`
**Status:** VALID

---

## Step 1: Pre-reqs

- **Branch:** `clean-release` — confirmed
- **Tag `pre-clerk-migration`:** MISSING. Command to create:
  ```
  git tag pre-clerk-migration
  ```

---

## Step 2: Pre-flight Data Check

| Table | Count |
|-------|-------|
| auth.users | 4 |
| public.coaches | 1 |
| public.swings | 178 |
| public.profiles | 3 |

- No zero counts. All tables populated.
- Note: profiles (3) < users (4) — one user has no profile row. Non-blocking but relevant for user ID migration mapping.

---

## Step 3: Full RLS Audit

### Policy Table

| # | Table | Policy Name | Cmd | Roles | qual / with_check | Uses auth.uid()? | Classification |
|---|-------|-------------|-----|-------|-------------------|-------------------|----------------|
| 1 | coaches | `coaches_own_row` | SELECT | public | `auth.uid() = auth_user_id` | YES | **LIKELY TO BREAK** — stored `auth_user_id` is a Supabase UUID; will not match Clerk user ID without migration |
| 2 | coaches | `users_lookup_coaches_by_code` | SELECT | authenticated | `true` | NO (uses role) | **SAFE** — depends on `authenticated` role claim, not user ID. Third-Party Auth sets this from JWT |
| 3 | grip_analyses | `Users can read own grip analyses` | SELECT | public | `auth.uid() = user_id` | YES | **LIKELY TO BREAK** — same UUID mismatch pattern |
| 4 | profiles | `Users can delete own profile` | DELETE | public | `auth.uid() = id` | YES | **LIKELY TO BREAK** — `id` IS the Supabase UUID (PK = auth.uid()). Tightest coupling |
| 5 | profiles | `Users can insert own profile` | INSERT | public | with_check: `auth.uid() = id` | YES | **LIKELY TO BREAK** — new profiles must use Clerk ID as PK |
| 6 | profiles | `Users can read their own profile` | SELECT | public | `id = auth.uid()` | YES | **LIKELY TO BREAK** |
| 7 | profiles | `Users can update own profile` | UPDATE | public | `auth.uid() = id` | YES | **LIKELY TO BREAK** |
| 8 | profiles | `users_update_own_referral` | UPDATE | public | `auth.uid() = id AND referral_coach_id IS NULL` / with_check: `auth.uid() = id` | YES | **LIKELY TO BREAK** |
| 9 | swings | `Users can delete own swings` | DELETE | public | `auth.uid() = user_id` | YES | **LIKELY TO BREAK** |
| 10 | swings | `Users can insert own swings` | INSERT | public | with_check: `auth.uid() = user_id` | YES | **LIKELY TO BREAK** |
| 11 | swings | `Users can update own swings` | UPDATE | public | `auth.uid() = user_id` / with_check: `auth.uid() = user_id` | YES | **LIKELY TO BREAK** |
| 12 | swings | `Users can view own swings` | SELECT | public | `auth.uid() = user_id` | YES | **LIKELY TO BREAK** |
| 13 | swings | `coaches_read_referral_swings` | SELECT | public | `coach_name IN (SELECT name FROM coaches WHERE auth_user_id = auth.uid())` | YES | **LIKELY TO BREAK** — subquery joins coaches.auth_user_id to auth.uid(); double dependency |

### 3 Most Critical Policies

1. **`coaches_read_referral_swings`** (swings table, SELECT) — Most complex policy. Uses a subquery joining `coaches.auth_user_id` to `auth.uid()`. Two things must align: the `coaches` row's `auth_user_id` AND `auth.uid()` returning the correct Clerk ID. If either is wrong, coaches lose visibility into their students' swings entirely.

2. **`coaches_own_row`** (coaches table, SELECT) — Direct `auth.uid() = auth_user_id` check. If this breaks, the coach cannot read their own coach record, which cascades into `coaches_read_referral_swings` also failing (no coach row found → subquery returns empty → no swings visible).

3. **`Users can insert own profile`** (profiles table, INSERT) — `with_check: auth.uid() = id`. The profiles table uses `auth.uid()` as its PRIMARY KEY. This is the tightest coupling: after migration, new profiles MUST be created with Clerk user IDs as the `id` column. Existing rows (3) must have their PKs updated to Clerk IDs.

### Summary

| Metric | Value |
|--------|-------|
| Total policies | 13 |
| Referencing `auth.uid()` | 12 |
| Referencing `auth.role()` / role-based | 1 (`users_lookup_coaches_by_code`) |
| **Per table:** | |
| — coaches | 2 |
| — grip_analyses | 1 |
| — profiles | 5 |
| — swings | 5 |
| **Complexity rating** | **MEDIUM (13 policies)** |

The good news: every policy follows the same `auth.uid() = <column>` pattern. No exotic JWT claim references, no custom functions, no cross-schema joins beyond the one coach subquery. The migration surface is uniform.

---

## Step 4: Integration-Mode Decision

### Decision: **Option A — Supabase Third-Party Auth**

Clerk as JWT issuer → Supabase validates Clerk JWT → `auth.uid()` returns Clerk's `sub` claim → RLS policies continue working after user ID migration.

### 3 Reasons Option A Wins (Given Our Policies)

1. **All 12 `auth.uid()` policies work unchanged.** `auth.uid()` in Third-Party Auth reads the `sub` claim from the Clerk JWT. After migrating the 4 users' stored IDs (profiles.id, swings.user_id, coaches.auth_user_id, grip_analyses.user_id) from Supabase UUIDs to Clerk user IDs, every policy resolves correctly. Zero policy rewrites.

2. **`coaches_read_referral_swings` keeps its subquery intact.** This is the most complex policy — it joins `coaches.auth_user_id = auth.uid()` inside a subquery. Third-Party Auth makes `auth.uid()` return the Clerk user ID natively, so the subquery works after we update the 1 coach row. No JWT template gymnastics needed.

3. **`users_lookup_coaches_by_code` gets role handling for free.** This policy requires the `authenticated` role. Supabase Third-Party Auth automatically maps the JWT's `role` claim to the Postgres role, so `{authenticated}` is set correctly from the Clerk JWT without manual configuration.

### 2 Reasons Option B (Custom JWT Bridge) Loses

1. **`coaches_own_row` requires the same ID migration as Option A, but adds a failure mode.** With a custom JWT bridge, you maintain a JWT template in Clerk's dashboard AND store the Supabase JWT secret in Clerk. If the JWT template's `sub` mapping is misconfigured, `auth.uid()` silently returns the wrong value. The `coaches_own_row` policy (`auth.uid() = auth_user_id`) silently returns zero rows instead of erroring — the coach sees nothing, with no error to debug.

2. **`Users can insert own profile` (PK = auth.uid()) becomes fragile under a custom bridge.** Profiles use `auth.uid()` as the primary key. With a custom JWT bridge, the `sub` claim in the manually-crafted JWT must EXACTLY match what gets inserted as `id`. One template typo (e.g., `{{user.id}}` vs `{{user.external_id}}`) and the INSERT passes the `with_check` but creates a row with the wrong PK — orphaned from all other tables. Third-Party Auth eliminates this class of misconfiguration because Supabase validates the JWT issuer natively.

---

## Step 5: AASA Verification

### Current AASA File (fetched from https://honeyswing.com/.well-known/apple-app-site-association)

```json
{
  "applinks": {
    "details": [
      {
        "appIDs": ["B3774Z5A69.com.honeyswing.honeyswing-v2"],
        "components": [
          {
            "/": "/r/*",
            "comment": "Coach referral links"
          }
        ]
      }
    ]
  }
}
```

- **appIDs:** `B3774Z5A69.com.honeyswing.honeyswing-v2`
- **Paths:** `/r/*` only (coach referral links)

### Clerk Auth Flow on Expo/React Native

Clerk for Expo uses **custom URL schemes** (e.g., `honeyswing://`) via `expo-web-browser` for OAuth callbacks — NOT universal links. Magic links verify in the browser and session state syncs to the app via Clerk's session management. Clerk does not require AASA/universal links for its core mobile auth flows.

### Verdict: **PASS**

No AASA modifications needed. Clerk's Expo SDK does not use universal links for authentication.

---

## Step 6: Dave Notification

> "Hold off on signup ~1 week, sending you a better link soon."

---

## Final Verification Checklist

| Check | Status |
|-------|--------|
| All SQL queries executed via Supabase MCP (not reasoned) | ✅ 2 queries executed |
| Integration decision references ≥2 named policies | ✅ `coaches_own_row`, `coaches_read_referral_swings`, `Users can insert own profile`, `users_lookup_coaches_by_code` |
| AASA file fetched via WebFetch (not assumed) | ✅ fetched from live URL |

**Output status: VALID**

---

## Next Steps (Phase 1 Scope)

1. Create git tag `pre-clerk-migration`
2. Set up Clerk project + Expo SDK integration
3. Configure Supabase Third-Party Auth with Clerk as JWT issuer
4. Migrate 4 user IDs from Supabase UUIDs → Clerk user IDs across all tables
5. Test all 13 RLS policies against Clerk-authenticated requests
