// app-handoff: lets someone who is logged in on union42.net open the iOS app
// already logged in, right after installing it.
//
// The website calls this (with the user's own session) just before sending
// them to the App Store. We mint a one-time magic-link token for *that same
// user* and return only its hash. The website copies
// https://union42.net/?handoff=<token_hash> to the clipboard; on first launch
// the app reads it and calls auth.verifyOtp({ type: 'magiclink', token_hash }).
//
// Safety:
// - Requires a valid user JWT; the token is only ever for the caller.
// - Single use, and it expires with the project's email OTP lifetime (1 hour
//   by default).
// - No email is sent (admin.generateLink only creates the token).
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const ALLOWED_ORIGINS = new Set([
  "https://union42.net",
  "https://app.fairshare.social",
  "http://localhost:3000",
]);

function cors(origin: string | null): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://union42.net",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors(origin) },
  });
}

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

serve(async (req) => {
  const origin = req.headers.get("Origin");
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(origin) });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405, origin);

  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "not_signed_in" }, 401, origin);

  // Who is asking? Validate the caller's own session.
  const asUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userErr } = await asUser.auth.getUser();
  const user = userData?.user;
  if (userErr || !user) return json({ error: "not_signed_in" }, 401, origin);
  if (!user.email) return json({ error: "no_email_on_account" }, 400, origin);

  const { data, error } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: user.email,
  });
  const tokenHash = data?.properties?.hashed_token;
  if (error || !tokenHash) {
    console.error("app-handoff generateLink failed:", error?.message);
    return json({ error: "could_not_create_handoff" }, 500, origin);
  }
  return json({ token_hash: tokenHash }, 200, origin);
});
