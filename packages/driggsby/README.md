# Driggsby

[Driggsby](https://driggsby.com) is an MCP server for personal finance. You
link accounts through Plaid, and your AI client gets
read-only MCP tools for transactions, balances, investments, and debts.

## Setup

```bash
npx driggsby@latest mcp setup
```

This prompts you to choose a setup path. For Claude Code and Codex, it runs the
native MCP setup command. Or specify one:

```bash
npx driggsby@latest mcp setup claude-code
npx driggsby@latest mcp setup codex
npx driggsby@latest mcp setup other
```

After setup, authenticate Driggsby through your client — run `/mcp` in
Claude Code, or sign in through the browser window Codex opens.

For another MCP client, choose Other. Driggsby currently supports only
OAuth-based remote MCP at:

```text
https://app.driggsby.com/mcp
```

Some driggsby commands work with your Driggsby account directly and need
an app token saved on your machine: run
`npx driggsby@latest login` and approve the page it opens. The token is
stored in your platform keychain when one is available, otherwise in
`~/.driggsby/credentials.json`, and is never printed.
`npx driggsby@latest logout` removes it.

## Deploying an app

Driggsby hosts small static apps — dashboards, visualizations — at
`https://<your-app-name>.driggsby.dev`. From a folder holding a
`driggsby.json` (`{ "slug": "your-app-name", "serve": "." }`) and an
`index.html`:

```bash
npx driggsby@latest deploy
```

The first deploy creates the app; every deploy after that uploads only the
files that changed. Deploy with `--preview` to upload a version without
changing what visitors see, `npx driggsby@latest versions` to list every
kept version, and `npx driggsby@latest rollback` to switch which one is
live — switching re-uploads nothing.

The CLI is pure TypeScript and installs from the npm registry alone — no
binary downloads, no install scripts — and runs on macOS, Linux, and Windows
with Node.js 18 or newer.

See the [GitHub repo](https://github.com/driggsby/driggsby) for
tools, examples, and full documentation.

## License

Apache-2.0
