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

## Building an app

Driggsby hosts small static apps — dashboards, visualizations — each at
its own `driggsby.dev` address. Start one with:

```bash
npx driggsby@latest init your-app-name
```

This creates a working app — `index.html`, `app.js`, `styles.css`, and the
`driggsby.json` that names it. The app reads live data with one call,
`driggsby.watch(tool, params, callback)`, and shows sample data when opened
on its own.

Preview it with your real Driggsby data:

```bash
npx driggsby@latest dev
```

This runs the app locally, embedded exactly the way Driggsby embeds it
after a deploy, and reloads the page when you save a file. While dev runs,
the preview serves your financial data to this machine — other websites
can't reach it, but anything running locally can, so stop it when you're
done: press Ctrl+C, or from any terminal run `npx driggsby@latest dev --stop`.
It also stops on its own after 30 minutes with no page open.

## Deploying an app

From a folder holding a `driggsby.json`
(`{ "slug": "your-app-name", "serve": "." }`) and an `index.html`:

```bash
npx driggsby@latest deploy
```

The first deploy creates the app: Driggsby assigns its address — the name
you picked plus a unique ending, like
`your-app-name-x7k2qf.driggsby.dev` — and saves the assigned name back
into `driggsby.json`, so any readable name works and names never collide.
`deploy` prints the Driggsby page for the app first; that is where it runs
with your data. The `driggsby.dev` address is the app on its own, where it
gets no Driggsby data.
If the project lives in git, commit the updated `driggsby.json` — it is the
only record of your app's address, and a fresh checkout without it would
create a second app.
Every deploy after that uploads only the files that changed. Deploy with
`--preview` to upload a version without
changing what visitors see, `npx driggsby@latest versions` to list every
kept version, and `npx driggsby@latest rollback` to switch which one is
live — switching re-uploads nothing. `npx driggsby@latest query <tool>`
runs one read-only data tool and prints its result as JSON, the same
shape a `driggsby.watch` callback receives, so you can see the data
before writing any render code.

The CLI is pure TypeScript and installs from the npm registry alone — no
binary downloads, no install scripts — and runs on macOS, Linux, and Windows
with Node.js 18 or newer.

See the [GitHub repo](https://github.com/driggsby/driggsby) for
tools, examples, and full documentation.

## License

Apache-2.0
