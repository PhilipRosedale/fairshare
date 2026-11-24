import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const LOCATION_UPLOAD_GRANT_SECRET = Deno.env.get("LOCATION_UPLOAD_GRANT_SECRET")!;
const GRANT_TTL_SECONDS = Number(Deno.env.get("LOCATION_UPLOAD_GRANT_TTL_SECONDS") || 30 * 24 * 60 * 60);

type GrantPayload = {
  v: 1;
  sub: string;
  instance_id: string;
  source_platform?: string;
  source_user_agent?: string;
  iat: number;
  exp: number;
};

const encoder = new TextEncoder();
const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-location-upload-grant",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    },
  });
}

function base64url(data: Uint8Array): string {
  let s = "";
  data.forEach((b) => {
    s += String.fromCharCode(b);
  });
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64url(input: string): Uint8Array {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/")
    + "=".repeat((4 - (input.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

async function hmacKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(LOCATION_UPLOAD_GRANT_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function signGrant(payload: GrantPayload): Promise<string> {
  const encodedPayload = base64url(encoder.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(), encoder.encode(encodedPayload));
  return `${encodedPayload}.${base64url(new Uint8Array(sig))}`;
}

async function verifyGrant(token: string): Promise<GrantPayload | null> {
  const [encodedPayload, encodedSig] = token.split(".");
  if (!encodedPayload || !encodedSig) return null;
  const ok = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(),
    decodeBase64url(encodedSig),
    encoder.encode(encodedPayload),
  );
  if (!ok) return null;

  const payload = JSON.parse(new TextDecoder().decode(decodeBase64url(encodedPayload))) as GrantPayload;
  if (payload.v !== 1 || !payload.sub || !payload.instance_id) return null;
  if (payload.exp <= Math.floor(Date.now() / 1000)) return null;
  return payload;
}

function cleanText(value: unknown, max = 500): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, max);
}

function assertFiniteCoordinate(value: unknown, min: number, max: number, name: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`Invalid ${name}`);
  }
  return n;
}

// A device may upload in the background when it owns one of the user's active
// location shares, or, when the user is not sharing at all, when they have
// "Notify if nearby" on for some contact (the nearby check runs in a trigger
// on user_locations). While a share is active only the sharing device may
// upload, so two phones never fight over the row.
async function mayUploadFromInstance(userId: string, instanceId: string): Promise<boolean> {
  const nowIso = new Date().toISOString();
  const { data: shares, error } = await service
    .from("location_shares")
    .select("source_instance_id")
    .eq("from_user_id", userId)
    .or(`expires_at.is.null,expires_at.gt.${nowIso}`);
  if (error) throw error;
  if (shares && shares.length > 0) {
    const bound = shares.filter((s) => s.source_instance_id);
    return bound.length === 0 || bound.some((s) => s.source_instance_id === instanceId);
  }

  const { data: nearby, error: nearbyError } = await service
    .from("contacts")
    .select("contact_id")
    .eq("user_id", userId)
    .eq("notify_nearby", true)
    .limit(1);
  if (nearbyError) throw nearbyError;
  return Boolean(nearby && nearby.length > 0);
}

async function mintGrant(req: Request, body: Record<string, unknown>): Promise<Response> {
  const auth = req.headers.get("Authorization") || "";
  const jwt = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
  if (!jwt) return json({ error: "Missing user session" }, 401);

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false },
  });
  const { data: { user }, error } = await userClient.auth.getUser();
  if (error || !user) return json({ error: "Invalid user session" }, 401);

  const instanceId = cleanText(body.instanceId, 128);
  if (!instanceId) return json({ error: "Missing instanceId" }, 400);
  if (!(await mayUploadFromInstance(user.id, instanceId))) {
    return json({ error: "No active location share or nearby alert for this device" }, 403);
  }

  const now = Math.floor(Date.now() / 1000);
  const payload: GrantPayload = {
    v: 1,
    sub: user.id,
    instance_id: instanceId,
    source_platform: cleanText(body.sourcePlatform, 50),
    source_user_agent: cleanText(body.sourceUserAgent, 500),
    iat: now,
    exp: now + GRANT_TTL_SECONDS,
  };

  return json({
    uploadGrant: await signGrant(payload),
    expiresAt: new Date(payload.exp * 1000).toISOString(),
    uploadUrl: `${SUPABASE_URL}/functions/v1/location-upload`,
  });
}

async function uploadLocation(req: Request, body: Record<string, unknown>): Promise<Response> {
  const grant = req.headers.get("X-Location-Upload-Grant") || cleanText(body.uploadGrant, 4096);
  if (!grant) return json({ error: "Missing upload grant" }, 401);

  const payload = await verifyGrant(grant);
  if (!payload) return json({ error: "Invalid or expired upload grant" }, 401);
  if (!(await mayUploadFromInstance(payload.sub, payload.instance_id))) {
    return json({ error: "No active location share or nearby alert for this device" }, 403);
  }

  const lat = assertFiniteCoordinate(body.lat, -90, 90, "lat");
  const lng = assertFiniteCoordinate(body.lng, -180, 180, "lng");
  const updatedAt = cleanText(body.updated_at, 80) || new Date().toISOString();

  const { error } = await service
    .from("user_locations")
    .upsert({
      user_id: payload.sub,
      lat,
      lng,
      updated_at: updatedAt,
      source_instance_id: payload.instance_id,
      source_platform: payload.source_platform || null,
      source_user_agent: payload.source_user_agent || null,
      location_label: null,
    }, { onConflict: "user_id" });

  if (error) {
    console.error("location upload failed:", error);
    return json({ error: error.message }, 500);
  }

  return json({ ok: true });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!LOCATION_UPLOAD_GRANT_SECRET) return json({ error: "Missing LOCATION_UPLOAD_GRANT_SECRET" }, 500);

  try {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    if (body.action === "grant") return await mintGrant(req, body);
    return await uploadLocation(req, body);
  } catch (e) {
    console.error("location-upload error:", e);
    return json({ error: (e as Error).message || "Location upload failed" }, 500);
  }
});
