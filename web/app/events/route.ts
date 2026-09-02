// Same-origin SSE proxy: pipes the collector's event stream so the browser
// never makes a cross-origin local-network request (Chrome gates those).
export const dynamic = "force-dynamic";

const COLLECTOR = process.env.COLLECTOR_URL ?? "http://127.0.0.1:4090";

export async function GET() {
  try {
    const upstream = await fetch(`${COLLECTOR}/events`, { cache: "no-store" });
    if (!upstream.ok || !upstream.body) throw new Error(`upstream ${upstream.status}`);
    return new Response(upstream.body, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  } catch {
    return new Response("collector unreachable — run `npm start` in the repo root\n", {
      status: 502,
    });
  }
}
