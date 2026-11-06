// The replay's voice on a Mac: one player, macOS's own, driven over a pipe
// through the built-in osascript. It pauses, resumes, changes speed and
// stops in place and at once, and only one line ever plays. When the replay
// ends, or its process dies, the pipe closes and the player stops and exits.
import { type ChildProcessByStdio, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

const OSASCRIPT = "/usr/bin/osascript";
const READY_MS = 3_000;

// Commands arrive one per line, tab-separated: play <path> <offset> <rate>
// <paused 0|1>, pause, resume, rate <rate>, stop. A play past the end of its
// file stays silent, and a resume only continues a line a pause (or a paused
// jump) held, never one that had already finished. End of input stops the
// player and exits.
const PLAYER_SCRIPT = `
ObjC.import("AVFoundation");
ObjC.import("Foundation");
function run() {
  const input = $.NSFileHandle.fileHandleWithStandardInput;
  const output = $.NSFileHandle.fileHandleWithStandardOutput;
  output.writeData($("ready\\n").dataUsingEncoding($.NSUTF8StringEncoding));
  let player = null;
  let held = false;
  let buffer = "";
  for (;;) {
    const data = input.availableData;
    if (Number(data.length) === 0) break;
    buffer += $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js;
    let end;
    while ((end = buffer.indexOf("\\n")) >= 0) {
      const parts = buffer.slice(0, end).split("\\t");
      buffer = buffer.slice(end + 1);
      const command = parts[0];
      if (command === "play") {
        if (player) player.stop;
        player = null;
        held = false;
        const next = $.AVAudioPlayer.alloc.initWithContentsOfURLError($.NSURL.fileURLWithPath(parts[1]), null);
        const offset = Number(parts[2]);
        if (!next.isNil() && offset >= 0 && offset < next.duration) {
          next.enableRate = true;
          next.prepareToPlay;
          next.rate = Number(parts[3]);
          next.currentTime = offset;
          if (parts[4] === "1") held = true;
          else next.play;
          player = next;
        }
      } else if (command === "pause") {
        held = Boolean(player && player.playing);
        if (held) player.pause;
      } else if (command === "resume") {
        if (held) player.play;
        held = false;
      } else if (command === "rate") {
        if (player) player.rate = Number(parts[1]);
      } else if (command === "stop") {
        if (player) player.stop;
        player = null;
        held = false;
      }
    }
  }
  if (player) player.stop;
}
`;

export interface Voice {
  play(file: string, offset: number, rate: number, paused: boolean): void;
  pause(): void;
  resume(): void;
  rate(rate: number): void;
  stop(): void;
  close(): void;
}

export interface Cue {
  at: number;
  file: string;
}

// The line under a moment of the replay: the last sound started at or before
// it, and how far into it the moment is (past its end, the player stays silent).
export function lineAt(cues: readonly Cue[], pt: number): { file: string; offset: number } | null {
  let found: Cue | null = null;
  for (const cue of cues) {
    if (cue.at > pt) break;
    found = cue;
  }
  return found === null ? null : { file: found.file, offset: pt - found.at };
}

// One command line for the player; null for a path it couldn't carry.
export function playerCommand(parts: readonly (string | number)[]): string | null {
  const fields = parts.map(String);
  return fields.some((field) => /[\t\n\r]/.test(field)) ? null : `${fields.join("\t")}\n`;
}

// The player, ready to speak, or null where there is none (not a Mac, or it
// didn't start): the replay then plays silently.
export function startVoice(): Promise<Voice | null> {
  if (process.platform !== "darwin" || !existsSync(OSASCRIPT)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const child = spawn(OSASCRIPT, ["-l", "JavaScript", "-e", PLAYER_SCRIPT], { stdio: ["pipe", "pipe", "ignore"] });
    let settled = false;
    const settle = (voice: Voice | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (voice === null) child.kill();
      resolve(voice);
    };
    const timer = setTimeout(() => { settle(null); }, READY_MS);
    child.on("error", () => { settle(null); });
    child.on("exit", () => { settle(null); });
    // The player may be gone before a write lands; a lost line is silence.
    child.stdin.on("error", () => undefined);
    child.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString("utf8").includes("ready")) settle(voiceOver(child));
    });
  });
}

function voiceOver(child: ChildProcessByStdio<Writable, Readable, null>): Voice {
  const send = (parts: readonly (string | number)[]): void => {
    const line = playerCommand(parts);
    if (line !== null && child.stdin.writable) child.stdin.write(line);
  };
  return {
    play: (file, offset, rate, paused) => {
      send(["play", fileURLToPath(new URL(`../../assets/replay/${file}`, import.meta.url)), offset.toFixed(3), rate, paused ? 1 : 0]);
    },
    pause: () => { send(["pause"]); },
    resume: () => { send(["resume"]); },
    rate: (rate) => { send(["rate", rate]); },
    stop: () => { send(["stop"]); },
    close: () => {
      send(["stop"]);
      child.stdin.end();
    },
  };
}
