# Driggsby CLI

`driggsby` is the local command-line bridge for connecting AI clients to
Driggsby over MCP.

## Quick Start

Connect Driggsby to an MCP client:

```bash
npx driggsby@latest connect
```

You can also choose a supported client directly:

```bash
npx driggsby@latest connect claude-code
npx driggsby@latest connect codex
```

Check readiness:

```bash
npx driggsby@latest status
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

## License

Licensed under the Apache License, Version 2.0. See `LICENSE`.
