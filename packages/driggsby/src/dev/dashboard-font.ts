// Inter, the face Driggsby apps set their text in. Driggsby serves it on
// every deployed app's own origin at DASHBOARD_FONT_PATH, and the scaffold
// loads it from there; dev serves the same bytes at the same path, from
// this package (assets/Inter.woff2, under the SIL Open Font License 1.1 in
// assets/Inter-LICENSE.txt). So the preview draws the letters the deployed
// page draws, and nothing reaches the internet for them.
import { readFile } from "node:fs/promises";

export const DASHBOARD_FONT_PATH = "/-/inter.woff2";
export const DASHBOARD_FONT_TYPE = "font/woff2";

// src/dev/ and dist/dev/ both sit two levels under the package root.
const FONT_FILE = new URL("../../assets/Inter.woff2", import.meta.url);

export async function loadDashboardFont(): Promise<Buffer> {
  return await readFile(FONT_FILE);
}
