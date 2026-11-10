// Shared network helper: fetch that explains *why* it failed.

// When a request fails before any answer arrives, send a "no-cors" probe,
// which the browser lets through without letting us read the answer.
// If the probe gets through, the server is reachable and the browser
// blocked our real request (CORS). If it also fails, it's the network.
async function diagnose(url, err) {
  let probe;
  try {
    await fetch(url, { mode: "no-cors", cache: "no-store" });
    probe = "server reachable → browser blocked the request (CORS)";
  } catch {
    probe = "server not reachable from this page";
  }
  const host = new URL(url).host;
  return new Error(`${err.name}: ${err.message} | ${probe} | ${host}`);
}

export async function fetchChecked(url, options = {}) {
  let res;
  try {
    res = await fetch(url, options);
  } catch (err) {
    throw await diagnose(url, err);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} from ${new URL(url).host}: ${text.slice(0, 200)}`);
  }
  return res;
}
