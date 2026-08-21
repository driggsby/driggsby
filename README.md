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
