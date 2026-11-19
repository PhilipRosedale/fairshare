import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import {
  encode as base64url,
} from "https://deno.land/std@0.177.0/encoding/base64url.ts";

const APNS_KEY_P8 = Deno.env.get("APNS_KEY_P8")!;
const APNS_KEY_ID = Deno.env.get("APNS_KEY_ID")!;
const APNS_TEAM_ID = Deno.env.get("APNS_TEAM_ID")!;
const APNS_TOPIC = Deno.env.get("APNS_TOPIC") || "social.fairshare.union";
const APNS_HOST = Deno.env.get("APNS_HOST") || "https://api.push.apple.com";
const APNS_JWT_REFRESH_SKEW_SECONDS = 60;
const APNS_JWT_TTL_SECONDS = 3500;
const APNS_SANDBOX_HOST = "https://api.sandbox.push.apple.com";
const APNS_PRIORITY_IMMEDIATE = "10";
// How long Apple and Google hold a push for a phone that is asleep or offline.
// With 0, Apple tried once and threw the push away if the phone didn't answer.
const PUSH_TTL_SECONDS = 24 * 60 * 60;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const DEFAULT_PUSH_TITLE = "Union";
const FCM_PROJECT_ID = Deno.env.get("FCM_PROJECT_ID") || "";
const FCM_CLIENT_EMAIL = Deno.env.get("FCM_CLIENT_EMAIL") || "";
const FCM_PRIVATE_KEY = (Deno.env.get("FCM_PRIVATE_KEY") || "").replace(/\\n/g, "\n");
const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const FCM_TOKEN_URL = "https://oauth2.googleapis.com/token";
const FCM_CHANNEL_ID = "default";

type DevicePushToken = {
  token: string;
  platform?: string;
};

// Thrown when Apple or Google says a token will never work again, so the
// caller can remove it from device_push_tokens.
class DeadTokenError extends Error {
  token: string;
  constructor(token: string, message: string) {
    super(message);
    this.token = token;
  }
}

async function postToApns(host: string, token: string, jwt: string, payload: string) {
  const resp = await fetch(`${host}/3/device/${token}`, {
    method: "POST",
    headers: {
      authorization: `bearer ${jwt}`,
      "apns-topic": APNS_TOPIC,
      "apns-push-type": "alert",
      "apns-priority": APNS_PRIORITY_IMMEDIATE,
      "apns-expiration": String(Math.floor(Date.now() / 1000) + PUSH_TTL_SECONDS),
    },
    body: payload,
  });
  if (resp.ok) return { ok: true, status: resp.status, reason: "", text: "" };
  const text = await resp.text();
  let reason = "";
  try {
    reason = JSON.parse(text).reason || "";
  } catch (_) { /* not JSON */ }
  return { ok: false, status: resp.status, reason, text };
}

/** Remove tokens Apple or Google reported as permanently invalid. */
async function pruneDeadTokens(tokens: string[]): Promise<number> {
  if (tokens.length === 0 || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return 0;
  const results = await Promise.allSettled(
    tokens.map(async (token) => {
      const resp = await fetch(
        `${SUPABASE_URL}/rest/v1/device_push_tokens?token=eq.${encodeURIComponent(token)}`,
        {
          method: "DELETE",
          headers: {
            apikey: SUPABASE_SERVICE_ROLE_KEY,
            authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          },
        }
      );
      if (!resp.ok) throw new Error(`prune ${resp.status}: ${await resp.text()}`);
    })
  );
  const failed = results.filter((r) => r.status === "rejected");
  if (failed.length) {
    console.warn("pruneDeadTokens failures:", failed.map((r) => (r as PromiseRejectedResult).reason?.message));
  }
  return results.length - failed.length;
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const lines = pem
    .split("\n")
    .filter((l) => !l.startsWith("-----") && l.trim() !== "");
  const raw = Uint8Array.from(atob(lines.join("")), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    raw,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
}

let cachedToken: { jwt: string; exp: number } | null = null;
let cachedFcmAccessToken: { token: string; exp: number } | null = null;

async function getApnsJwt(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.exp > now + APNS_JWT_REFRESH_SKEW_SECONDS) return cachedToken.jwt;

  const header = base64url(
    new TextEncoder().encode(
      JSON.stringify({ alg: "ES256", kid: APNS_KEY_ID })
    )
  );
  const exp = now + APNS_JWT_TTL_SECONDS;
  const claims = base64url(
    new TextEncoder().encode(
      JSON.stringify({ iss: APNS_TEAM_ID, iat: now, exp })
    )
  );
  const signingInput = new TextEncoder().encode(`${header}.${claims}`);
  const key = await importPrivateKey(APNS_KEY_P8);
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    signingInput
  );
  const jwt = `${header}.${claims}.${base64url(new Uint8Array(sig))}`;
  cachedToken = { jwt, exp };
  return jwt;
}

async function importFcmPrivateKey(pem: string): Promise<CryptoKey> {
  const lines = pem
    .split("\n")
    .filter((l) => !l.startsWith("-----") && l.trim() !== "");
  const raw = Uint8Array.from(atob(lines.join("")), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    raw,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

async function getFcmAccessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedFcmAccessToken && cachedFcmAccessToken.exp > now + APNS_JWT_REFRESH_SKEW_SECONDS) {
    return cachedFcmAccessToken.token;
  }

  if (!FCM_CLIENT_EMAIL || !FCM_PRIVATE_KEY) {
    throw new Error("Missing FCM_CLIENT_EMAIL or FCM_PRIVATE_KEY");
  }

  const header = base64url(
    new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" }))
  );
  const exp = now + APNS_JWT_TTL_SECONDS;
  const claims = base64url(
    new TextEncoder().encode(
      JSON.stringify({
        iss: FCM_CLIENT_EMAIL,
        scope: FCM_SCOPE,
        aud: FCM_TOKEN_URL,
        iat: now,
        exp,
      })
    )
  );
  const signingInput = new TextEncoder().encode(`${header}.${claims}`);
  const key = await importFcmPrivateKey(FCM_PRIVATE_KEY);
  const sig = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    signingInput
  );
  const assertion = `${header}.${claims}.${base64url(new Uint8Array(sig))}`;

  const resp = await fetch(FCM_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  if (!resp.ok) {
    throw new Error(`FCM OAuth ${resp.status}: ${await resp.text()}`);
  }

  const data = await resp.json();
  cachedFcmAccessToken = {
    token: data.access_token,
    exp: now + Number(data.expires_in || APNS_JWT_TTL_SECONDS),
  };
  return cachedFcmAccessToken.token;
}

async function sendApnsPush(
  tokens: DevicePushToken[],
  title: string,
  body: string,
  url: string,
): Promise<PromiseSettledResult<void>[]> {
  if (tokens.length === 0) return [];

  let jwt: string;
  try {
    jwt = await getApnsJwt();
  } catch (e) {
    return tokens.map(() => ({
      status: "rejected",
      reason: e,
    } as PromiseRejectedResult));
  }
  const payload = JSON.stringify({
    aps: {
      alert: { title: title || DEFAULT_PUSH_TITLE, body: body || "" },
      sound: "default",
      "mutable-content": 1,
    },
    url: url || "/",
  });

  return Promise.allSettled(
    tokens.map(async (t) => {
      let res = await postToApns(APNS_HOST, t.token, jwt, payload);
      // Builds installed straight from Xcode get a sandbox token, which the
      // production host rejects as BadDeviceToken. Try the sandbox host before
      // giving up, so dev builds and TestFlight / App Store builds all get pushes.
      if (!res.ok && res.status === 400 && res.reason === "BadDeviceToken" && APNS_HOST !== APNS_SANDBOX_HOST) {
        res = await postToApns(APNS_SANDBOX_HOST, t.token, jwt, payload);
      }
      if (res.ok) return;
      const message = `APNs ${res.status}: ${res.text}`;
      if (res.status === 410 || (res.status === 400 && res.reason === "BadDeviceToken")) {
        throw new DeadTokenError(t.token, message);
      }
      throw new Error(message);
    })
  );
}

async function sendFcmPush(
  tokens: DevicePushToken[],
  title: string,
  body: string,
  url: string,
): Promise<PromiseSettledResult<void>[]> {
  if (tokens.length === 0) return [];
  if (!FCM_PROJECT_ID) {
    return tokens.map(() => ({
      status: "rejected",
      reason: new Error("Missing FCM_PROJECT_ID"),
    } as PromiseRejectedResult));
  }

  let accessToken: string;
  try {
    accessToken = await getFcmAccessToken();
  } catch (e) {
    return tokens.map(() => ({
      status: "rejected",
      reason: e,
    } as PromiseRejectedResult));
  }
  const endpoint = `https://fcm.googleapis.com/v1/projects/${FCM_PROJECT_ID}/messages:send`;

  return Promise.allSettled(
    tokens.map(async (t) => {
      const resp = await fetch(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: {
            token: t.token,
            notification: {
              title: title || DEFAULT_PUSH_TITLE,
              body: body || "",
            },
            data: {
              url: url || "/",
            },
            android: {
              priority: "HIGH",
              ttl: `${PUSH_TTL_SECONDS}s`,
              notification: {
                channel_id: FCM_CHANNEL_ID,
                sound: "default",
              },
            },
          },
        }),
      });
      if (!resp.ok) {
        const text = await resp.text();
        const message = `FCM ${resp.status}: ${text}`;
        if (resp.status === 404 || text.includes("UNREGISTERED")) {
          throw new DeadTokenError(t.token, message);
        }
        throw new Error(message);
      }
    })
  );
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  }

  try {
    const { tokens, title, body, url } = await req.json();

    if (!tokens || !Array.isArray(tokens) || tokens.length === 0) {
      return new Response(JSON.stringify({ sent: 0 }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const deviceTokens = tokens as DevicePushToken[];
    const iosTokens = deviceTokens.filter((t) => t.platform !== "android");
    const androidTokens = deviceTokens.filter((t) => t.platform === "android");
    const [apnsResults, fcmResults] = await Promise.all([
      sendApnsPush(iosTokens, title, body, url),
      sendFcmPush(androidTokens, title, body, url),
    ]);
    const results = [...apnsResults, ...fcmResults];

    const sent = results.filter((r) => r.status === "fulfilled").length;
    const failed = results
      .filter((r) => r.status === "rejected")
      .map((r) => (r as PromiseRejectedResult).reason?.message || "unknown");

    const deadTokens = results
      .filter((r) => r.status === "rejected" && (r as PromiseRejectedResult).reason instanceof DeadTokenError)
      .map((r) => ((r as PromiseRejectedResult).reason as DeadTokenError).token);
    const pruned = await pruneDeadTokens(deadTokens);

    console.log(
      JSON.stringify({
        sent,
        total: tokens.length,
        apns: iosTokens.length,
        fcm: androidTokens.length,
        pruned: pruned || undefined,
        failed: failed.length ? failed : undefined,
      })
    );

    return new Response(
      JSON.stringify({
        sent,
        total: tokens.length,
        apns: { total: iosTokens.length },
        fcm: { total: androidTokens.length },
        pruned,
        failed,
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("send-push-apns error:", e);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
