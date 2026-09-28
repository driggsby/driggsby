import assert from "node:assert/strict";
import { test } from "node:test";

import { DASHBOARD_FONT_PATH } from "../dev/dashboard-font.ts";
import { STYLES_CSS } from "./template-styles.ts";
import { indexHtml } from "./templates.ts";

// The scaffold sets its text in Inter from the path Driggsby serves it at
// on every app's own origin (dev serves the same bytes there too), so the
// picture Driggsby takes of the page for its tile, on a server with none of
// the user's fonts, draws the same letters as the page.
test("the scaffold sets its text in Inter from Driggsby's path, preloaded before the stylesheet", () => {
  const face = /@font-face \{[^}]*\}/.exec(STYLES_CSS)?.[0] ?? "";
  assert.ok(face.includes('font-family: "Inter";'), "styles.css declares Inter");
  assert.ok(face.includes(`src: url("${DASHBOARD_FONT_PATH}") format("woff2");`));
  assert.ok(face.includes("font-weight: 100 900;"));
  assert.ok(face.includes("font-display: block;"), "text waits for Inter rather than flash another face");
  assert.ok(
    STYLES_CSS.includes('--font-sans: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;'),
    "the stack leads with Inter; the rest only stand in",
  );

  const html = indexHtml("money-dash");
  const preload = `<link rel="preload" href="${DASHBOARD_FONT_PATH}" as="font" type="font/woff2" crossorigin>`;
  assert.ok(html.includes(preload), "index.html preloads the font");
  assert.ok(
    html.indexOf(preload) < html.indexOf('<link rel="stylesheet" href="styles.css">'),
    "the font's fetch starts before the stylesheet's",
  );
});

// Inter is the only font (the dashboards skill says the same): the
// template names no other face, teaches none, and its form controls take
// the page's font rather than the system's.
test("the scaffold names no font but Inter, and its form controls inherit it", () => {
  assert.ok(STYLES_CSS.includes("Inter is the only font a dashboard uses"));
  assert.ok(!STYLES_CSS.includes("To switch faces"), "no how-to for another face");
  const families = [...STYLES_CSS.matchAll(/font-family:\s*([^;]+);/g)].map((match) => match[1]);
  assert.deepEqual(families, ['"Inter"', "var(--font-sans)"]);
  assert.match(STYLES_CSS, /button,\s*input,\s*select,\s*textarea \{\s*font: inherit;\s*\}/);
  assert.ok(!/font-family|font:/.test(indexHtml("money-dash")), "index.html sets no font of its own");
});
