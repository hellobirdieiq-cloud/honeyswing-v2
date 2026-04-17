import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.100.0";
import { createRemoteJWKSet, jwtVerify, errors as JoseErrors } from "https://esm.sh/jose@5.9.6";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CLERK_JWKS_URL = "https://blessed-marlin-24.clerk.accounts.dev/.well-known/jwks.json";
const JWKS = createRemoteJWKSet(new URL(CLERK_JWKS_URL));

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

async function deleteAllInPrefix(
  supabase: ReturnType<typeof createClient>,
  bucket: string,
  prefix: string,
): Promise<number> {
  const PAGE = 100;
  let totalRemoved = 0;
  while (true) {
    const { data: files, error: listErr } = await supabase.storage
      .from(bucket)
      .list(prefix, { limit: PAGE, offset: 0 });
    if (listErr) throw new Error(`list_${bucket}_failed: ${listErr.message}`);
    if (!files || files.length === 0) break;
    const paths = files.map((f) => `${prefix}/${f.name}`);
    const { error: removeErr } = await supabase.storage.from(bucket).remove(paths);
    if (removeErr) throw new Error(`remove_${bucket}_failed: ${removeErr.message}`);
    totalRemoved += files.length;
    if (files.length < PAGE) break;
  }
  return totalRemoved;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return jsonResponse({ success: false, error: "method_not_allowed" }, 405);
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return jsonResponse({ success: false, error: "missing_auth" }, 401);
  }
  const token = authHeader.slice(7);

  let userId: string;
  try {
    const { payload } = await jwtVerify(token, JWKS);
    if (!payload.sub) throw new Error("no_sub_claim");
    userId = payload.sub;
  } catch (err) {
    if (
      err instanceof JoseErrors.JWKSNoMatchingKey ||
      err instanceof JoseErrors.JWKSInvalid ||
      err instanceof JoseErrors.JWKSTimeout ||
      err instanceof JoseErrors.JOSENotSupported
    ) {
      console.error("[delete-account] JWKS error:", err);
      return jsonResponse({ success: false, error: "jwks_unavailable" }, 503);
    }
    return jsonResponse({ success: false, error: "invalid_token" }, 401);
  }

  console.log(`[delete-account] start userId=${userId}`);

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    const swingVideosDeleted = await deleteAllInPrefix(supabase, "swing-videos", userId);
    const gripPhotosDeleted = await deleteAllInPrefix(supabase, "grip-photos", userId);

    const { error: gaErr, count: gripAnalysesCount } = await supabase
      .from("grip_analyses")
      .delete({ count: "exact" })
      .eq("user_id", userId);
    if (gaErr) throw new Error(`grip_analyses_delete_failed: ${gaErr.message}`);

    const { error: swErr, count: swingsCount } = await supabase
      .from("swings")
      .delete({ count: "exact" })
      .eq("user_id", userId);
    if (swErr) throw new Error(`swings_delete_failed: ${swErr.message}`);

    const { error: pErr, count: profilesCount } = await supabase
      .from("profiles")
      .delete({ count: "exact" })
      .eq("id", userId);
    if (pErr) throw new Error(`profiles_delete_failed: ${pErr.message}`);

    console.log(`[delete-account] counts sv=${swingVideosDeleted} gp=${gripPhotosDeleted} ga=${gripAnalysesCount} s=${swingsCount} p=${profilesCount}`);

    return jsonResponse(
      {
        success: true,
        deleted: {
          swing_videos: swingVideosDeleted,
          grip_photos: gripPhotosDeleted,
          grip_analyses: gripAnalysesCount ?? 0,
          swings: swingsCount ?? 0,
          profiles: profilesCount ?? 0,
        },
      },
      200,
    );
  } catch (err) {
    console.error("[delete-account] server_error:", err);
    const msg = err instanceof Error ? err.message : String(err);
    return jsonResponse({ success: false, error: "server_error", detail: msg }, 500);
  }
});
