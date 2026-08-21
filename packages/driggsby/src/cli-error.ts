// A user-facing CLI failure. `exitCode` mirrors the original Rust CLI:
// 2 for argument/usage errors (clap's convention), 1 for command errors
// such as an unsupported client name. The message is printed to stderr
// verbatim; it must already be consumer-safe.
export class CliError extends Error {
  readonly exitCode: 1 | 2;

  constructor(message: string, exitCode: 1 | 2) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}
