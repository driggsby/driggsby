import assert from "node:assert/strict";
import { test } from "node:test";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

import { type CaListApi, isDistrustedRoot, mayUseOpenSslStore, removeDistrustedRoots } from "./distrusted-roots.ts";
import {
  CAN_SET_THE_LIST,
  DISTRUSTED_ROOT_PEMS,
  distrustedRootsLeftAfter,
  ROOTS_LEFT_AFTER_A_BIN,
} from "./test-support/distrusted-roots-probe.ts";

// emSign ECC Root CA - G3, then AAA Certificate Services.
const [EMSIGN_ECC_G3 = "", AAA_SERVICES = ""] = DISTRUSTED_ROOT_PEMS;
const [ROOT_A = "", ROOT_B = ""] = tls.rootCertificates.filter((pem) => !isDistrustedRoot(pem));
const DEPLOY_BIN = fileURLToPath(new URL("../bin/driggsby-deploy.js", import.meta.url));
const officialStore = (): boolean => false;

interface FakeList {
  listed: string[];
  bundled?: string[];
  extra?: string[];
}

// A fake CA list; records every list the code sets.
function fake({ listed, bundled = listed, extra = [] }: FakeList): { api: CaListApi; set: string[][] } {
  const set: string[][] = [];
  const api: CaListApi = {
    getCACertificates: (type) => (type === "bundled" ? bundled : type === "extra" ? extra : listed),
    setDefaultCACertificates: (certs) => {
      set.push(certs);
    },
  };
  return { api, set };
}

test("isDistrustedRoot matches exactly the two compromised roots", () => {
  assert.equal(isDistrustedRoot(EMSIGN_ECC_G3), true);
  assert.equal(isDistrustedRoot(AAA_SERVICES), true);
  assert.notEqual(ROOT_A, "");
  assert.equal(isDistrustedRoot(ROOT_A), false);
  assert.equal(isDistrustedRoot("not a certificate"), false);
});

test("removeDistrustedRoots drops only the compromised roots", () => {
  const { api, set } = fake({ listed: [ROOT_A, EMSIGN_ECC_G3, AAA_SERVICES] });
  removeDistrustedRoots(api, officialStore);
  assert.deepEqual(set, [[ROOT_A]]);
});

test("removeDistrustedRoots keeps the extra CAs and matches by content, not text", () => {
  // Node.js re-serializes the list once it has been set.
  const { api, set } = fake({
    listed: [`\n${ROOT_A}\n`, EMSIGN_ECC_G3, ROOT_B],
    bundled: [ROOT_A, EMSIGN_ECC_G3],
    extra: [ROOT_B],
  });
  removeDistrustedRoots(api, officialStore);
  assert.deepEqual(set, [[`\n${ROOT_A}\n`, ROOT_B]]);
});

test("removeDistrustedRoots leaves a clean list alone", () => {
  const { api, set } = fake({ listed: [ROOT_A] });
  removeDistrustedRoots(api, officialStore);
  assert.deepEqual(set, []);
});

test("mayUseOpenSslStore spots builds that may verify against OpenSSL's store", () => {
  const build = (shared: unknown, defines: unknown): boolean =>
    mayUseOpenSslStore({ variables: { node_shared_openssl: shared }, target_defaults: { defines } });
  assert.equal(build(false, ["NODE_OPENSSL_CONF_NAME=nodejs_conf"]), false);
  assert.equal(build(true, []), true);
  assert.equal(build(false, ["NODE_OPENSSL_CERT_STORE"]), true);
  assert.equal(build(true, ["NODE_OPENSSL_CERT_STORE"]), true);
  // A runtime whose build configuration doesn't say.
  assert.equal(build(undefined, []), true);
  assert.equal(build(false, undefined), true);
});

test("removeDistrustedRoots leaves a build that may use OpenSSL's store alone", () => {
  // Such builds report the bundled list but verify against OpenSSL's
  // store; replacing the list would drop that store.
  const { api, set } = fake({ listed: [ROOT_A, EMSIGN_ECC_G3] });
  removeDistrustedRoots(api, () => true);
  assert.deepEqual(set, []);
});

test("removeDistrustedRoots leaves a list missing any bundled root alone", () => {
  // Under --use-openssl-ca the default list holds only the extra CAs, and
  // replacing it would drop OpenSSL's store.
  const none = fake({ listed: [ROOT_B, EMSIGN_ECC_G3, AAA_SERVICES], bundled: [ROOT_A], extra: [ROOT_B] });
  removeDistrustedRoots(none.api, officialStore);
  assert.deepEqual(none.set, []);
  const some = fake({ listed: [ROOT_A, EMSIGN_ECC_G3], bundled: [ROOT_A, ROOT_B] });
  removeDistrustedRoots(some.api, officialStore);
  assert.deepEqual(some.set, []);
});

test("removeDistrustedRoots leaves a list that is only the extra CAs alone", () => {
  // --use-openssl-ca with extra CAs that happen to include every bundled root.
  const extra = [ROOT_A, ROOT_B, EMSIGN_ECC_G3];
  const { api, set } = fake({ listed: extra, bundled: [ROOT_A, ROOT_B], extra });
  removeDistrustedRoots(api, officialStore);
  assert.deepEqual(set, []);
});

test("removeDistrustedRoots never sets an empty list", () => {
  const { api, set } = fake({ listed: [EMSIGN_ECC_G3, AAA_SERVICES], bundled: [] });
  removeDistrustedRoots(api, officialStore);
  assert.deepEqual(set, []);
});

test("removeDistrustedRoots is a silent no-op where Node.js can't change the list or read its build", () => {
  const { api, set } = fake({ listed: [ROOT_A, EMSIGN_ECC_G3] });
  assert.doesNotThrow(() => {
    removeDistrustedRoots({}, officialStore);
    removeDistrustedRoots(api, () => {
      throw new Error("no build config");
    });
    removeDistrustedRoots(
      {
        getCACertificates: () => {
          throw new Error("unreadable");
        },
        setDefaultCACertificates: () => undefined,
      },
      officialStore,
    );
  });
  assert.deepEqual(set, []);
});

test("driggsby-deploy removes the compromised roots before it runs, where it should", { skip: !CAN_SET_THE_LIST }, () => {
  // The control: a script that doesn't remove them keeps both.
  const control = distrustedRootsLeftAfter(["-e", "0"]);
  assert.equal(control.left, 2, control.stderr);
  const deploy = distrustedRootsLeftAfter([DEPLOY_BIN, "--help"]);
  assert.equal(deploy.left, ROOTS_LEFT_AFTER_A_BIN, deploy.stderr);
});
