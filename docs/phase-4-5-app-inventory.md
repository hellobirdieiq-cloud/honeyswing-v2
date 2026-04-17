# Phase 4.5 — App-Code Inventory (Clerk ↔ Supabase)

Ground-truth audit of how the HoneySwing app code uses Supabase Postgres tables and Storage, for use when planning the uuid→text + RLS migration. Every claim cites `file:line`. Derived from static code inspection only — does NOT describe the live DB schema, which lives in the remote Supabase project until `supabase db pull` is run.

## 1. Tables touched

### `profiles`

| Op | Columns written / read / filtered | Call site |
|---|---|---|
| upsert | writes `display_name`, `coach_name`, `is_left_handed`, optional `id` (Clerk string when authenticated); reads `id` | `app/onboarding.tsx:64` |
| select | reads `referral_coach_id`; filters `.eq('id', user.id)` (Clerk id) | `lib/swingLimit.ts:70` |
| select | reads `anonymous_swing_count`; filters `.eq('id', user.id)` (Clerk id) | `lib/swingLimit.ts:114` |
| select | reads `referral_coach_id`; filters `.eq('id', userId)` (Clerk id) | `lib/referralAttribution.ts:28` |
| update | writes `referral_coach_id = coach.id` (coach UUID); filters `.eq('id', userId)` | `lib/referralAttribution.ts:57` |
| select | reads `referral_coach_id`; filters `.eq('id', userId)` | `lib/referralAttribution.ts:100` |
| update | writes `referral_coach_id = coach.id`; filters `.eq('id', userId)` | `lib/referralAttribution.ts:110` |
| update | writes `referral_coach_id = null`; filters `.eq('id', userId)` | `lib/referralAttribution.ts:126` |
| delete | filters `.eq('id', userId)` (Clerk id) | `lib/supabase.ts:76` |
| update | filters `.eq('id', userId)` | `lib/migrateAnonSwings.ts:15` |

### `swings`

| Op | Columns written / read / filtered | Call site |
|---|---|---|
| insert | writes `user_id`, `motion_frames`, `frame_count`, `duration_ms`, `score`, `honey_boom`, `angles`, `tempo`, `phases`, `backswing_ms`, `downswing_ms`, `tempo_ratio`, `pose_success_rate`, `phase_source`, `failure_reason`, `capture_validity`, `app_version`, `coach_name`, `swing_debug`; reads `id` | `lib/persistSwing.ts:100` |
| select (count) | filters `.eq('user_id', user.id)` (Clerk id) | `lib/swingLimit.ts:95` |
| select | reads `swing_debug`; filters `.eq('id', swingId)` (swings.id UUID) | `app/analysis/result.tsx:85` |
| update | writes `video_storage_path`, `video_uploaded_at`; filters `.eq('id', swingId)` | `lib/uploadSwingVideo.ts:35` |
| delete | filters `.eq('user_id', userId)` (Clerk id) | `lib/supabase.ts:70` |

### `coaches`

| Op | Columns written / read / filtered | Call site |
|---|---|---|
| select | reads `id`; filters `.eq('auth_user_id', user.id)` (Clerk id) | `lib/swingLimit.ts:81` |
| select | reads `id`, `name`; filters `.eq('code', pendingCode)` | `lib/referralAttribution.ts:43` |
| select | reads `id`, `code`, `name`; filters `.eq('code', normalized)` | `lib/referralAttribution.ts:92` |

### `grip_analyses` (edge function only — server-side)

| Op | Columns written | Call site |
|---|---|---|
| insert | writes `id` (UUID), `user_id` (Clerk id), `model_name`, `classification`, `storage_bucket`, `storage_path` | `supabase/functions/classify-grip/index.ts:506` |

## 2. User-ID columns requiring uuid → text conversion

| Table | Column | Reason |
|---|---|---|
| `profiles` | `id` (PK) | Receives Clerk id string from `getUserId()` at `app/onboarding.tsx:64`, `lib/swingLimit.ts:70,114`, `lib/referralAttribution.ts:28,57,100,110,126`, `lib/supabase.ts:76`, `lib/migrateAnonSwings.ts:15`. Cast `user_<27chars>` → `uuid` is the reported failure. |
| `swings` | `user_id` (FK → `profiles.id`) | Insert at `lib/persistSwing.ts:100` passes Clerk id. Filter at `lib/swingLimit.ts:95` and `lib/supabase.ts:70` use Clerk id. FK must migrate in lockstep with `profiles.id`. |
| `coaches` | `auth_user_id` | `lib/swingLimit.ts:81` does `.eq('auth_user_id', user.id)` with Clerk id to detect coach accounts. |
| `grip_analyses` | `user_id` | `supabase/functions/classify-grip/index.ts:508` inserts Clerk id string. |

## 3. Columns that remain uuid

| Table | Column | Why it stays uuid |
|---|---|---|
| `swings` | `id` (PK) | Server-generated; app reads it back at `lib/persistSwing.ts:100` `.select('id')` and passes it as `swingId` at `lib/uploadSwingVideo.ts:35` and `app/analysis/result.tsx:85`. Never compared to a Clerk id. |
| `coaches` | `id` (PK) | Referenced by `profiles.referral_coach_id` via FK. Set from server-generated UUID at `lib/referralAttribution.ts:45,93` (read), written to profiles at `lib/referralAttribution.ts:57,110`. Never a user identifier. |
| `profiles` | `referral_coach_id` (FK → `coaches.id`) | Stores a coach UUID, not a user id. Compared against `coach.id` (UUID) at `lib/referralAttribution.ts:105`. Set null at `lib/referralAttribution.ts:126`. |
| `grip_analyses` | `id` (PK) | Server-generated per analysis at `supabase/functions/classify-grip/index.ts:506`. Embedded in storage path as `${analysisId}.jpg` — not a user identifier. |

## 4. Storage buckets and path conventions

### `swing-videos`

- Path format: `${userId}/${swingId}.mov` — `userId` is Clerk id string, `swingId` is `swings.id` UUID
- Upload (RN app): `lib/uploadSwingVideo.ts:20-27` via `FileSystem.uploadAsync` to `https://xutbbirehugrrbkauhnl.supabase.co/storage/v1/object/swing-videos/${storagePath}` with Bearer token + API key, `Content-Type: video/quicktime`
- Post-upload row update: `lib/uploadSwingVideo.ts:35-40` writes `video_storage_path`, `video_uploaded_at` on `swings`
- List (on account delete): `lib/supabase.ts:62` — `.storage.from('swing-videos').list(userId)`
- Remove (on account delete): `lib/supabase.ts:64-66` — `.storage.from('swing-videos').remove(files.map(f => \`${userId}/${f.name}\`))`

### `grip-photos`

- Path format: `${userId}/${analysisId}.jpg` — `userId` is Clerk id string, `analysisId` is `grip_analyses.id` UUID
- Upload (edge function, service-role key): `supabase/functions/classify-grip/index.ts:452-454` — `.storage.from('grip-photos').upload(path, imageBytes, { contentType: 'image/jpeg', upsert: false })`
- No RN-side list/remove path discovered — verified via grep of `app/` and `lib/` for `grip-photos` (no hits outside the edge function).

## 5. Clerk ID source per call site

| Call site | How Clerk id is obtained | Value |
|---|---|---|
| `app/onboarding.tsx:49` → `app/onboarding.tsx:64` (profiles upsert) | `getUserId()` from `lib/supabase.ts` | Clerk `user.id` string |
| `lib/swingLimit.ts:70` (profiles select) | `getUser()` → `user.id` (`lib/supabase.ts:37-44`) | Clerk `user.id` |
| `lib/swingLimit.ts:81` (coaches select) | `getUser()` → `user.id` | Clerk `user.id` |
| `lib/swingLimit.ts:95` (swings count) | `getUser()` → `user.id` | Clerk `user.id` |
| `lib/swingLimit.ts:114` (profiles select anonymous_swing_count) | `getUser()` → `user.id` | Clerk `user.id` |
| `lib/referralAttribution.ts:24` → uses at `:28, :57` | `getUserId()` (`lib/supabase.ts:54-56`) | Clerk `user.id` |
| `lib/referralAttribution.ts:88` → uses at `:100, :110` | `getUserId()` | Clerk `user.id` |
| `lib/referralAttribution.ts:122` → uses at `:126` | `getUserId()` | Clerk `user.id` |
| `lib/persistSwing.ts:51` → `:100` (swings insert) | `getUserId()` | Clerk `user.id` |
| `lib/uploadSwingVideo.ts:5` → `:20` (storage upload path) | `getUserId()` | Clerk `user.id` |
| `lib/supabase.ts:59` → `:62, :70, :76` (deleteAccount) | `getUserId()` local call | Clerk `user.id` |
| `lib/supabase.ts:81` (Clerk signOut) | `getClerkInstance()` | Clerk instance |
| `app/settings.tsx:32` | `useUser()` hook → `{ user, isLoaded, isSignedIn }` | Clerk `user.id` via React hook |
| `app/settings.tsx:33` | `useAuth()` hook → `{ signOut }` | n/a (session control) |
| `supabase/functions/classify-grip/index.ts:508` (server) | Derived from request JWT on the edge function | Clerk `user.id` string |

Internal resolver chain on the RN side:
- `getClerkInstance().user?.id` is the single source
- Wrapped by `getUserId()` (`lib/supabase.ts:54-56`)
- Wrapped by `getUser()` (`lib/supabase.ts:37-44`)
- Wrapped by `getSession()` (`lib/supabase.ts:46-52`)

## 6. deleteAccount flow analysis

Source: `lib/supabase.ts:58-82`. Invoked from `app/settings.tsx` (see `app/settings.tsx:162-170` for local-cache clear that follows).

Step order:

1. `lib/supabase.ts:59` — `const userId = await getUserId()` (Clerk id)
2. `lib/supabase.ts:62` — `supabase.storage.from('swing-videos').list(userId)` — enumerate video files under the user's folder
3. `lib/supabase.ts:64-66` — `supabase.storage.from('swing-videos').remove(files.map(f => \`${userId}/${f.name}\`))` — bulk delete
4. `lib/supabase.ts:70-73` — `supabase.from('swings').delete().eq('user_id', userId)`
5. `lib/supabase.ts:75-79` — `supabase.from('profiles').delete().eq('id', userId)`
6. `lib/supabase.ts:81` — `getClerkInstance().signOut()`
7. `app/settings.tsx:162-170` — clears AsyncStorage keys: `onboardingComplete`, `profileId`, `isLeftHanded`, `coachCode`, `pendingReferralCode`, `subscriptionStatus`, `ageTier`

### Surfaced gaps (analysis only — not fixed here)

- **Missing cleanup: `grip_analyses` rows.** No call to `.from('grip_analyses').delete()` exists anywhere in `app/` or `lib/` (verified via grep for `grip_analyses` in RN code — only hit is the edge-function file at `supabase/functions/classify-grip/index.ts:506`). Rows created on behalf of the user will persist after account deletion unless the DB has an `ON DELETE CASCADE` from `profiles(id) → grip_analyses(user_id)`, which cannot be verified until the schema is pulled.
- **Missing cleanup: `grip-photos` storage.** No call to `storage.from('grip-photos').list(...).remove(...)` exists in the delete-account path (`lib/supabase.ts:58-82`) or anywhere else in `app/`/`lib/` (verified via grep for `grip-photos`). Objects under `${userId}/*.jpg` will remain in the bucket after account deletion.

## 7. Critical files to re-read on resume

Paths are repo-relative.

- `lib/supabase.ts` — Clerk JWT bridge (Phase 4); `deleteAccount` at `:58-82`; `getUser`/`getSession`/`getUserId` at `:37-56`; debug RPC at `:93`. **Do not modify in Phase 4.5.**
- `lib/persistSwing.ts` — swing insert shape at `:100`; Clerk-id source at `:51`
- `lib/swingLimit.ts` — tier logic at `:70-72`, `:81-85`, `:94-97`, `:113-117`
- `lib/referralAttribution.ts` — commit/link/unlink flows at `:28-58`, `:91-112`, `:122-128`
- `lib/uploadSwingVideo.ts` — storage upload at `:12-27`; row update at `:35-40`
- `lib/migrateAnonSwings.ts` — profiles update filter at `:15`
- `app/onboarding.tsx` — profiles upsert row at `:60-64`
- `app/analysis/result.tsx` — swing_debug read at `:85`
- `app/settings.tsx` — deleteAccount caller and AsyncStorage clear at `:162-170`; Clerk hooks at `:32-33`
- `supabase/functions/classify-grip/index.ts` — server-side `grip_analyses` insert at `:506-508`; grip-photos upload at `:452-454`
- `supabase/config.toml` — `schema_paths = []` confirms no locally-tracked schema (root cause of the Phase 4.5 plan blocker)
- `supabase/migrations/` — **expected to be populated by `supabase db pull` before Phase 4.5 SQL can be written**
