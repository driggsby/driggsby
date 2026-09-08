// The dev host page: what a browser shows at the host origin. It embeds the
// app from the app origin in a cross-origin iframe and speaks the host side
// of the frozen driggsby-sdk/1 protocol — exactly the topology the deployed
// app lives in, so an app that works under `driggsby dev` works identically
// inside Driggsby. The page carries no token and no data; every tool call
// goes to the CLI's own /tool-calls endpoint, which holds the token and
// enforces the allowlist and bounds.

// The page's script is served as its own file so the page can carry a
// Content-Security-Policy with no inline scripts.
//
// All interpolations below are HTML-safe by construction, not by escaping:
// `slug` has passed readProjectConfig's strict slug rules (lowercase
// alphanumerics and dashes only) before runDev ever calls this,
// `appOrigin` is built by startDevServers from a literal plus a bound port
// number, and `background` has passed readProjectConfig's strict hex-color
// rule (or is null). Anything looser than those sources must not be
// passed here.
export function hostPageHtml(slug: string, appOrigin: string, background: string | null): string {
  return `<!doctype html>
<html lang="en" data-app-origin="${appOrigin}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${slug} — driggsby dev</title>
  <style>
    /* The strip above the frame is the console's title row, in its own
       measured values: 46px tall on the black ground, 14px ink, a 14%
       white hairline under it. */
    * { box-sizing: border-box; }
    body {
      margin: 0;
      display: flex;
      flex-direction: column;
      height: 100vh;
      color-scheme: dark;
      background: #000000;
      color: #fafafa;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      font-size: 14px;
      line-height: 21px;
      -webkit-font-smoothing: antialiased;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      height: 46px;
      padding: 0 16px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.14);
    }
    header .slug { font-weight: 500; }
    header .mode { color: #a1a1a1; }
    iframe {
      flex: 1;
      width: 100%;
      border: none;
      /* The app's declared background from driggsby.json, painted while
         the app loads — the same surface the production host shows. */
      background: ${background ?? "#000000"};
    }
  </style>
</head>
<body>
  <header>
    <span class="slug">${slug}</span>
    <span class="mode">driggsby dev — your live data</span>
  </header>
  <iframe id="app" src="${appOrigin}/" sandbox="allow-scripts allow-same-origin allow-forms"></iframe>
  <script type="module" src="/host.js"></script>
</body>
</html>
`;
}

// The host-side protocol runtime. Kept dependency-free and template-free so
// nothing needs escaping: this string is served verbatim as /host.js.
export const HOST_PAGE_JS = [
  'const PROTOCOL = "driggsby-sdk/1";',
  "const APP_ORIGIN = document.documentElement.dataset.appOrigin;",
  'const frame = document.getElementById("app");',
  "",
  "// The app's in-page location (a URL fragment), mirrored into this",
  "// page's own URL and handed back in the hello — the same route sync",
  "// the production host does, same strict shape on both sides.",
  "const APP_ROUTE_PATTERN = /^#[A-Za-z0-9\\/\\-._]{1,256}$/;",
  "",
  "function sanitizeAppRoute(value) {",
  '  return typeof value === "string" && APP_ROUTE_PATTERN.test(value) ? value : "";',
  "}",
  "",
  "let appRoute = sanitizeAppRoute(window.location.hash);",
  "",
  "// URL writes are bounded because the frame controls their rate, but",
  "// ordinary clicking should not feel the bound — a token bucket does",
  "// both, matching the production host: a flurry of up to 15",
  "// navigations writes instantly, sustained clicking faster than one",
  "// per 600ms then paces at 600ms, and a frame spamming routes drains",
  "// the bucket and degrades to paced trailing writes that still land",
  "// the final state. Burst (15) plus refills (one per 600ms = 50 per",
  "// 30s) tops out at 65 writes per 30s, leaving at least ~35 of",
  "// Safari's ~100-per-30s per-document replaceState budget for the",
  "// host page's own writes. Keep these two constants identical to the",
  "// production host's; nothing pins them across the two codebases.",
  "const ROUTE_WRITE_BUCKET_CAPACITY = 15;",
  "const ROUTE_WRITE_REFILL_MS = 600;",
  "let routeTokens = ROUTE_WRITE_BUCKET_CAPACITY;",
  "let routeLastRefillMs = Date.now();",
  "let routeWriteTimer = null;",
  "",
  "function refillRouteTokens() {",
  "  const now = Date.now();",
  "  // A backward clock step would otherwise strand the refill mark in",
  "  // the future and stall every write until the clock caught back up.",
  "  if (now < routeLastRefillMs) {",
  "    routeLastRefillMs = now;",
  "  }",
  "  const earned = Math.floor((now - routeLastRefillMs) / ROUTE_WRITE_REFILL_MS);",
  "  if (earned < 1) {",
  "    return;",
  "  }",
  "  routeTokens = Math.min(ROUTE_WRITE_BUCKET_CAPACITY, routeTokens + earned);",
  "  routeLastRefillMs += earned * ROUTE_WRITE_REFILL_MS;",
  "}",
  "",
  "function takeRouteToken() {",
  "  refillRouteTokens();",
  "  if (routeTokens < 1) {",
  "    return false;",
  "  }",
  "  routeTokens -= 1;",
  "  return true;",
  "}",
  "",
  "function routeRetryDelayMs() {",
  "  refillRouteTokens();",
  "  if (routeTokens >= 1) {",
  "    return 1;",
  "  }",
  "  const sinceRefill = Date.now() - routeLastRefillMs;",
  "  return Math.min(ROUTE_WRITE_REFILL_MS, Math.max(1, ROUTE_WRITE_REFILL_MS - sinceRefill));",
  "}",
  "",
  "function writeRouteToUrl() {",
  "  if (window.location.hash === appRoute) {",
  "    return;",
  "  }",
  '  const base = window.location.href.split("#")[0];',
  "  try {",
  '    history.replaceState(history.state, "", base + appRoute);',
  "  } catch (error) {",
  "    // A refused write costs only URL freshness; the next one retries.",
  "  }",
  "}",
  "",
  "function scheduleTrailingRouteWrite() {",
  "  routeWriteTimer = setTimeout(() => {",
  "    routeWriteTimer = null;",
  "    if (takeRouteToken()) {",
  "      writeRouteToUrl();",
  "    } else {",
  "      // The clock can land a hair before the token accrues; wait out",
  "      // the remainder rather than writing over budget.",
  "      scheduleTrailingRouteWrite();",
  "    }",
  "  }, routeRetryDelayMs());",
  "}",
  "",
  "function applyRoute(hash) {",
  "  appRoute = hash;",
  "  if (routeWriteTimer !== null) {",
  "    return; // the trailing write reads appRoute",
  "  }",
  "  // Already mirrored: nothing to write, no token spent on nothing.",
  "  if (window.location.hash === hash) {",
  "    return;",
  "  }",
  "  if (takeRouteToken()) {",
  "    writeRouteToUrl();",
  "    return;",
  "  }",
  "  scheduleTrailingRouteWrite();",
  "}",
  "",
  "function postToApp(message) {",
  "  if (frame.contentWindow) {",
  "    frame.contentWindow.postMessage(message, APP_ORIGIN);",
  "  }",
  "}",
  "",
  "// Only the embedded app may speak: right window, right origin, our",
  "// protocol marker.",
  "function messageFromApp(event) {",
  "  return (",
  "    event.origin === APP_ORIGIN &&",
  "    event.source === frame.contentWindow &&",
  "    typeof event.data === \"object\" &&",
  "    event.data !== null &&",
  "    event.data.protocol === PROTOCOL",
  "  );",
  "}",
  "",
  "async function runToolCall(id, tool, params) {",
  "  const body = JSON.stringify({ tool: tool, arguments: params });",
  "  let payload = null;",
  "  try {",
  '    const response = await fetch("/tool-calls", {',
  '      method: "POST",',
  '      headers: { "Content-Type": "application/json" },',
  "      body: body,",
  "    });",
  "    payload = await response.json();",
  "  } catch (error) {",
  "    payload = null;",
  "  }",
  "  if (payload && payload.ok === true) {",
  '    postToApp({ protocol: PROTOCOL, type: "result", id: id, result: payload.result });',
  "    return;",
  "  }",
  "  const message =",
  "    payload && payload.error && typeof payload.error.message === \"string\"",
  "      ? payload.error.message",
  '      : "We couldn\'t run that just now. Try again in a moment.";',
  '  postToApp({ protocol: PROTOCOL, type: "result", id: id, error: { message: message } });',
  "}",
  "",
  'window.addEventListener("message", (event) => {',
  "  if (!messageFromApp(event)) {",
  "    return;",
  "  }",
  "  const data = event.data;",
  '  if (data.type === "ready") {',
  "    const hello = { protocol: PROTOCOL, type: \"hello\" };",
  '    if (appRoute !== "") {',
  "      hello.route = appRoute;",
  "    }",
  "    postToApp(hello);",
  "    return;",
  "  }",
  '  if (data.type === "route") {',
  '    // A bare "#" is the explicit cleared sentinel: the app is back at',
  "    // its no-hash location, so the page URL drops its fragment.",
  '    if (data.hash === "#") {',
  '      applyRoute("");',
  "      return;",
  "    }",
  "    const hash = sanitizeAppRoute(data.hash);",
  '    if (hash === "") {',
  "      return;",
  "    }",
  "    applyRoute(hash);",
  "    return;",
  "  }",
  '  if (data.type !== "call") {',
  "    return;",
  "  }",
  "  // Same shape rules as the production host: a bounded string id, a",
  "  // bounded string tool name, and params degrading to an empty object.",
  "  const id = data.id;",
  "  const tool = data.tool;",
  '  if (typeof id !== "string" || id.length === 0 || id.length > 64) {',
  "    return;",
  "  }",
  '  if (typeof tool !== "string" || tool.length === 0 || tool.length > 128) {',
  "    return;",
  "  }",
  "  const params =",
  '    typeof data.params === "object" && data.params !== null && !Array.isArray(data.params)',
  "      ? data.params",
  "      : {};",
  "  runToolCall(id, tool, params);",
  "});",
  "",
  "// The CLI announces served-file changes; the app reloads itself on",
  "// new-version, exactly as it would after a deploy.",
  'const events = new EventSource("/events");',
  'events.addEventListener("change", () => {',
  '  postToApp({ protocol: PROTOCOL, type: "new-version" });',
  "});",
  "",
].join("\n");
