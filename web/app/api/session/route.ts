// Same-origin proxy for the collector's per-session detail (browsers gate
// cross-origin local-network requests).
export const dynamic = "force-dynamic";

const COLLECTOR = process.env.COLLECTOR_URL ?? "http://127.0.0.1:4090";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  try {
    const upstream = await fetch(`${COLLECTOR}/api/session?${searchParams}`, {
      cache: "no-store",
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "content-type": "application/json" },
    });
  } catch {
    return new Response(JSON.stringify({ error: "collector unreachable" }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }
}
