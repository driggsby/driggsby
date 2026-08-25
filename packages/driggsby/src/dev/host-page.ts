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
// Both interpolations below are HTML-safe by construction, not by escaping:
// `slug` has passed readProjectConfig's strict slug rules (lowercase
// alphanumerics and dashes only) before runDev ever calls this, and
// `appOrigin` is built by startDevServers from a literal plus a bound port
// number. Anything looser than those two sources must not be passed here.
export function hostPageHtml(slug: string, appOrigin: string): string {
  return `<!doctype html>
<html lang="en" data-app-origin="${appOrigin}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${slug} — driggsby dev</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      display: flex;
      flex-direction: column;
      height: 100vh;
      background: #ffffff;
      color: #1f2430;
      font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
      font-size: 14px;
    }
    header {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      padding: 10px 16px;
      border-bottom: 1px solid #e6e8ec;
    }
    header .slug { font-weight: 600; }
    header .mode { color: #6d7280; font-size: 13px; }
    iframe {
      flex: 1;
      width: 100%;
      border: none;
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
  '    postToApp({ protocol: PROTOCOL, type: "hello" });',
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
