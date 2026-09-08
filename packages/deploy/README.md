# @driggsby/deploy

The deploy protocol client for [Driggsby](https://driggsby.com) apps — small
static web apps, each served at its own `driggsby.dev` address, with live
data through the Driggsby SDK. Driggsby assigns every app's address at
first deploy: the readable name from `driggsby.json` plus a unique ending,
like `money-dash-x7k2qf.driggsby.dev`, saved back into `driggsby.json`.

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
folder, and makes it live. It prints two addresses: the app's page in
Driggsby first, where it runs with the person's data, then the app's own
`driggsby.dev` address, which shows no Driggsby data when opened
directly. A first deploy creates the app and saves its
assigned address back into `driggsby.json` — keep (commit) that updated
file, because it is the only record of the app's address; a checkout that
discards it makes the next deploy create a second app at a new address.

## As a library

```ts
import {
  collectDeployFiles,
  deployProjectFiles,
  readProjectConfig,
} from "@driggsby/deploy";

const projectDirectory = process.cwd();
const config = await readProjectConfig(projectDirectory);
const collected = await collectDeployFiles(config.serveDirectory);
const { outcome } = await deployProjectFiles(
  { baseUrl: "https://app.driggsby.com", token },
  projectDirectory,
  config.slug,
  collected,
  { live: true },
);
```

`collectDeployFiles` walks the serve folder (skipping dotfiles, symlinks,
node_modules, and `driggsby.json`), hashes every file, and enforces the
deploy limits locally.
`deployProjectFiles` offers the manifest, creates the app on first deploy
(persisting the assigned slug into `driggsby.json` before any upload),
uploads only content Driggsby doesn't already have, and finalizes the
version.

Zero runtime dependencies; Node.js 18 or newer; macOS, Linux, and Windows.

## License

Apache-2.0
