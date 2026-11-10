// Relay for the Tallinn live vehicle feed (Cloudflare Worker).
// transport.tallinn.ee/gps.txt doesn't let web pages on other sites read it,
// so this Worker fetches it and passes it on with a header that allows it.
// Deploy: Cloudflare dashboard > Workers & Pages > your Worker > Edit code,
// paste this file, Deploy. The app calls https://<your-worker>.workers.dev/gps

export default {
  async fetch(request) {
    var headers = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS"
    };
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: headers });
    }
    var upstream = await fetch("https://transport.tallinn.ee/gps.txt", {
      cf: { cacheTtl: 5, cacheEverything: true }
    });
    headers["Content-Type"] =
      upstream.headers.get("Content-Type") || "text/plain; charset=utf-8";
    headers["Cache-Control"] = "no-store";
    return new Response(await upstream.arrayBuffer(), {
      status: upstream.status,
      headers: headers
    });
  }
};
