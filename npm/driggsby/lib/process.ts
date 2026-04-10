import { spawnSync } from "node:child_process";

export type SpawnResult = {
  status: number;
};

export function spawnFile(command: string, args: string[]): void {
  const result = runFile(command, args);

  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}.`);
  }
}

export function runFile(command: string, args: string[]): SpawnResult {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  return { status: result.status ?? 1 };
}

export function spawnFileAndExit(command: string, args: string[]): never {
  try {
    const result = runFile(command, args);
    process.exit(result.status);
  } catch (error) {
    if (error instanceof Error) {
      console.error(error.message);
    } else {
      console.error(error);
    }

    process.exit(1);
  }
}
