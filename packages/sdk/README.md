# @driggsby/sdk

The browser SDK for [Driggsby](https://driggsby.com) apps — small static
web apps, each served at its own `driggsby.dev` address, that show live
financial data.

Most apps never install this package. Driggsby serves the SDK to every
deployed app on the app's own origin, so one tag is the entire setup:

```html
<script type="module" src="/-/driggsby-sdk.js"></script>
```

and reading live data is one call:

```js
driggsby.watch("list_accounts", {}, (result) => render(result));
```

Every `watch` is a live subscription: when the underlying data changes,
the callback runs again with fresh data. It returns an unsubscribe
function. Identical results are deduped, so unchanged data never
re-renders.

To show a section's own failure, pass `onError`. It runs when a watch
fails, after any retries the host makes, with `{ message, kind }`. A
repeat of the same failure is skipped. `kind` is `"timeout"`,
`"unavailable"`, `"busy"`, `"rate_limited"` or `null`. Under
`driggsby dev`, which doesn't retry, `kind` is always `null`. The next
successful result always reaches your callback, even when it matches
the data from before the failure, so clear the failure there. Show
`error.message` as text (for example with `textContent`), never as
HTML:

```js
driggsby.watch("list_accounts", {}, render, {
  onError: (error) => showFailure(error.message),
});
```

This package exists for two narrower uses:

- `driggsby dev` serves the same runtime locally from this package's
  bundled copy, so an app under development behaves exactly like a
  deployed one.
- Bundler users can `import type` the SDK surface, or import `SdkCore`
  to embed the protocol runtime in their own tooling.

```ts
import { PROTOCOL, SdkCore } from "@driggsby/sdk";
```

The SDK speaks the frozen `driggsby-sdk/1` postMessage protocol with the
embedding Driggsby host page. Security properties worth knowing: the SDK
only ever talks to its parent window, only after the host proves itself
from an allowed origin (the Driggsby console, or a loopback host page
during local development), and it pins the first valid host origin for
the life of the page.
