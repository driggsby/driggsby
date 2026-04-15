# Driggsby CLI

`driggsby` helps configure AI clients to connect directly to Driggsby over MCP.

## Quick Start

Set up Driggsby for an MCP client:

```bash
npx driggsby@latest mcp setup
```

Run `mcp setup` once for each MCP client you want to use. Your AI client handles
OAuth with Driggsby when it connects to:

```text
https://app.driggsby.com/mcp
```

You can also choose a supported client directly:

```bash
npx driggsby@latest mcp setup claude-code
npx driggsby@latest mcp setup codex
```

Claude Code MCP scope can be set explicitly with `-s`. Driggsby defaults
Claude Code setup to user scope.

```bash
npx driggsby@latest mcp setup claude-code -s user
npx driggsby@latest mcp setup claude-code -s local
```

Print the native client command without running it:

```bash
npx driggsby@latest mcp setup codex --print
```

## Release Model

This repository owns the public CLI source, GitHub Release artifacts, and npm
publishing workflow for the `driggsby` package.

Create release tags from `main` using this format:

```text
driggsby-vX.Y.Z
```

The tag-triggered release workflow builds macOS and Linux artifacts with
`cargo-dist`, uploads them to this public repository's GitHub Release, scans the
generated npm package, and publishes `driggsby` to npm using trusted publishing.
Release artifacts currently cover macOS arm64, macOS x64, Linux arm64 glibc,
and Linux x64 glibc.

macOS release artifacts are signed with a Developer ID Application certificate
and submitted to Apple notarization before the npm package records their
checksums. Apple signing runs in the protected `apple-signing` GitHub Actions
environment, which expects these environment secrets:

```text
APPLE_DEVELOPER_ID_CERTIFICATE_P12_BASE64
APPLE_DEVELOPER_ID_CERTIFICATE_PASSWORD
APPLE_NOTARY_KEY_P8_BASE64
APPLE_NOTARY_KEY_ID
APPLE_NOTARY_ISSUER_ID
APPLE_TEAM_ID
APPLE_CODESIGN_IDENTITY
```

Release builds may cache Cargo registry and git dependency downloads. They must
not cache `target/`, Apple signing keychains, Developer ID certificates, notary
API keys, notarization ZIPs, or signed release artifacts.

## License

Licensed under the Apache License, Version 2.0. See `LICENSE`.
