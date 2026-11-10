// Relay for the Tallinn live vehicle feed.
//
// transport.tallinn.ee/gps.txt doesn't allow web pages on other sites to
// read it, so this Cloudflare Worker fetches it and passes it on with a
// header that does allow it. It only relays that one feed.
//
// Deploy: Cloudflare dashboard > Workers & Pages > Create > Worker,
// replace the code with this file, Deploy. The app then calls
//   https://<your-worker>.workers.dev/gps

const GPS_URL = "https://transport.tallinn.ee/gps.txt";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS"
};

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }
    const path = new URL(request.url).pathname;
    if (request.method !== "GET" || path !== "/gps") {
      return new Response("Not found", { status: 404, headers: CORS });
    }

    let upstream;
    try {
      // Cache for 5 seconds so many open apps don't hit the city's server
      // more often than the feed actually changes.
      upstream = await fetch(GPS_URL, { cf: { cacheTtl: 5, cacheEverything: true } });
    } catch (err) {
      return new Response("Upstream error: " + err.message, { status: 502, headers: CORS });
    }

    return new Response(await upstream.arrayBuffer(), {
      status: upstream.status,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Content-Type": upstream.headers.get("Content-Type") || "text/plain; charset=utf-8",
        "Cache-Control": "no-store"
      }
    });
  },
};
