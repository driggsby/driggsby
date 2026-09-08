// The scaffold's styles.css. A deployed app lives inside Driggsby's dark
// chrome, so the page is dark by default and its values are Driggsby's
// own: the console's ground, card rung, hairline, ink ramp, radii, and
// type sizes, written out as plain colors because the app is its own
// origin and cannot read the console's stylesheet. --bg-app must stay
// equal to driggsby.json's "background" (init-command.test.ts pins the
// two together): Driggsby paints that color while the app loads.

export const STYLES_CSS = `/* Driggsby's console palette, so this page reads as part of the app it
   opens inside. Change these together if you re-theme; keep --bg-app equal
   to the "background" in driggsby.json. */
:root {
  color-scheme: dark;
  --bg-app: #000000;
  --bg-card: #0a0a0a;
  --bg-mute: #262626;
  --hairline: rgba(255, 255, 255, 0.14);
  --text-primary: #fafafa;
  --text-secondary: #c4c4c4;
  --text-tertiary: #a1a1a1;
  --radius-card: 8px;
  --radius-bar: 4px;
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: var(--bg-app);
  color: var(--text-primary);
  font-family: var(--font-sans);
  font-size: 14px;
  line-height: 21px;
  -webkit-font-smoothing: antialiased;
}

main {
  max-width: 800px;
  margin: 0 auto;
  padding: 24px 24px 64px;
}

h1 {
  margin: 0;
  font-size: 24px;
  font-weight: 600;
  line-height: 36px;
  letter-spacing: -0.02em;
}

h2 {
  margin: 24px 0 12px;
  font-size: 14px;
  font-weight: 500;
  line-height: 21px;
  letter-spacing: -0.02em;
}

/* One card, four cells; the 1px gap over the card's own hairline color
   draws the divider between cells however the grid wraps. */
.stat-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 1px;
  margin-top: 24px;
  border: 1px solid var(--hairline);
  border-radius: var(--radius-card);
  background: var(--hairline);
  overflow: hidden;
}

@media (max-width: 640px) {
  .stat-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 400px) {
  .stat-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

.stat {
  display: flex;
  flex-direction: column;
  padding: 16px;
  background: var(--bg-card);
}

.stat-label {
  font-size: 13px;
  line-height: 20px;
  color: var(--text-tertiary);
}

.stat-value {
  margin-top: 4px;
  font-size: 20px;
  font-weight: 600;
  line-height: 28px;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
  /* A currency string has no natural break, and a clipped balance is a
     wrong number. If a value ever outgrows its cell, it wraps. */
  overflow-wrap: anywhere;
}

#accounts {
  border: 1px solid var(--hairline);
  border-radius: var(--radius-card);
  background: var(--bg-card);
  overflow: hidden;
}

.account-row {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 16px;
}

.account-row + .account-row {
  border-top: 1px solid var(--hairline);
}

/* A list with nothing in it says so, in the row's own inset. */
.empty-row {
  padding: 14px 16px;
  color: var(--text-secondary);
}

/* The institution's initial on a round pill, as the console draws it. */
.account-glyph {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--bg-mute);
  color: var(--text-secondary);
  font-size: 16px;
  font-weight: 600;
}

.account-names {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
}

.account-name {
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.account-institution {
  /* Holds its line even when empty, so every row measures the same as
     the skeleton row it replaces. */
  min-height: 21px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.account-balance {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

/* The skeleton ships in the HTML so the first paint is the final layout as
   muted bars; the first render replaces it and fades in (see app.js). Each
   bar's margins pad it to exactly the height of the text it stands in for,
   and the columns holding stacked bars are flex so those margins never
   collapse — the skeleton page and the data page measure identical, and
   nothing shifts when data lands. */
.skeleton {
  border-radius: var(--radius-bar);
  background: var(--bg-mute);
  animation: skeleton-pulse 1.6s ease-in-out infinite;
}

.skeleton-label {
  width: 64px;
  height: 12px;
  margin: 4px 0;
}

.skeleton-value {
  width: 96px;
  height: 20px;
  margin: 8px 0 4px;
}

.skeleton-glyph {
  flex: none;
  width: 32px;
  height: 32px;
  border-radius: 50%;
}

.skeleton-name {
  width: 150px;
  height: 14px;
  margin: 3.5px 0;
}

.skeleton-institution {
  width: 110px;
  height: 12px;
  margin: 4.5px 0;
}

.skeleton-balance {
  width: 72px;
  height: 14px;
  margin: 3.5px 0;
}

@keyframes skeleton-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
}

.fade-in {
  animation: fade-in 200ms ease-out;
}

@keyframes fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

@media (prefers-reduced-motion: reduce) {
  .skeleton,
  .fade-in {
    animation: none;
  }
}
`;
