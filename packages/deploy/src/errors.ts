// Error types the deploy package throws. Messages are written to be shown to
// a person or agent as-is: plain English, naming the fix, no internal detail.
// A local problem (bad driggsby.json, an undeployable file) is a DeployError;
// a response the deploy API refused is a DeployApiError carrying the server's
// own user-facing description.
import { quotedForTerminal } from "./terminal-text.ts";

export class DeployError extends Error {}

export class DeployApiError extends DeployError {
  readonly status: number;
  readonly code: string;
  readonly description: string;
  // Whole seconds from the response's Retry-After header, when it sent one.
  readonly retryAfterSeconds: number | null;

  constructor(status: number, code: string, description: string, retryAfterSeconds: number | null = null) {
    // The code is a server-supplied string, so the fallback message quotes
    // and bounds it like every other text this package did not author (a
    // real code is a short snake_case word).
    super(
      description === ""
        ? `The Driggsby deploy API refused this request (${quotedForTerminal(code, 40)}).`
        : description,
    );
    this.status = status;
    this.code = code;
    this.description = description;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
