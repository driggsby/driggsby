import assert from "node:assert/strict";
import { test } from "node:test";

import { describeDevice, knownDevice, type OsFacts } from "./device.ts";

function facts(overrides: Partial<OsFacts>): OsFacts {
  return {
    hostname: "mbp-studio",
    platform: "darwin",
    release: "24.6.0",
    version: "",
    readFile: () => null,
    ...overrides,
  };
}

const MAC_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>ProductName</key>
  <string>macOS</string>
  <key>ProductVersion</key>
  <string>15.6</string>
</dict></plist>`;

test("a Mac names itself and its macOS version from the system's own file", () => {
  const device = describeDevice(
    facts({
      hostname: "mbp-studio.local",
      readFile: (path) => (path === "/System/Library/CoreServices/SystemVersion.plist" ? MAC_PLIST : null),
    }),
  );

  assert.deepEqual(device, { name: "mbp-studio", system: "macOS 15.6" });
});

test("a Mac whose version file can't be read still says macOS", () => {
  assert.deepEqual(describeDevice(facts({})), { name: "mbp-studio", system: "macOS" });
});

test("Linux reads os-release's pretty name, without the codename in parentheses", () => {
  const osRelease = 'NAME="Debian GNU/Linux"\nPRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nVERSION_ID="12"\n';
  const device = describeDevice(
    facts({
      hostname: "devbox-02.corp.example.test",
      platform: "linux",
      readFile: (path) => (path === "/etc/os-release" ? osRelease : null),
    }),
  );

  assert.deepEqual(device, { name: "devbox-02", system: "Debian GNU/Linux 12" });
});

test("Linux without os-release says Linux", () => {
  assert.equal(describeDevice(facts({ platform: "linux" })).system, "Linux");
});

test("Linux reads CRLF files and the /usr/lib copy when /etc has none", () => {
  const crlf = 'NAME="Ubuntu"\r\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\r\n';
  const device = describeDevice(
    facts({ platform: "linux", readFile: (path) => (path === "/usr/lib/os-release" ? crlf : null) }),
  );

  assert.equal(device.system, "Ubuntu 24.04.1 LTS");
});

test("a Linux pretty name outside the safe characters still says Linux", () => {
  const popOs = 'PRETTY_NAME="Pop!_OS 22.04 LTS"\n';

  assert.equal(describeDevice(facts({ platform: "linux", readFile: () => popOs })).system, "Linux");
});

test("Windows reads 10 or 11 from its build number, and older versions as Windows", () => {
  assert.equal(describeDevice(facts({ platform: "win32", release: "10.0.22631" })).system, "Windows 11");
  assert.equal(describeDevice(facts({ platform: "win32", release: "10.0.19045" })).system, "Windows 10");
  assert.equal(describeDevice(facts({ platform: "win32", release: "6.3.9600" })).system, "Windows");
  assert.equal(describeDevice(facts({ platform: "win32", release: "unknown" })).system, "Windows");
  assert.equal(
    describeDevice(facts({ platform: "win32", release: "10.0.20348", version: "Windows Server 2022 Datacenter" })).system,
    "Windows Server",
  );
});

test("an overlong PRETTY_NAME line isn't parsed", () => {
  const long = `PRETTY_NAME="${"(".repeat(60_000)}"\n`;

  assert.equal(describeDevice(facts({ platform: "linux", readFile: () => long })).system, "Linux");
});

test("an address, a label spelling one out, digits, or localhost is no computer name", () => {
  const addresses = ["10.0.0.5", "192.168.1.20", "::1", "localhost", "localhost.localdomain", "10.0.0.5.nip.io", "1.2.3"];
  const spelled = ["ip-172-31-22-33.ec2.internal", "c-73-162-12-34.hsd1.example.test", "192-168-1-20"];
  for (const hostname of [...addresses, ...spelled]) {
    assert.equal(describeDevice(facts({ hostname })).name, null, hostname);
  }
});

test("reading the computer can never fail a command", () => {
  const throwing = facts({});
  Object.defineProperty(throwing, "hostname", {
    get: () => {
      throw new Error("ERR_SYSTEM_ERROR");
    },
  });

  assert.deepEqual(describeDevice(throwing), { name: null, system: null });
});

// The allowlists keep what leaves the CLI plain text: no character a
// shell, cmd.exe, or a header would treat specially.
test("no character a shell, cmd.exe, or a header treats specially ever gets through", () => {
  for (const special of ["%", "!", "^", "&", "|", "<", ">", '"', "\\", ":", "\t", "\r", "\n", "(", ")", "$", "`"]) {
    assert.equal(describeDevice(facts({ hostname: `host${special}x` })).name, null, JSON.stringify(special));
    // In os-release a line break ends the value, so it can't carry one.
    if (special !== "\n" && special !== "\r") {
      const release = `PRETTY_NAME="Distro${special}x 1"\n`;
      assert.equal(describeDevice(facts({ platform: "linux", readFile: () => release })).system, "Linux", JSON.stringify(special));
    }
  }
});

test("a name or system outside the safe characters is left out, never cleaned into something else", () => {
  const hostile = describeDevice(
    facts({
      hostname: "evil&calc|x",
      platform: "linux",
      readFile: () => 'PRETTY_NAME="Ubuntu 24.04 & friends"\n',
    }),
  );

  assert.deepEqual(hostile, { name: null, system: "Linux" });
  assert.equal(describeDevice(facts({ hostname: "" })).name, null);
  assert.equal(describeDevice(facts({ hostname: "a".repeat(80) })).name, null);
  assert.equal(describeDevice(facts({ platform: "aix" })).system, null);
});

test("the sign-in carries only what is known", () => {
  assert.deepEqual(knownDevice({ name: "mbp-studio", system: null }), { name: "mbp-studio" });
  assert.equal(knownDevice({ name: null, system: null }), null);
});
