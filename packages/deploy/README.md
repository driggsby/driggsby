# @driggsby/deploy

The deploy protocol client for [Driggsby](https://driggsby.com) apps — small
static web apps served at `https://<slug>.driggsby.dev`, with live data
through the Driggsby SDK.

Most people want the full CLI instead:

```bash
npx driggsby@latest login
npx driggsby@latest deploy
```

This package exists for two narrower uses.

## One-command deploys in Node-only sandboxes

In an environment that can't run a browser sign-in but can hold a token in
`DRIGGSBY_TOKEN`:

```bash
npx @driggsby/deploy
```

This reads `driggsby.json` in the current directory, deploys the `serve`
folder, and makes it live.

## As a library

```ts
import {
  collectDeployFiles,
  deployCollectedFiles,
  readProjectConfig,
} from "@driggsby/deploy";

const config = await readProjectConfig(process.cwd());
const collected = await collectDeployFiles(config.serveDirectory);
const outcome = await deployCollectedFiles(
  { baseUrl: "https://app.driggsby.com", token },
  config.slug,
  collected,
  { live: true },
);
```

`collectDeployFiles` walks the serve folder (skipping dotfiles, symlinks,
node_modules, and `driggsby.json`), hashes every file, and enforces the
deploy limits locally.
`deployCollectedFiles` offers the manifest, uploads only content Driggsby
doesn't already have, and finalizes the version.

Zero runtime dependencies; Node.js 18 or newer; macOS, Linux, and Windows.

## License

Apache-2.0
