// The security headers on every app-origin response, the service worker
// the app origin hands out, and the policy the host page requires of its
// frame: a copy of what Driggsby's serving host and console do for a
// deployed app, so the preview refuses what a deployed app is refused and a
// page that works here works once deployed. The Driggsby service is
// canonical: change it there first, then mirror it here.
//
// The content security policy keeps the page's loads on its own origin
// (another site's script, font, image, or fetch is refused), refuses frames,
// objects, forms, and eval, and sandboxes the page as the serving host does.
// frame-ancestors names the host page, the only page that may frame the
// app. A file that can run script (a page, an SVG, JavaScript) also carries
// Connection-Allowlist, which has Chrome refuse any connection the page
// starts to anywhere else, WebRTC included. Any other file gets neither the
// list nor script: its sandbox grants nothing, so it opens in an origin of
// its own, as it does deployed. Never widen the list to other files; the
// serving host sends it only where script can run.

const SCRIPT_MEDIA_TYPES = new Set([
  "text/html",
  "image/svg+xml",
  "text/javascript",
  "application/javascript",
]);

const POLICY_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
];

// What the host page requires of every document its frame shows (the
// iframe's csp attribute), as the console does: it binds even a document
// that doesn't come from this server.
export const FRAME_POLICY = POLICY_DIRECTIVES.join("; ");

// The only service worker either preview origin hands out, verbatim from
// the serving host. An app's own worker could answer the frame's
// navigations with documents it builds, carrying none of these headers, and
// on these fixed ports it would outlive the preview and answer the next
// app's too; a worker some other local server once left on the host port
// would answer the host page, which runs tools. This one listens for
// nothing.
export const INERT_SERVICE_WORKER = `// This origin's only service worker. It listens for nothing, so it answers
// no request: every page and file comes from the network with the host's
// own headers. It behaves like any default worker: it waits until no page
// is using the worker before it, then takes over.
`;

// hostOrigin is empty until the host server has bound (a startup race
// measured in milliseconds); until then nothing may frame the app.
export function appResponseHeaders(hostOrigin: string, contentType: string): Record<string, string> {
  const mediaType = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  const runsScript = SCRIPT_MEDIA_TYPES.has(mediaType);
  const directives = [
    runsScript ? "sandbox allow-scripts allow-same-origin" : "sandbox",
    ...POLICY_DIRECTIVES,
    `frame-ancestors ${hostOrigin === "" ? "'none'" : hostOrigin}`,
  ];
  const headers: Record<string, string> = {
    "Content-Security-Policy": directives.join("; "),
    // The served content types are final; the browser never guesses.
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  };
  if (hostOrigin !== "") {
    headers["Allow-CSP-From"] = hostOrigin;
  }
  if (runsScript) {
    headers["Connection-Allowlist"] = "(response-origin)";
  }
  return headers;
}
