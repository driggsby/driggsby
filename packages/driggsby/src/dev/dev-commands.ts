// The commands `driggsby dev` names in its own output and help, and the
// idle window it enforces, in one place so no two surfaces can disagree.
export const DEV_START_COMMAND = "npx driggsby@latest dev";
export const DEV_STOP_COMMAND = "npx driggsby@latest dev --stop";
// A preview nobody has open for this long stops itself, so a dev started in
// the background (often by an agent) does not keep serving live financial
// data on this machine indefinitely.
// Spelled out as prose in README.md and packages/driggsby/README.md too;
// change those with this.
export const DEV_IDLE_MINUTES = 30;
