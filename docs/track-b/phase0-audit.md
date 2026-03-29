# Track B Phase 0 Audit — Schema, RLS & Coach Referral Readiness

**Date:** 2026-03-29
**Branch:** v3-dev
**Scope:** Verify existing schema/RLS can support a coaches table, referral_coach_id on profiles, and coach-scoped SELECT on swings.

---

## SECTION 1 — SCHEMA + RLS

### 1. profiles schema

All columns verified from SQL results. 8 columns total.

| column_name    | data_type                   | is_nullable |
| -------------- | --------------------------- | ----------- |
| id             | uuid                        | NO          |
| name           | text                        | YES         |
| age            | integer                     | YES         |
| avatar_url     | text                        | YES         |
| created_at     | timestamp without time zone | YES         |
| coach_name     | text                        | YES         |
| is_left_handed | boolean                     | NO          |
| display_name   | text                        | YES         |

Finding: coach_name is TEXT NULLABLE — a free-text string, not a FK. is_left_handed is the only NOT NULL column besides id.

**Dead columns:** name, age, avatar_url — no code in lib/ or app/ reads or writes these columns. They are leftover from an earlier design. Not a blocker but should be cleaned up eventually.

Evidence: SQL-VERIFIED (provided schema dump). Dead column verification: REPO-VERIFIED (grep -rn 'name\|age\|avatar_url' across lib/ and app/ returns zero writes to profiles for these columns).
Risk: LOW — schema is adequate for current use; PII exposure is an RLS issue, see item 5.

### 2. swings schema

29 columns verified from SQL results. Key columns for Track B:

| column_name | data_type | is_nullable | Notes |
| ----------- | --------- | ----------- | ----- |
| user_id     | uuid      | YES         | NEEDS-VERIFICATION: likely FK to profiles.id but no constraint confirmed |
| coach_name  | text      | YES         | Free-text, set from coachCode.ts hardcoded map |

Finding: user_id is NULLABLE — anonymous inserts can omit it. coach_name is denormalized free text, not a relational FK.
Evidence: SQL-VERIFIED (provided schema dump).
Risk: LOW (schema works for current use).

### 3. RLS policies on swings (3 policies)

| Policy | cmd | qual | with_check |
| ------ | --- | ---- | ---------- |
| Allow anonymous inserts | INSERT | null | true |
| Users can insert own swings | INSERT | null | (auth.uid() = user_id) |
| Users can view own swings | SELECT | (auth.uid() = user_id) | null |

Behavior analysis:

**(a) "Allow anonymous inserts" (INSERT, with_check=true):**
- Authenticated user: CAN insert with any user_id (with_check=true passes all).
- Anonymous user: CAN insert with any user_id — no restriction whatsoever.
- Coach user: Same as authenticated — no coach-specific logic.
- **Note:** This policy makes "Users can insert own swings" redundant — with_check=true OR'd with auth.uid()=user_id means the true policy wins for all callers.
- BLOCKER: DATA LEAK / DATA POLLUTION — Any anonymous caller can insert a swing row with any user_id. An attacker with the anon key can inject fake swing data for real users.

**(b) "Users can insert own swings" (INSERT, with_check=auth.uid()=user_id):**
- Authenticated user: Can insert only where user_id matches their auth.uid().
- Anonymous user: auth.uid() is null, so with_check fails — but this is moot because policy (a) already allows everything.
- Coach user: Same as authenticated.
- Finding: This policy is redundant — the anonymous INSERT policy with with_check=true already permits all inserts.

**(c) "Users can view own swings" (SELECT, qual=auth.uid()=user_id):**
- Authenticated user: Can only see rows where user_id = their auth.uid(). Correct.
- Anonymous user: auth.uid() is null, null = user_id evaluates to null/false — sees nothing. Correct.
- Coach user: Same as authenticated — sees only their own swings. No coach-scoped access exists.
- Finding: This is the only SELECT policy. It is correctly scoped. No cross-user read possible today.

**Missing policies:**
- No UPDATE policy on swings. uploadSwingVideo.ts:37 calls .update() on swings. This silently fails for authenticated users (RLS blocks it). Risk: HIGH — video_storage_path and video_uploaded_at are never persisted.
- No DELETE policy on swings. supabase.ts:43-45 calls .delete() on swings. This silently fails for deleteAccount(). Risk: HIGH — user data not actually deleted.

Risk: HIGH (anonymous INSERT is wide open).
Tag: SQL-VERIFIED

### 4. RLS policies on profiles (8 policies)

| Policy | cmd | qual | with_check |
| ------ | --- | ---- | ---------- |
| Allow anonymous inserts | INSERT | null | true |
| Allow anonymous select | SELECT | true | null |
| Users can insert own profile | INSERT | null | (auth.uid() = id) |
| Users can insert their own profile | INSERT | null | (id = auth.uid()) |
| Users can read their own profile | SELECT | (id = auth.uid()) | null |
| Users can update own profile | UPDATE | (auth.uid() = id) | null |
| Users can update their own profile | UPDATE | (id = auth.uid()) | null |
| Users can view own profile | SELECT | (auth.uid() = id) | null |

Behavior analysis:

**(a) "Allow anonymous select" (SELECT, qual=true):**
- BLOCKER: DATA LEAK — qual=true means ANY request (authenticated or anonymous) can read ALL profiles. This exposes display_name, name, age, coach_name, is_left_handed for every user.
- Anonymous user: Sees all profiles. No auth required.
- Authenticated user: Sees all profiles (this policy OR'd with the user-scoped ones = all).
- Coach user: Sees all profiles.

**(b) "Allow anonymous inserts" (INSERT, with_check=true):**
- BLOCKER: DATA POLLUTION — Any anonymous caller can insert a profile with any id. Could create profiles that collide with or impersonate real auth users.

**(c) Duplicate policies:**
- "Users can insert own profile" and "Users can insert their own profile" — identical logic, different names. Harmless but sloppy.
- "Users can read their own profile" and "Users can view own profile" — identical. Redundant.
- "Users can update own profile" and "Users can update their own profile" — identical. Redundant.

**(d)** UPDATE policies are correctly scoped: auth.uid() = id. Only the profile owner can update.

**(e)** No DELETE policy exists on profiles. See item 16.

Risk: HIGH (anonymous SELECT exposes all PII; anonymous INSERT allows impersonation).
Tag: SQL-VERIFIED

### 5. Anonymous access summary

| Table | Policy | Type | Exposure |
| ----- | ------ | ---- | -------- |
| profiles | Allow anonymous select | SELECT qual=true | ALL profile data readable by anyone |
| profiles | Allow anonymous inserts | INSERT with_check=true | Can insert profile with any id |
| swings | Allow anonymous inserts | INSERT with_check=true | Can insert swing with any user_id |

Finding: Three wide-open policies. The profiles SELECT is the most dangerous — it leaks PII (name, age, display_name) for every user to any anonymous request.
Evidence: RLS policy dump (provided).
Risk: HIGH — BLOCKER: DATA LEAK (profiles SELECT) and BLOCKER: DATA POLLUTION (both INSERT policies).
Tag: SQL-VERIFIED

### 6. service_role usage

| File | Line | Context |
| ---- | ---- | ------- |
| supabase/functions/classify-grip/index.ts | 6 | const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!; |
| supabase/functions/classify-grip/index.ts | 435 | createClient(URL, SERVICE_ROLE_KEY) — auth token verification |
| supabase/functions/classify-grip/index.ts | 449 | createClient(URL, SERVICE_ROLE_KEY) — storage upload |
| supabase/functions/classify-grip/index.ts | 505 | createClient(URL, SERVICE_ROLE_KEY) — grip_analyses INSERT |

Finding: service_role is used only in the Deno edge function (server-side). NOT in any client-side code. lib/supabase.ts uses only the anon key.
Evidence: REPO-VERIFIED (grep results show no service_role in *.ts/*.tsx outside supabase/functions/).
Risk: LOW — correct separation.

### 7. persistSwing.ts — client type

Finding: Uses the anon client. Import chain:
- lib/persistSwing.ts:2 → import { supabase, getUserId } from './supabase'
- lib/supabase.ts:8 → createClient(SUPABASE_URL, SUPABASE_ANON_KEY, ...)

The anon key is hardcoded at lib/supabase.ts:5-6. All client-side DB operations go through this anon client. persistSwing.ts:53-57 guards against missing user: if getUserId() returns null, it returns early and skips the DB write. However, RLS does not enforce this — the anonymous INSERT policy would allow it regardless (defense-in-depth failure).

Evidence: REPO-VERIFIED.
Risk: MEDIUM (code guards against anonymous writes, but RLS doesn't back it up).

---

## SECTION 2 — COUPLING + MIGRATION

### 8. All coach_name references

| File | Line | What it does |
| ---- | ---- | ------------ |
| lib/coachCode.ts | 5-6 | CODE_TO_NAME hardcoded map: { 'dave': 'Dave Donnellan' } |
| lib/coachCode.ts | 9-24 | get/set/clear/resolve functions for AsyncStorage coach code |
| lib/persistSwing.ts | 7 | Imports getCoachCode, resolveCoachName from coachCode |
| lib/persistSwing.ts | 60-61 | Resolves coach code → coach name before insert |
| lib/persistSwing.ts | 81 | Writes coach_name: coachName ?? null to swings row |
| app/onboarding.tsx | 19 | COACH_OPTIONS = ['Dave Donnellan', 'No coach'] — hardcoded UI picker |
| app/onboarding.tsx | 38 | Resolves coach selection: coach === 'No coach' ? null : coach |
| app/onboarding.tsx | 42 | Writes coach_name: coachName to profiles row |

Finding: Coach identity is entirely string-based. Two separate paths write coach_name:
1. Onboarding writes the display name directly to profiles.coach_name.
2. persistSwing resolves a code from AsyncStorage via a hardcoded map, writes to swings.coach_name.

There is no relational link between these. The string "Dave Donnellan" in profiles and swings is the only connection.
Tag: REPO-VERIFIED

### 9. Coupling analysis — if profiles.coach_name → referral_coach_id (UUID FK)

| File | Line | Impact | Classification |
| ---- | ---- | ------ | -------------- |
| app/onboarding.tsx | 42 | Must change to write UUID instead of string | HIGH — logic fails |
| app/onboarding.tsx | 19, 38 | Hardcoded COACH_OPTIONS and string comparison | HIGH — logic fails |
| lib/coachCode.ts | entire file | CODE_TO_NAME map becomes obsolete | HIGH — logic fails |
| lib/persistSwing.ts | 60-61, 81 | Writes coach_name to swings. If kept as denormalized snapshot, only resolution logic changes | MEDIUM — refactor |
| app/analysis/result.tsx | 245-249 | Coach chip display | LOW — display only |
| app/settings.tsx | 35 | AsyncStorage cleanup | LOW — cleanup |

Finding: 3 HIGH files, 1 MEDIUM, 2 LOW. The onboarding flow and coachCode module are the primary coupling. persistSwing can remain unchanged if swings.coach_name is kept as denormalized.
Tag: REPO-VERIFIED

### 10. Would adding referral_coach_id to profiles break existing INSERT/UPDATE?

- **If NULLABLE:** No breakage. Existing onboarding INSERT (app/onboarding.tsx:51-55) does not include referral_coach_id, so it defaults to NULL. Safe.
- **If NOT NULL:** BREAKS onboarding. The upsert does not supply this column. Every new user signup fails with a NOT NULL violation.

Verdict: referral_coach_id MUST be NULLABLE.
Tag: REPO-VERIFIED

### 11. Would a new coach SELECT policy on swings conflict with existing policies?

Proposed policy:
```sql
CREATE POLICY "Coaches can view referral swings" ON swings
FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM profiles p
    WHERE p.id = swings.user_id
    AND p.referral_coach_id = auth.uid()
  )
);
```

OR-widening analysis:
- Regular user: sees only own swings (existing policy). New policy adds nothing. No widening. Correct.
- Coach who is also a user: sees own swings (existing) + referral swings (new). Intentional widening. Correct.
- Anonymous user: auth.uid() is null. EXISTS returns false. No widening. Correct.
- Coach A vs Coach B: Coach A's auth.uid() only matches profiles with referral_coach_id = Coach A's UUID. Cannot see Coach B's referrals. Correct.

Finding: The OR-widening is intentional and safe.
Risk: LOW if implemented as above. BLOCKER: ACCESS VIOLATION if implemented without the profiles join.
Tag: SQL-VERIFIED (analysis)

### 12. FK constraints on profiles

Finding: No FK constraints observed in the schema dump. profiles.id is UUID PK. Adding referral_coach_id UUID REFERENCES coaches(id) requires coaches table to exist first. Migration order: CREATE coaches → ALTER profiles.

**NEEDS-VERIFICATION:** The profiles.id → auth.users(id) FK is expected (standard Supabase pattern) but not confirmed from the schema dump. Run this to confirm:
```sql
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'profiles'::regclass;
```

Risk: LOW.
Tag: SQL-VERIFIED (schema), NEEDS-VERIFICATION (FK constraints — run query above)

---

## SECTION 3 — FAILURE MODES (execution order)

### Failure chain if Track B ships without fixes

```
1. referral_coach_id added to profiles → immediately world-readable via anonymous SELECT
2. Coach signs up → coach row created → no issue
3. User scans QR → referral_coach_id written → anonymous caller can see who referred whom
4. Coach queries dashboard → sees referral swings → correct
5. Anonymous caller queries profiles → sees all referral_coach_id values → DATA LEAK
```

**The anonymous SELECT on profiles is the first and most critical failure. It fires the moment the column exists, before any user action.**

### 13. What breaks for anonymous users if we add a coaches table?

Nothing breaks. Anonymous users cannot SELECT swings (no anon SELECT policy). The coaches table itself would have its own RLS. Anonymous INSERT policies on swings and profiles remain unchanged (pre-existing issue).
Risk: LOW. Tag: SQL-VERIFIED

### 14. What breaks if referral_coach_id is NOT NULL vs NULLABLE?

**NOT NULL — breaks FIRST:**
1. ALTER TABLE fails on existing rows (no default value)
2. Onboarding INSERT at app/onboarding.tsx:51 fails — row doesn't include referral_coach_id
3. Every new user signup is bricked

**NULLABLE — nothing breaks.** Existing rows get NULL. Onboarding continues to work.

Verdict: NULLABLE is the only safe option.
Tag: REPO-VERIFIED

### 15. Can Coach A see Coach B's referral swings?

With the proposed policy from item 11:
```
EXISTS (
  SELECT 1 FROM profiles p
  WHERE p.referral_coach_id = auth.uid()
  AND p.id = swings.user_id
)
```

Coach A's auth.uid() → matches only profiles with referral_coach_id = Coach A's UUID → only those users' swings. Coach B's referral users have a different referral_coach_id. Coach A CANNOT see Coach B's referral swings.

Risk: LOW if implemented correctly. BLOCKER if policy omits the profiles join.
Tag: SQL-VERIFIED (logic analysis)

### 16. Missing RLS policies — operation inventory

| Operation | Table | Code Location | RLS Policy Exists? | Status |
| --------- | ----- | ------------- | ------------------ | ------ |
| INSERT | swings | lib/persistSwing.ts:89 | YES (anonymous + user) | Covered (but anonymous is too permissive) |
| SELECT | swings | lib/swingLimit.ts:43-46 | YES (user-scoped) | Covered |
| UPDATE | swings | lib/uploadSwingVideo.ts:37 | NO | BLOCKER: SILENT FAILURE — video metadata never persisted |
| DELETE | swings | lib/supabase.ts:43-45 | NO | BLOCKER: SILENT FAILURE — delete account broken |
| INSERT/UPSERT | profiles | app/onboarding.tsx:51-55 | YES (anonymous + user) | Covered (but anonymous is too permissive) |
| SELECT | profiles | (implicit via onboarding upsert) | YES (anonymous + user) | BLOCKER: world-readable |
| UPDATE | profiles | app/onboarding.tsx:51 (upsert) | YES (user-scoped) | Covered |
| DELETE | profiles | lib/supabase.ts:48-52 | NO | BLOCKER: SILENT FAILURE — delete account broken |

3 operations are silently failing in production due to missing RLS policies.
Tag: REPO-VERIFIED + SQL-VERIFIED

---

## SECTION 4 — VERDICT

### Five Questions

1. **Is swings data secure today?** PARTIALLY — SELECT is correctly scoped to user_id, but anonymous INSERT allows data poisoning with arbitrary user_id values, and missing UPDATE/DELETE policies cause silent failures.
2. **Is profiles data secure today?** NO — "Allow anonymous select" with qual=true exposes ALL profile data to any anonymous caller with the embedded anon key.
3. **What is the single biggest risk for Track B?** The anonymous SELECT on profiles — adding referral_coach_id would leak which coach each user is associated with to any anonymous caller.
4. **What must be fixed BEFORE Track B proceeds?** Drop all 3 anonymous permissive policies. Add UPDATE policy on swings. Add DELETE policies on swings and profiles.
5. **What should Rafael test first on a real device?** Call deleteAccount() and verify data is actually removed from the database — it almost certainly isn't (no DELETE RLS policies exist).

---

## BLOCKERS

### BLOCKER 1: DATA LEAK — profiles anonymous SELECT (CRITICAL)
```sql
DROP POLICY "Allow anonymous select" ON profiles;
```
**Verify:** From a logged-out Supabase client or curl with only the anon key, run `SELECT * FROM profiles`. Should return zero rows.

### BLOCKER 2: DATA INTEGRITY — profiles anonymous INSERT
```sql
DROP POLICY "Allow anonymous inserts" ON profiles;
```
**Verify:** From a logged-out client, attempt `INSERT INTO profiles (id, display_name) VALUES (gen_random_uuid(), 'fake')`. Should fail with RLS violation.

### BLOCKER 3: DATA INTEGRITY — swings anonymous INSERT
```sql
DROP POLICY "Allow anonymous inserts" ON swings;
```
**Verify:** From a logged-out client, attempt `INSERT INTO swings (user_id) VALUES (gen_random_uuid())`. Should fail with RLS violation.

### BLOCKER 4: SILENT FAILURE — missing UPDATE on swings
```sql
CREATE POLICY "Users can update own swings" ON swings
  FOR UPDATE USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
```
**Verify:** Record a swing, upload a video, then check Supabase: `SELECT id, video_storage_path FROM swings ORDER BY created_at DESC LIMIT 1`. video_storage_path should now be non-null.

### BLOCKER 5: SILENT FAILURE — missing DELETE on swings
```sql
CREATE POLICY "Users can delete own swings" ON swings
  FOR DELETE USING (auth.uid() = user_id);
```
**Verify:** In the app, delete account. Then check Supabase: `SELECT * FROM swings WHERE user_id = '<your-uuid>'`. Should return zero rows.

### BLOCKER 6: SILENT FAILURE — missing DELETE on profiles
```sql
CREATE POLICY "Users can delete own profile" ON profiles
  FOR DELETE USING (auth.uid() = id);
```
**Verify:** After delete account, check Supabase: `SELECT * FROM profiles WHERE id = '<your-uuid>'`. Should return zero rows.

### CLEANUP (non-blocking): Remove duplicate policies
```sql
DROP POLICY "Users can insert their own profile" ON profiles;
DROP POLICY "Users can view own profile" ON profiles;
DROP POLICY "Users can update their own profile" ON profiles;
```

---

## GO / NO-GO

**NO-GO** — Fix Blockers 1-6 before adding any coach referral infrastructure. Track B would inherit and amplify these pre-existing vulnerabilities. The profiles anonymous SELECT leak is the most critical — it fires the moment referral_coach_id exists on the table.

---

## Self-check

- [x] What is live vs dead code? — All coach_name code is live. profiles.name, profiles.age, profiles.avatar_url are dead columns.
- [x] Where does Track B attach? — New coaches table, new referral_coach_id on profiles, new SELECT policy on swings.
- [x] What fails first? — Anonymous SELECT on profiles exposes referral_coach_id the moment the column is added.
- [x] What should the developer test first? — deleteAccount() → verify rows actually deleted.
- [x] Each finding stated once? — Yes, referenced by section number elsewhere.
