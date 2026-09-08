// @driggsby/deploy: the Driggsby deploy protocol as a typed library.
// The driggsby CLI's deploy/rollback/versions commands build on these
// exports; Node-only sandboxes can use them directly.
export { DeployApiError, DeployError } from "./errors.ts";
// The base-URL policy: which origin the token travels to, and what
// DRIGGSBY_BASE_URL may override it with. One implementation for both this
// package's bin and the driggsby CLI.
export { PUBLIC_BASE_URL, consoleUrlOnOrigin, isLoopbackBaseUrl, resolveBaseUrl } from "./base-url.ts";
export {
  MAX_FILE_BYTES,
  MAX_FILE_COUNT,
  MAX_PATH_LENGTH,
  MAX_TOTAL_BYTES,
  slugProblem,
} from "./limits.ts";
export { type ProjectConfig, readProjectConfig, writeAssignedSlug } from "./project-config.ts";
export {
  type CollectedDeploy,
  type DeployFile,
  collectDeployFiles,
  formatBytes,
} from "./manifest.ts";
export {
  type BlobsMissing,
  type CreatedApp,
  type CreatedVersion,
  type DeployApi,
  type FinalizedVersion,
  type ManifestFile,
  type VersionList,
  type VersionSummary,
  createApp,
  createVersion,
  finalizeVersion,
  listVersions,
  setLiveVersion,
  uploadBlob,
} from "./client.ts";
export {
  type DeployOptions,
  type DeployOutcome,
  type ProjectDeployOptions,
  type ProjectDeployResult,
  deployCollectedFiles,
  deployProjectFiles,
} from "./deploy.ts";
// Terminal-safety helpers for anything that echoes untrusted text (file
// names, server strings) into CLI output. See terminal-text.ts for what the
// sanitizer strips and the deliberate boundary of that defense.
export {
  capForTerminal,
  quotedForTerminal,
  sanitizeForTerminal,
  wrapProse,
} from "./terminal-text.ts";
