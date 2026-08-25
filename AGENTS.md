# AGENTS.md

This repository contains the public, open-source Driggsby CLI: pure
TypeScript npm packages that set up supported AI clients to connect to the
remote Driggsby MCP endpoint, scaffold and locally preview Driggsby apps,
and deploy static apps to Driggsby's app hosting. `driggsby` is the CLI
(`mcp setup`, `login`/`logout`, `init`, `dev`, `deploy`, `rollback`,
`versions`); `@driggsby/deploy` is the deploy protocol library it depends
on, which also ships a minimal standalone `driggsby-deploy` bin for
sandboxed agents; `@driggsby/sdk` is the in-page SDK bundle that scaffolded
apps load (`driggsby dev` serves it locally; deployed apps get it from the
serving host).

Driggsby is a personal financial MCP server that provides secure access to users'
financial data (such as balances, transactions, and investments) to their AI client
or agent of choice. As such, security is non-negotiable and is your top priority.

## Project Scope

- This repo owns the `driggsby`, `@driggsby/deploy`, and `@driggsby/sdk`
  npm packages and their publishing workflow. It is an npm-workspaces
  monorepo under `packages/`. The three packages version in lockstep and
  publish together; the libraries (`@driggsby/deploy`, `@driggsby/sdk`)
  publish first because `driggsby` depends on both.
- The CLI is pure TypeScript compiled to JavaScript. It installs from the npm
  registry alone: no platform binaries, no postinstall scripts, no binary
  downloads. It must keep working in sandboxes whose network egress is limited
  to the npm registry, and in WebContainer-style environments that cannot run
  native binaries.
- The published packages must have **zero third-party runtime dependencies**.
  The only allowed runtime dependencies are `driggsby`'s exact-pinned,
  lockstep-versioned dependencies on our own `@driggsby/deploy` and
  `@driggsby/sdk`; the two libraries themselves have zero runtime
  dependencies of any kind. Development tooling (typescript, eslint,
  esbuild for the SDK bundle, the test runner) stays in devDependencies.
  `scripts/release/check-npm-publish-surface.ts` enforces this contract
  against the packed tarballs.
- `packages/sdk/src/sdk-core.ts` and `packages/sdk/src/entrypoint.ts` are a
  copy of the SDK runtime that Driggsby's production serving host delivers
  to every deployed app; the production copy is canonical. Never change the
  protocol behavior or security properties here alone (the host-origin
  allowlist, the first-valid-hello origin pin, parent-window-only
  messaging): a behavior change must ship on the Driggsby service side
  first and be mirrored into these files verbatim, or `driggsby dev`
  silently stops matching what a deployed app actually does. The same rule
  covers `packages/driggsby/src/dev/tool-allowlist.ts` (a copy of the
  read-only tool allowlist the Driggsby service enforces) and the host-page
  protocol in `packages/driggsby/src/dev/host-page.ts`: service side first,
  then mirror.
- Main install path:
  - `npx driggsby@latest mcp setup`
  - `npx driggsby@latest mcp setup claude-code`
  - `npx driggsby@latest mcp setup codex`
- The CLI configures native client OAuth MCP settings for:
  - Claude Code, using `claude mcp add --transport http`.
  - Codex, using `codex mcp add --url`.
- The fixed public MCP URL is:

```text
https://app.driggsby.com/mcp
```

- For `mcp setup`, the CLI does not run a local MCP server, daemon, local
  OAuth flow, or Driggsby token store; client OAuth stays client-managed.
- This is a public repo. Do not add private Driggsby service code, private
  infrastructure details, customer data, credentials, internal repo names,
  non-public runbooks, or private operational debugging instructions.
- Assume every committed file is public and may be shared broadly. Take utmost
  care before publishing operational, security, infrastructure, release, or
  credential-adjacent details.
- The root `README.md`, `packages/driggsby/README.md`, and
  `packages/deploy/README.md` are public launch-facing docs. Keep them
  user-facing and concise; do not include internal release runbooks,
  maintainer-only operational notes, or environment variable names — except
  `DRIGGSBY_TOKEN`, which `packages/deploy/README.md` must document because
  it is the standalone bin's only way to authenticate. `DRIGGSBY_BASE_URL`
  stays out of all public docs.

## Security

- Treat this as consumer financial software.
- Never expose secrets, token values, private paths, or internal service
  diagnostics in public CLI output. Credential checks are presence-only.
- Public remote MCP/OAuth validation errors may be surfaced when they are already
  part of the public remote contract. Local process/config command failures must
  be mapped to consumer-safe messages with clear next steps.
- Suggested terminal commands in CLI output must be copy-paste safe. Do not wrap
  terminal command suggestions in shell backticks. Markdown docs may use backticks.
- Never spawn a child process with user-controlled program names or arguments;
  commands the CLI runs are fixed constants. If a value must flow into a
  command, allowlist-validate it first and never use a shell to interpret it.
  `shell: true` is forbidden everywhere, including on Windows: `.cmd`/`.bat`
  shims run only through `spawn-plan.ts`, which resolves programs against
  PATH+PATHEXT (never the current directory) and invokes an absolute
  `cmd.exe` with its own quoting.
- GitHub Actions must stay pinned to immutable SHAs unless there is a deliberate
  reviewed reason to update them.
- Credential storage (`src/credentials/`) has fixed invariants: token values
  never appear in output, errors, or logs; macOS uses an absolute
  `/usr/bin/security` (never PATH); Linux `secret-tool` receives the token on
  stdin, never argv; the file fallback is `~/.driggsby/credentials.json` with
  `0600`/`0700` modes written via temp-file-plus-rename. `ClearOutcome` is a
  tri-state (`cleared`/`absent`/`failed`) and a failed removal must never be
  reported as "nothing to remove". A keyring write failure never falls back to
  the file silently while an older keyring token could shadow the file copy on
  read — `saveToken`'s shadow guard fails loudly or warns, by design.
- Both claim-flow fetches in `src/login/` pin `redirect: "error"` and treat all
  server-controlled strings as hostile: origin-pin and sanitize the claim URL,
  cap and sanitize `error_description`. Keep it that way.
- Never publish npm packages or release artifacts from an unreviewed
  branch or from a tag that is not current `origin/main`.

## Conversation And Autonomy

- Be concise and direct with maintainers. Give the upshot first.
- Do not ask maintainers to run commands that you can run yourself.
- Be proactive: when a likely next step is obvious, do it.
- Ask clarification only when a reasonable assumption would be risky.
- Keep the maintainer informed with short progress updates during long work.

## Planning Process

When asked to prepare a plan:

1. Clarify and research first.
   - Ask questions only when ambiguity could cause downstream mistakes.
   - Review recent git history and open PRs.
   - Review current repo structure, `README.md`, `Justfile`, workflows, and relevant
     source before planning.
   - Follow existing repo patterns unless there is a strong reason not to.
   - Do not duplicate existing structure.

2. Write a tactical implementation plan.
   - Prefer a checklist with concrete files, checks, and expected behavior.
   - Prioritize ease of use, security, small scope, and first-shot agent success.
   - Call out release, npm, or platform-support consequences explicitly.

3. Keep scope tight.
   - If the plan crosses multiple systems, split it.
   - Avoid turning a CLI fix into release-infra churn unless the release path is
     directly implicated.

4. Review the plan with the maintainer.
   - Present the plan plus any remaining decision points.
   - Revise based on feedback before implementing if the user asked for a plan.

## Development Process

When implementing a feature, fix, or release change:

1. Set up the work correctly.
   - If the current branch is `main`, create a feature branch first.
   - Do not treat local commits on `main` as complete.
   - Unless explicitly told otherwise, work is not complete until the branch is
     pushed and a GitHub PR exists.
   - Do not revert unrelated local changes.
   - Install the repo hooks in local clones with
     `git config core.hooksPath .githooks`.

2. Research before editing.
   - Inspect relevant source, tests, workflows, and release metadata.
   - Check edited source file lengths before changes; keep source files under 500
     lines. The 500-line source gate is enforced by
     `scripts/check_source_line_lengths.sh`.
   - For release behavior, inspect `.github/workflows/release.yml`,
     `.github/workflows/pr-security.yml`, `packages/driggsby/package.json`,
     `packages/deploy/package.json`, `packages/sdk/package.json`, and
     `scripts/release/*`.

3. Implement carefully.
   - Keep TypeScript strict and boring: explicit types, straightforward control
     flow, no cleverness.
   - Preserve public CLI/MCP output quality; changed output means updated
     fixtures with a reviewed reason.
   - Avoid new dependencies. The published packages must keep zero
     third-party runtime dependencies (the only runtime dependencies are
     `driggsby`'s exact-pinned `@driggsby/deploy` and `@driggsby/sdk`, per
     Project Scope); adding a devDependency needs clear justification and a
     current-version check.
   - Keep behavior identical across macOS, Linux, and Windows: use `node:path`
     for paths, never shell out to POSIX-only tools, and never assume POSIX
     file permissions on Windows.

4. Test the behavior, not just compilation.
   - Add or update focused tests for real regressions.
   - Avoid test bloat and near-duplicates.
   - For CLI-output changes, update the fixture parity tests and run live
     output smokes.
   - Tests must not depend on a real `claude`/`codex` install; use the fake
     client shims in `src/test-support/`.

5. Review after tests pass.
   - For non-trivial changes, run exactly 2 review rounds: a primary round and
     a fresh adversarial round. Each round runs 2 focused read-only reviewer
     subagents: one security/privacy reviewer and one correctness/quality/
     simplification reviewer. Fix valid `medium+` findings, then repeat the
     round until both reviewers pass.
   - Reviewer prompts must start with:

```text
You are a READ-ONLY reviewer. Do NOT edit files, do NOT create pull requests, do NOT perform the work of a developer. You are a CODE REVIEWER only.
```

   - Reviewer subagents must be spawned with `fork_context=false`, must be
     read-only, and must not create branches, commits, pushes, pull requests,
     PR comments, issue comments, labels, or reactions.
   - Documentation-only edits may skip the full reviewer pass when they do not
     change product behavior, release behavior, security posture, or public
     contracts.

6. Verify and commit.
   - Run the repo's required checks before committing (`just verify`, or
     `npm run check && npm run build && npm test` plus the line-length gate).
   - Smoke test real CLI output when public behavior changed.
   - Commit messages must be descriptive and end with an `Authored by:` footer
     naming the authoring agent as the final line.

7. Sync and open the PR.
   - Sync the feature branch with `origin/main`.
   - Resolve conflicts and re-run relevant checks.
   - Push the branch.
   - Open a PR with a clear title and body covering summary, why, testing, and risks.

## TypeScript Rules

- Strict mode everywhere, type-clean with zero errors and zero eslint warnings.
- No `any`, no unsafe casts, no `@ts-ignore`/`@ts-expect-error` in non-test code.
- No `eval`, no dynamic `Function`, no dynamic `import()` of computed paths.
- Use explicit domain result types (discriminated unions) over thrown strings;
  `CliError` carries the exit code for user-facing failures.
- Keep modules and functions small enough that the next agent can understand
  them quickly; source files stay under 500 lines.
- Source imports use `.ts` specifiers; `rewriteRelativeImportExtensions`
  rewrites them at build time and Node runs the `.ts` files directly in tests.

## Checks

Use the repo's `Justfile` recipes:

- `just required-check`: npm ci, lint + typecheck, build, and the 500-line
  source file gate.
- `just verify`: `just required-check` plus the full test suite.
- `just check-npm-package`: packs the npm package and validates its publish
  surface, including installing the real tarball and running the bin.

For CLI-output changes, smoke test the actual terminal output:

```bash
node packages/driggsby/bin/driggsby.js --help
node packages/driggsby/bin/driggsby.js mcp setup claude-code --print
node packages/driggsby/bin/driggsby.js mcp setup codex --print
```

For workflow changes, run `actionlint .github/workflows/*.yml` when available
and `bash scripts/check_github_action_pins.sh`.

## CLI Output Rules

- CLI output should be calm, explicit, and easy for humans and agents to act on.
- Every command's output should end by telling the user the exact next step,
  preferring a consistent `Next:` section:

```text
Next:
  Open Claude Code and authenticate Driggsby when prompted.
```

- Terminal command suggestions must be raw, copy-pasteable commands. Do not use
  shell backticks in terminal output.
- Markdown docs, PR bodies, and comments should still use Markdown backticks around
  commands.
- Do not expose local paths, raw process errors, or private implementation details
  in consumer-facing output unless explicitly needed for a local diagnostic
  command.
- Optimize for first-shot success by a zero-context agent. Help text, errors,
  and next steps should be plain English and hard to misread.

## Release Process

Releases are tag-triggered and publish through npm trusted publishing (OIDC);
no npm tokens exist anywhere. The release workflow runs only for tags matching:

```text
driggsby-vX.Y.Z
```

Before creating a release tag:

1. Update the version in `packages/driggsby/package.json`,
   `packages/deploy/package.json`, `packages/sdk/package.json`, and the
   workspace root `package.json`; update `packages/driggsby/package.json`'s
   exact-pinned `dependencies` on `@driggsby/deploy` and `@driggsby/sdk` to
   the same version (the packages version in lockstep and the
   publish-surface check fails on any mismatch); then refresh
   `package-lock.json` (`npm install`).
2. Run `just verify` and `just check-npm-package`.
3. Merge the PR to `main`.
4. Sync local `main` with `origin/main`.
5. Create and push the tag from the current `origin/main` commit:

```bash
git tag driggsby-vX.Y.Z origin/main
git push origin driggsby-vX.Y.Z
```

The release workflow rejects tags that are not on current `origin/main`, and
rejects tags whose version does not match the package version. It then
verifies on all three OSes, validates the packed npm package surface, and
publishes `@driggsby/deploy`, then `@driggsby/sdk`, then `driggsby` with
`--provenance` through the `npm-publish` environment, skipping any package
whose exact version is already on the registry so a partially-failed
release can be re-run.

The npm trusted publisher must match the public repository, release workflow
file, and `npm-publish` environment, and is configured per package on
npmjs.com — a brand-new package needs its trusted publisher set up there
before its first tagged release can publish. If npm publish fails, inspect
trusted publishing and environment protection before changing package code.

If a release fails after a tag push:

- Fix the workflow or code in a new PR.
- Bump to a new version if npm already observed the failed version in a way
  that cannot be safely retried.
- Merge to `main`, then create a new tag from current `origin/main`.

## Platform Support

- Supported: macOS, Linux, and Windows, on Node.js 18 or newer (the package's
  `engines` floor). CI runs the full suite on all three OSes and smokes the
  built CLI on Node 18.
- There are no platform binaries and no per-platform artifacts; the npm
  package is the entire release surface.

## Public Documentation

- Keep public docs useful but not revealing.
- It is okay to document install commands, supported platforms, release process,
  troubleshooting, and public MCP behavior.
- Do not document non-public deployment details, private architecture, private
  tools, customer data handling internals, or credential locations.
