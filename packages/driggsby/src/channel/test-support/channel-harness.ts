// Runs driggsby channel against the fake feed service the way Claude Code
// drives it: the handshake on stdin, then stdin closed when the session ends.
import { PassThrough } from "node:stream";

import { makeEnvironment } from "../../deploy/test-support/deploy-command-harness.ts";
import { fakeService, type Script, sqlOf } from "../../listen/test-support/fake-feed-service.ts";
import { startFakeMcp } from "../../test-support/fake-mcp.ts";
import { CHANNEL_SWITCH, runChannel } from "../channel-command.ts";

export interface Run {
  code: number;
  initialize: Record<string, unknown>;
  events: { content: string; meta: Record<string, string> }[];
  log: string;
  waits: number[];
  queries: number;
}

export interface ChannelOptions {
  switch?: string | null;
  signedIn?: boolean;
  // Extra environment, as Claude Code passes it to the plugin's server.
  env?: Record<string, string>;
  // The clock the saved place is checked and stamped with (the cursors keep
  // the real clock).
  now?: () => number;
  // Close stdin while this check's investment activity is being read.
  endDuringCheck?: number;
}

export const HANDSHAKE =
  `${JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {} } })}\n` +
  `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`;

// Runs the channel for `checks` checks after its first minute's wait (-1:
// end during that wait), then closes stdin.
export async function channel(script: Script, checks: number, options: ChannelOptions = {}): Promise<Run> {
  let sleeps = 0;
  // The first wait comes before anything is read, so it isn't a check.
  const phase = (): number => Math.max(0, sleeps - 1);
  const input = new PassThrough();
  const respond = fakeService(script, phase);
  const fake = await startFakeMcp((body) => {
    const sql = sqlOf(body);
    if (phase() === options.endDuringCheck && sql.includes("FROM investment_activity") && !sql.startsWith("SELECT MAX")) {
      input.end();
    }
    return respond(body);
  });
  const environment = await makeEnvironment(fake.baseUrl, { signedIn: options.signedIn ?? true });
  Object.assign(environment.env, options.env ?? {});
  const value = options.switch === undefined ? "on" : options.switch;
  if (value !== null) {
    environment.env[CHANNEL_SWITCH] = value;
  }
  const written: string[] = [];
  let log = "";
  const waits: number[] = [];
  let followed: () => void = () => undefined;
  const followDone = new Promise<void>((resolve) => {
    followed = resolve;
  });
  const end = async (): Promise<void> => {
    input.end();
    await new Promise((resolve) => setImmediate(resolve));
  };
  try {
    const running = runChannel(
      environment,
      { input, interactive: false, write: (line) => written.push(line), log: (text) => (log += text) },
      {
        sleep: async (milliseconds) => {
          waits.push(milliseconds);
          sleeps += 1;
          if (sleeps - 1 > checks) {
            await end();
          }
        },
        onStopped: () => {
          followed();
          void end();
        },
        ...(options.now === undefined ? {} : { now: options.now }),
      },
    );
    input.write(HANDSHAKE);
    if (value !== "on") {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await end();
    }
    const code = await running;
    // With the switch on, wait for the follow loop itself to finish, so a
    // read it makes after stdin closes is counted.
    if (value === "on") {
      await Promise.race([followDone, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    }
    const messages = written.map((line) => JSON.parse(line) as Record<string, unknown>);
    const initialize = messages.find((message) => message.id === 0)?.result as Record<string, unknown>;
    const events = messages
      .filter((message) => message.method === "notifications/claude/channel")
      .map((message) => message.params as { content: string; meta: Record<string, string> });
    return { code, initialize, events, log, waits, queries: fake.requests.length };
  } finally {
    await fake.close();
  }
}
