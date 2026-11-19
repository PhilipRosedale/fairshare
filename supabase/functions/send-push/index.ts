import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import webpush from "npm:web-push@3.6.7";

const VAPID_SUBJECT = "mailto:admin@fairshare.social";
const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;
const WEB_PUSH_TTL_SECONDS = 24 * 60 * 60;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

/** Remove subscriptions the browser's push service says are gone (404 / 410). */
async function pruneDeadSubscriptions(endpoints: string[]): Promise<number> {
  if (endpoints.length === 0 || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return 0;
  const results = await Promise.allSettled(
    endpoints.map(async (endpoint) => {
      const resp = await fetch(
        `${SUPABASE_URL}/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(endpoint)}`,
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
  return results.filter((r) => r.status === "fulfilled").length;
}

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  }

  try {
    const { subscriptions, title, body, url } = await req.json();

    if (!subscriptions || !Array.isArray(subscriptions) || subscriptions.length === 0) {
      return new Response(JSON.stringify({ sent: 0 }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const payload = JSON.stringify({ title, body, url });
    const options = { TTL: WEB_PUSH_TTL_SECONDS, urgency: "high" as const };

    const results = await Promise.allSettled(
      subscriptions.map((sub: { endpoint: string; keys: { p256dh: string; auth: string } }) =>
        webpush.sendNotification(sub, payload, options)
      )
    );

    const sent = results.filter((r) => r.status === "fulfilled").length;
    const failed = results
      .filter((r) => r.status === "rejected")
      .map((r) => (r as PromiseRejectedResult).reason?.statusCode || "unknown");

    const deadEndpoints = results
      .map((r, i) => ({ r, endpoint: subscriptions[i]?.endpoint as string }))
      .filter(({ r }) => {
        if (r.status !== "rejected") return false;
        const code = (r as PromiseRejectedResult).reason?.statusCode;
        return code === 404 || code === 410;
      })
      .map(({ endpoint }) => endpoint)
      .filter(Boolean);
    const pruned = await pruneDeadSubscriptions(deadEndpoints);

    console.log(
      JSON.stringify({
        sent,
        total: subscriptions.length,
        pruned: pruned || undefined,
        failed: failed.length ? failed : undefined,
      })
    );

    return new Response(JSON.stringify({ sent, total: subscriptions.length, pruned, failed }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("send-push error:", e);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
