# driggsby

`driggsby` is the local CLI for connecting AI clients to Driggsby over MCP.

## What You Get

- browser-based sign-in to Driggsby
- a local MCP server for tools like Codex and Claude Code
- access to supported Driggsby tools from your AI client

## Run

```bash
npx driggsby@latest connect
```

## Install

```bash
npm install -g driggsby
```

If you prefer not to install globally, use `npx driggsby@latest` for
human-invoked commands like `connect`, `status`, and `logout`. The `connect`
command installs the MCP launcher configuration for supported clients, or
prints configuration for other MCP clients.

On machines without working platform keyring support, such as some headless
Linux servers, Driggsby falls back to an owner-only local file-backed secret
store so the CLI can still complete login and run the broker.

Published npm installs currently include native artifacts for macOS arm64,
macOS x64, Linux arm64 glibc, and Linux x64 glibc.

## Quick Start

1. Connect Driggsby to an MCP client:

```bash
npx driggsby@latest connect
```

2. Or choose a supported client directly:

```bash
npx driggsby@latest connect claude-code
npx driggsby@latest connect codex
```

3. Check broker status any time:

```bash
npx driggsby@latest status
```

## Commands

```bash
npx driggsby@latest login
npx driggsby@latest connect
npx driggsby@latest clients list
npx driggsby@latest clients revoke <client>
npx driggsby@latest status
npx -y driggsby@latest mcp-server
npx driggsby@latest logout
```

## License

Licensed under the Apache License, Version 2.0. See the repository root
`LICENSE` file.
