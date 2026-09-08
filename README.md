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

## Sign in

Some driggsby commands work with your Driggsby account directly and need
an app token saved on your machine:

```bash
npx driggsby@latest login
```

This opens a Driggsby approval page in your browser. Approving it saves an
app token in your platform keychain when one is available (the macOS
keychain, or the Linux keyring via `secret-tool`), otherwise in
`~/.driggsby/credentials.json` readable only by your account. The token is
never printed. `npx driggsby@latest logout` removes it.

`mcp setup` does not need this — client OAuth stays managed by your AI
client.

## Building an app

Driggsby hosts small static apps — dashboards, visualizations — each at
its own `driggsby.dev` address. Start one with:

```bash
npx driggsby@latest init your-app-name
```

This creates a working app — `index.html`, `app.js`, `styles.css`, and the
`driggsby.json` that names it. The app reads live data with one call,
`driggsby.watch(tool, params, callback)`, and shows sample data when opened
on its own. Preview it with your real data:

```bash
npx driggsby@latest dev
```

This runs the app locally, embedded exactly the way Driggsby embeds it
after a deploy — the app on its own local origin, your data flowing through
the same protocol — and reloads the page when you save a file. Your app
token stays in the CLI process; it never appears in a page. While `dev`
runs, the preview serves your financial data to this machine — other
websites can't reach it, but anything running locally can, so stop it when
you're done: press Ctrl+C, or from any terminal run
`npx driggsby@latest dev --stop`. It also stops on its own after 30 minutes
with no page open.

## Deploying an app

From a folder holding a `driggsby.json`
(`{ "slug": "your-app-name", "serve": "." }`) and an `index.html`:

```bash
npx driggsby@latest deploy
```

The first deploy creates the app. Driggsby assigns its address — the name
you picked plus a unique ending, like
`your-app-name-x7k2qf.driggsby.dev` — and saves the assigned name back
into `driggsby.json`, so any readable name works and names never collide.
`deploy` prints the Driggsby page for the app first; that is where it runs
with your data. The `driggsby.dev` address is the app on its own, which
shows no Driggsby data when opened directly.
Every deploy after that uploads only the files that changed. Related
commands:

```bash
# Upload a version without changing what visitors see
npx driggsby@latest deploy --preview

# List every kept version and which one is live
npx driggsby@latest versions

# Switch which version is live (nothing re-uploads)
npx driggsby@latest rollback --to 3

# Permanently remove a deployed app (asks you to type its name back)
npx driggsby@latest delete

# Print one tool's result as JSON: the shape a watch callback receives
npx driggsby@latest query get_overview
```

Dotfiles, symlinks, and node_modules never upload, and the folder must stay
within 52.4 MB across at most 2,000 files (26.2 MB per file) — the same
figures the CLI quotes when a deploy is over a limit.

## Tools

Includes tools like:

| Tool | Description |
|---|---|
| `get_overview` | Balances, accounts, net worth |
| `search_cash_transactions` | Search and filter across all accounts |
| `query_cash_sql` | SQL over transaction data |
| `list_recurring_transactions` | Subscriptions and recurring payments |
| `list_investment_holdings` | Portfolio positions |
| `list_outstanding_debts` | Balances, rates, minimums |
| `query_investment_sql` | SQL over investment data |

## Examples

- "What's my net worth across all accounts?"
- "How much did I spend on dining out last month?"
- "List every recurring subscription."
- "Find every Amazon charge over $100 this year."
- "Show my top 10 merchants by total spend this year."

## Options

```bash
# Claude Code scope (user by default, local for project-only)
npx driggsby@latest mcp setup claude-code -s local

# Print the native command without running it
npx driggsby@latest mcp setup codex --print
```

## Security

Read-only via Plaid. Cannot move money, initiate transfers, or make trades.
See [driggsby.com](https://driggsby.com) for details.

The app token that `driggsby login` saves stays on your machine and is never
printed; see [Sign in](#sign-in) above for exactly where it is stored and how
to remove it.

## License

Apache-2.0 — see [LICENSE](LICENSE).
