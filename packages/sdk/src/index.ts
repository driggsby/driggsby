// Public exports of @driggsby/sdk for bundler users and for the driggsby
// CLI's local dev host. Browser apps normally don't import this package at
// all — they load the runtime with one tag:
//
//   <script type="module" src="/-/driggsby-sdk.js"></script>
//
// which Driggsby serves on the app's own origin (and `driggsby dev` serves
// locally from this package's bundled copy at dist/driggsby-sdk.js).
export {
  MAX_WATCHES,
  PROTOCOL,
  SdkCore,
  isAllowedHostOrigin,
  isLocalAppHostname,
  type PostFunction,
  type WatchCallback,
} from "./sdk-core.ts";
