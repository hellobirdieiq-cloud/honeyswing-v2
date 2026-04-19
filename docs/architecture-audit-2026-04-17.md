# Architecture Follow-Through Audit — 2026-04-17

## Context
Phase 5.6 introduced `jose + createRemoteJWKSet` auth in `delete-account`. `classify-grip` still verifies Clerk JWTs through `supabase.auth.getUser(token)`. Goal: lock the small set of decisions that force future edge-function work to converge, without widening the current blast radius.

## Pre-flight
- `ls supabase/functions/` → `classify-grip`, `delete-account` (exactly 2 functions) [REPO-VERIFIED]
- Master context file with "Section 5 Coding Rules": **not available in repo**. Searched `docs/`, repo root, no `MASTER_CONTEXT.md` / `CONTEXT.md` / `ARCHITECTURE.md` / `coding-rules.md` found. [REPO-VERIFIED — absence]
- All referenced files present: `lib/supabase.ts`, `lib/classifyGrip.ts`, `lib/uploadSwingVideo.ts`, `supabase/functions/delete-account/index.ts`, `supabase/functions/classify-grip/index.ts`, `supabase/config.toml` [REPO-VERIFIED]

---

## Section 1 — High-leverage architecture decisions

### 1. Canonical edge-function auth: `jose + JWKS` (not `supabase.auth.getUser`)
- **Current competing patterns:**
  - `jose.jwtVerify(token, JWKS)` against Clerk JWKS URL [REPO-VERIFIED `supabase/functions/delete-account/index.ts:3,8,62`]
  - `supabase.auth.getUser(token)` with service-role client to validate caller identity [REPO-VERIFIED `supabase/functions/classify-grip/index.ts:435-438`]
- **Rejected alternative:** `supabase.auth.getUser(token)` for Clerk tokens. Loses because it depends on Supabase's Third-Party-Auth (Clerk) configuration in the Supabase dashboard — a config-layer coupling invisible to the code. If the dashboard setting drifts, the call silently returns `user = null` and `userId` becomes `null` [REPO-VERIFIED `classify-grip/index.ts:438`], which in `classify-grip` degrades to "unauthenticated" rather than erroring. `jose + JWKS` is code-owned and fails loudly.
- **Why it creates drift if unresolved:** every future edge function will pick one of the two patterns. Mixed patterns mean every reviewer has to re-prove identity-verification correctness per function and track the Supabase TPA config as a silent dependency.
- **What must converge:** `supabase/functions/classify-grip/index.ts:432-438`; any future `supabase/functions/*/index.ts`; `supabase/functions/*/deno.json` import maps for `jose`.
- **Existing master context rule:** none (no master-context file).
- **Recommendation:** LOCK NOW.
- **Timing:** now (before any third edge function is added).
- **Evidence:** `supabase/functions/delete-account/index.ts:3,7-8,54-76` [REPO-VERIFIED]; `supabase/functions/classify-grip/index.ts:432-439` [REPO-VERIFIED]; Supabase TPA dependency claim [INFERENCE based on absence of Clerk JWKS config in `supabase/config.toml`].

### 2. Shared edge-function scaffolding (CORS + JSON response helper)
- **Current competing patterns:**
  - Named `CORS_HEADERS` constant applied to every response (success, error, preflight) via `jsonResponse()` helper [REPO-VERIFIED `supabase/functions/delete-account/index.ts:10-21,47,51,56,73,75,106,122`]
  - Inline `new Response(JSON.stringify(...), { headers: { 'Content-Type': 'application/json' } })` with CORS headers returned **only** on the `OPTIONS` branch [REPO-VERIFIED `supabase/functions/classify-grip/index.ts:406-412,421,427,498,534,540`]
- **Rejected alternative:** per-function inline responses. Loses because it guarantees a browser-origin caller (future web admin / marketing site / support tool) will hit a CORS failure on any non-preflight `classify-grip` response, and forces each new edge function to re-derive response conventions.
- **Why it creates drift if unresolved:** every new edge function adds another bespoke response shape and another chance for missing CORS headers. Shared helpers are cheapest to establish when there are only 2 functions.
- **What must converge:** a shared module (e.g. `supabase/functions/_shared/http.ts`) imported by both functions; `supabase/functions/classify-grip/index.ts:405-543` response construction.
- **Existing master context rule:** none.
- **Recommendation:** LOCK NOW.
- **Timing:** now, ideally in the same change as Decision 1 (same file, same hands).
- **Evidence:** `supabase/functions/delete-account/index.ts:10-21` [REPO-VERIFIED]; `supabase/functions/classify-grip/index.ts:405-412,418-428,495-500,532-541` [REPO-VERIFIED].

### 3. Edge-function auth policy: required-by-default
- **Current competing patterns:**
  - Required: missing `Authorization` header → `401 missing_auth` before any side effect [REPO-VERIFIED `supabase/functions/delete-account/index.ts:54-57`]
  - Optional: missing header is accepted; request proceeds, and only the logging/storage side effects (`userId` gated) are skipped [REPO-VERIFIED `supabase/functions/classify-grip/index.ts:432-439,447,503`]
- **Rejected alternative:** optional-by-default. Loses because (a) unauthenticated callers still spend Anthropic quota (`classify-grip` calls Claude regardless of auth — [REPO-VERIFIED `classify-grip/index.ts:472-478`]), (b) side-effectful storage writes happen only when authed, creating a split code path that is harder to reason about, (c) "who can call this" becomes per-function tribal knowledge rather than a stated default.
- **Why it creates drift if unresolved:** each future function will re-litigate the required/optional question and likely land inconsistently. A written default makes the exception the thing you justify, not the rule.
- **What must converge:** `supabase/functions/classify-grip/index.ts:432-464` (the optional-auth branch); product decision on whether anonymous grip classification is a feature or an oversight.
- **Existing master context rule:** none.
- **Recommendation:** LOCK NOW (policy); the code change is coupled to Decision 1.
- **Timing:** now — decide the policy, then the classify-grip migration is a single change covering Decisions 1, 2, 3.
- **Evidence:** `supabase/functions/delete-account/index.ts:54-57` [REPO-VERIFIED]; `supabase/functions/classify-grip/index.ts:432-439,447,503` [REPO-VERIFIED]; Claude cost exposure at `classify-grip/index.ts:471-478` [REPO-VERIFIED].

### 4. Client → edge-function transport: raw `fetch` + `AbortController`
- **Current competing patterns:**
  - Raw `fetch` to `${SUPABASE_URL}/functions/v1/<name>` with explicit `AbortController` timeout and manual `apikey` + `Authorization` headers [REPO-VERIFIED `lib/supabase.ts:65-78` (60s), `lib/classifyGrip.ts:58-72` (10s)]
  - `supabase.functions.invoke(...)`: **not used** anywhere in the repo today [REPO-VERIFIED — zero matches in `lib/**`, `app/**`]
- **Rejected alternative:** `supabase.functions.invoke()`. Loses because it hides headers, ties call semantics to the `supabase-js` client's implicit auth wrapper (`clerkFetch` at `lib/supabase.ts:17-25`), and doesn't expose a native `AbortController` — losing the per-call timeout (`10_000ms` for grip, `60_000ms` for delete) that the current raw-fetch pattern uses.
- **Why it creates drift if unresolved:** the supabase client is already in scope at every call site (`import { supabase } from './supabase'`), so the path of least resistance for a future developer is `supabase.functions.invoke` — once introduced, both patterns coexist and timeout guarantees become per-call instead of per-function.
- **What must converge:** any future client-side edge-function caller (e.g. hypothetical `analyze-swing` wrapper); a small helper like `lib/callEdgeFunction.ts` could codify the pattern but is not strictly required.
- **Existing master context rule:** none.
- **Recommendation:** LOCK NOW (pattern; no code change needed today — it's a preventative lock).
- **Timing:** now, before a third edge-function call site is added.
- **Evidence:** `lib/supabase.ts:65-78` [REPO-VERIFIED]; `lib/classifyGrip.ts:58-72` [REPO-VERIFIED]; absence of `functions.invoke` [REPO-VERIFIED via grep].

---

## Section 1 — Self-audit

- **Filter check (multi-file + future-relevant + real inconsistency):**
  - D1: multi-file YES (2 functions + future), real inconsistency YES, future-relevant YES → keep
  - D2: multi-file YES, real inconsistency YES (CORS asymmetry), future-relevant YES → keep
  - D3: multi-file YES, real inconsistency YES (required vs optional), future-relevant YES → keep
  - D4: multi-file YES (future call sites), real inconsistency: **not present today** but high drift risk given `supabase` is already imported at every call site → keep (marked preventative in body)
- **Contradiction check:** none. D1 and D3 both touch classify-grip's auth block but prescribe orthogonal things (mechanism vs policy). D2 is a structural refactor that coincides with the same file edit. D4 is client-side and independent.
- **Padding check:** a 5th candidate (number of `createClient` calls per edge-function request — `classify-grip` creates 3 at lines 435, 449, 505; `delete-account` creates 1 at line 80) was considered and **dropped** — it's a local refactor, not architectural.
- **Section 1 self-audit complete.**

---

## Section 2 — Highest ROI follow-through

**Pick: Decision 1 — Canonical edge-function auth (`jose + JWKS`).**

Why it matters more than the others:
- **It is the only decision with a correctness/security floor.** D2 (scaffolding) is about hygiene; D3 (required-by-default) is a policy whose enforcement *depends on* identity verification being correct first; D4 (client transport) only affects how requests are shaped. D1 determines whether the server can trust *who* is calling — every downstream RLS assumption and every `userId`-gated side effect rests on this.
- **`supabase.auth.getUser(token)` for Clerk JWTs has a silent failure mode** — it returns `user = null` if the Supabase Third-Party-Auth config drifts. In `classify-grip` this silently demotes authed callers to "unauthenticated" and skips the storage/DB writes at `classify-grip/index.ts:447,503` without raising an error. `jose + JWKS` is code-owned and fails loudly. [REPO-VERIFIED + INFERENCE]
- **It sets the template every future edge function will copy.** Locking it now (with 2 functions) costs one file of migration; locking it after a third or fourth function costs proportionally more and forces cross-function reviews.
- **It unblocks D3.** The required-by-default policy is meaningless until the verification mechanism is trustworthy.

---

## Section 3 — Coupling map

### D1 ↔ D3 (auth mechanism ↔ auth policy)
- **Why they must migrate together:** the code change for both is the same block — `classify-grip/index.ts:432-464`. Migrating to `jose + JWKS` without also choosing required vs optional leaves the new code still silently degrading when `Authorization` is absent; choosing "required" without fixing the mechanism leaves `supabase.auth.getUser` as the identity oracle.
- **Migration order:** D1 first *in decision order* (decide the mechanism), D3 locked at the same moment, both land in a single code change. The product answer to "is anonymous grip classification a feature?" is the blocker — once answered, the code write is one pass.

### D1 ↔ D2 (auth ↔ shared scaffolding)
- **Why they should migrate together:** the D1 code edit rewrites the top of `classify-grip`'s `Deno.serve` handler and its error branches. Those error branches are exactly where the CORS / `jsonResponse` asymmetry lives (`classify-grip/index.ts:418-428,495-500,538-541`). Extracting `_shared/http.ts` during the D1 edit is one file touch; doing it later reopens both functions.
- **Migration order:** extract `_shared/http.ts` first (pure refactor of `delete-account` — no behavior change), then D1+D3 land on `classify-grip` already consuming the shared helpers. This is the lowest-risk sequence.

### D4 ↔ {D1, D2, D3}
- **None.** D4 is client-side (`lib/*.ts`); D1/D2/D3 are server-side (`supabase/functions/**`). The client-side raw-fetch pattern works identically regardless of how the server verifies the JWT. D4 can be locked or deferred independently.

---

## Section 4 — Process rules

1. **Every edge function MUST verify the caller's Clerk JWT via `jose` + `createRemoteJWKSet`; `supabase.auth.getUser(token)` is not an acceptable identity check.**
   Derived from: Decision 1.

2. **Every edge function MUST construct responses through a shared `jsonResponse` helper that includes the shared `CORS_HEADERS` on every branch (success, error, preflight); inline `new Response(JSON.stringify(...))` is not permitted.**
   Derived from: Decision 2.

3. **Edge-function auth is required by default — missing or invalid `Authorization` returns 401 before any side effect (Claude calls, storage writes, DB inserts). Optional-auth functions require a written product justification in the function's module doc.**
   Derived from: Decision 3.

(Decision 4 is a pattern lock, not a process rule — no additional rule derived; it is enforced by code review against the existing raw-fetch + `AbortController` template in `lib/supabase.ts:65-78` and `lib/classifyGrip.ts:58-72`.)

---

## Final Verdict

- **Lock now:** D1 (jose+JWKS auth), D2 (shared CORS + `jsonResponse`), D3 (auth required-by-default).
- **Defer:** D4 (client-side raw-fetch transport) — already consistent; lock before the third edge-function call site.
- **Ignore:** per-handler `createClient` instantiation count in `classify-grip` — local cleanup, not architectural.
- **Converge next:** `classify-grip`'s auth block (`supabase/functions/classify-grip/index.ts:432-464`) — one atomic change executes D1 + D2 + D3 together, after extracting `supabase/functions/_shared/http.ts` from `delete-account`.
- **Blocking product input:** is unauthenticated grip classification a supported feature, or an accidental side effect of optional-auth? Answer determines whether D3 removes or guards the anonymous code path.
