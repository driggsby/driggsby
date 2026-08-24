// Runs one whole deploy against the API: offer the manifest, upload the
// blobs the server doesn't have, finalize. Bounded concurrency, one retry on
// a 503 upload, and one recovery round if finalize reports missing blobs —
// then it stops and reports rather than looping.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  createVersion,
  type DeployApi,
  finalizeVersion,
  uploadBlob,
} from "./client.ts";
import { DeployApiError, DeployError } from "./errors.ts";
import { type CollectedDeploy, type DeployFile } from "./manifest.ts";
import { quotedForTerminal } from "./terminal-text.ts";

const UPLOAD_CONCURRENCY = 4;

export interface DeployOptions {
  live: boolean;
  appName?: string;
}

export interface DeployOutcome {
  appSlug: string;
  versionNumber: number;
  live: boolean;
  url: string | null;
  fileCount: number;
  // Blobs actually sent this deploy (deduplicated by content hash).
  uploadedBlobCount: number;
  uploadedBytes: number;
  // Files whose content was already on Driggsby from an earlier deploy.
  unchangedFileCount: number;
}

export async function deployCollectedFiles(
  api: DeployApi,
  slug: string,
  collected: CollectedDeploy,
  options: DeployOptions,
): Promise<DeployOutcome> {
  const created = await createVersion(api, slug, collected.files, options.appName);

  const fileBySha = new Map<string, DeployFile>();
  for (const file of collected.files) {
    if (!fileBySha.has(file.sha256)) {
      fileBySha.set(file.sha256, file);
    }
  }

  const uploadedShas = new Set<string>();
  let uploadedBytes = 0;
  const uploadRound = async (shas: string[]): Promise<void> => {
    // The server's missing-blob list is deduplicated defensively: a
    // misbehaving server repeating one sha must not make the client re-PUT
    // the same file over and over.
    const toUpload = [...new Set(shas)].map((sha) => {
      const file = fileBySha.get(sha);
      if (file === undefined) {
        throw new DeployError(
          "The Driggsby deploy API asked for a file this deploy never offered.\n" +
            "Please deploy again from the start.",
        );
      }
      return file;
    });
    await runWithConcurrencyLimit(toUpload, UPLOAD_CONCURRENCY, async (file, signal) => {
      const bytes = await readFile(file.absolutePath);
      assertUnchangedSinceHashing(file, bytes);
      await uploadBlobWithOneRetry(api, file.sha256, bytes, signal);
      if (!uploadedShas.has(file.sha256)) {
        uploadedShas.add(file.sha256);
        uploadedBytes += file.byteSize;
      }
    });
  };

  await uploadRound(created.missingBlobSha256s);

  let outcome = await finalizeVersion(api, created.versionId, options.live);
  if (outcome.kind === "blobs-missing") {
    // The server can evict a pending blob between upload and finalize. One
    // recovery round is enough for that; anything more means something is
    // genuinely wrong and retrying would just loop.
    await uploadRound(outcome.missingBlobSha256s);
    outcome = await finalizeVersion(api, created.versionId, options.live);
  }
  if (outcome.kind === "blobs-missing") {
    throw new DeployError(
      "We uploaded this deploy's files, but the Driggsby deploy API kept\n" +
        "reporting some as missing. Please deploy again in a minute.",
    );
  }

  // Counted from what actually went over the wire, so blobs re-sent during
  // the recovery round never read as "already on Driggsby".
  const unchangedFileCount = collected.files.filter((file) => !uploadedShas.has(file.sha256)).length;
  return {
    appSlug: outcome.appSlug,
    versionNumber: outcome.versionNumber,
    live: outcome.live,
    url: outcome.url,
    fileCount: collected.files.length,
    uploadedBlobCount: uploadedShas.size,
    uploadedBytes,
    unchangedFileCount,
  };
}

// The manifest hashed this file during the walk; the upload re-reads it
// from disk. If the bytes changed in between (a build still writing into
// the serve folder), uploading them under the walk-time hash would publish
// content nothing ever hashed — fail with the fix instead.
function assertUnchangedSinceHashing(file: DeployFile, bytes: Uint8Array): void {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== file.sha256) {
    throw new DeployError(
      `${quotedForTerminal(file.path, 80)} changed while this deploy was running — a build may\n` +
        "still have been writing into the serve folder. Let it finish and\n" +
        "deploy again.",
    );
  }
}

// A 503 from blob storage is transient and the PUT is idempotent, so one
// retry is safe. Without server guidance the retry waits a short default
// pause, since an instant re-PUT usually lands on storage that is still
// unhealthy and wastes the only retry the design allows. An explicit
// Retry-After is taken at its word — including 0, the server saying "now" —
// and capped so a bad header can't stall the deploy. A second 503 propagates
// with the server's message.
const DEFAULT_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 5_000;

export function retryDelayMs(error: DeployApiError): number {
  if (error.retryAfterSeconds === null) {
    return DEFAULT_RETRY_DELAY_MS;
  }
  return Math.min(error.retryAfterSeconds * 1_000, MAX_RETRY_DELAY_MS);
}

async function uploadBlobWithOneRetry(
  api: DeployApi,
  sha256: string,
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await uploadBlob(api, sha256, bytes, signal);
  } catch (error) {
    if (error instanceof DeployApiError && error.status === 503 && signal?.aborted !== true) {
      await sleep(retryDelayMs(error), signal);
      await uploadBlob(api, sha256, bytes, signal);
      return;
    }
    throw error;
  }
}

// Resolves early if the signal aborts mid-pause — a worker sleeping out a
// Retry-After must not keep the process alive after a sibling has already
// failed the deploy. (The retry PUT after an early wake is refused
// immediately by its aborted signal, so nothing extra reaches the wire.)
function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0 || signal?.aborted === true) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

// A small worker pool: at most `limit` workers in flight, results in input
// order, first failure rejects the whole run AND aborts the rest. Without
// the abort, the failure's message would print while surviving uploads keep
// running for minutes — a "deploy failed" line followed by a silent hang.
// Workers receive the shared signal so they can cancel their in-flight
// request; the pool itself also stops handing out new items once aborted.
export async function runWithConcurrencyLimit<Item, Result>(
  items: readonly Item[],
  limit: number,
  worker: (item: Item, signal: AbortSignal) => Promise<Result>,
): Promise<Result[]> {
  const results = new Array<Result>(items.length);
  const queue = items.map((item, index) => ({ item, index }));
  let cursor = 0;
  const abort = new AbortController();
  const runWorker = async (): Promise<void> => {
    for (;;) {
      if (abort.signal.aborted) {
        return;
      }
      const entry = queue[cursor];
      if (entry === undefined) {
        return;
      }
      cursor += 1;
      try {
        results[entry.index] = await worker(entry.item, abort.signal);
      } catch (error) {
        abort.abort();
        throw error;
      }
    }
  };
  const workerCount = Math.min(limit, items.length);
  // Promise.all rejects with the FIRST failure — the real one — and it
  // attaches handlers to every worker, so the aborted siblings' rejections
  // are observed, not unhandled.
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}
