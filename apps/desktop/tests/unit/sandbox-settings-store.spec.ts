import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { SandboxSettingsStore } from "../../electron/sandbox/sandbox-settings-store";
import { normalizeSandboxHost } from "../../contracts/sandbox";

const repo = "/work/repo";
const thread = { workspaceId: "ws", sessionId: "s1" };

async function freshStore(): Promise<{ store: SandboxSettingsStore; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "sandbox-settings-"));
  const store = new SandboxSettingsStore(dir);
  await store.load();
  return { store, dir };
}

test("repositories have no host rules by default", async () => {
  const { store } = await freshStore();
  expect(store.rulesFor(repo)).toEqual({ allowedHosts: [], blockedHosts: [] });
});

test("blocked hosts belong to one repository and can be unblocked", async () => {
  const { store } = await freshStore();
  await store.update({ kind: "host-rule", repoPath: repo, host: "Evil.TEST", rule: "block" });
  await store.update({ kind: "host-rule", repoPath: repo, host: "evil.test", rule: "block" });
  expect(store.rulesFor(repo).blockedHosts).toEqual(["evil.test"]);
  expect(store.rulesFor("/work/other").blockedHosts).toEqual([]);
  await store.update({ kind: "host-rule", repoPath: repo, host: "evil.test", rule: null });
  expect(store.rulesFor(repo).blockedHosts).toEqual([]);
});

test("only services on this Mac can be allowed, and blocking one withdraws the allow", async () => {
  const { store } = await freshStore();
  await expect(
    store.update({ kind: "host-rule", repoPath: repo, host: "x.test", rule: "allow" }),
  ).rejects.toThrow(/Only host.docker.internal and localhost can be allowed/);
  await store.update({ kind: "host-rule", repoPath: repo, host: "LOCALHOST", rule: "allow" });
  expect(store.rulesFor(repo)).toEqual({ allowedHosts: ["localhost"], blockedHosts: [] });
  await store.update({ kind: "host-rule", repoPath: repo, host: "localhost", rule: "block" });
  expect(store.rulesFor(repo)).toEqual({ allowedHosts: [], blockedHosts: [] });
});

test("a settings file from the Allowlist era loads and its mode fields are ignored", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sandbox-settings-"));
  await writeFile(
    join(dir, "sandbox-settings.json"),
    `${JSON.stringify({
      version: 1,
      enabled: true,
      defaultNetworkMode: "allowlist",
      repos: {
        [repo]: {
          mode: "allowlist",
          allowedHosts: ["*.npmjs.org", "host.docker.internal"],
          blockedHosts: ["evil.test"],
        },
      },
    })}\n`,
  );
  const store = new SandboxSettingsStore(dir);
  await store.load();
  expect(store.enabled(false)).toBe(true);
  expect(store.rulesFor(repo)).toEqual({
    allowedHosts: ["host.docker.internal"],
    blockedHosts: ["evil.test"],
  });
  expect(store.repoRecords([])[0]).not.toHaveProperty("mode");
  // The next save writes the current format.
  await store.update({ kind: "host-rule", repoPath: repo, host: "b.test", rule: "block" });
  const saved = await readFile(join(dir, "sandbox-settings.json"), "utf8");
  expect(saved).not.toContain("allowlist");
  expect(saved).not.toContain("npmjs");
});

test("the host log adds counts per repository, newest first", async () => {
  const { store } = await freshStore();
  store.record(repo, "Example.COM", true, thread, 3, "2026-10-09T10:00:00.000Z");
  store.record(repo, "example.com", false, thread, 1, "2026-10-09T10:01:00.000Z");
  store.record(repo, "other.test", true, thread, 1, "2026-10-09T09:00:00.000Z");
  const [record] = store.repoRecords([]);
  expect(record?.hosts.map((host) => host.host)).toEqual(["example.com", "other.test"]);
  expect(record?.hosts[0]).toMatchObject({
    allowedCount: 3,
    blockedCount: 1,
    firstSeenAt: "2026-10-09T10:00:00.000Z",
    lastSeenAt: "2026-10-09T10:01:00.000Z",
    lastSessionId: "s1",
  });
});

test("settings and the host log survive a restart", async () => {
  const { store, dir } = await freshStore();
  await store.update({ kind: "enabled", enabled: false });
  await store.update({ kind: "host-rule", repoPath: repo, host: "a.test", rule: "block" });
  store.record(repo, "a.test", false, thread);
  await store.flush();
  const reopened = new SandboxSettingsStore(dir);
  await reopened.load();
  expect(reopened.enabled(true)).toBe(false);
  expect(reopened.rulesFor(repo).blockedHosts).toEqual(["a.test"]);
  expect(reopened.repoRecords([])[0]?.hosts[0]).toMatchObject({ host: "a.test", blockedCount: 1 });
  expect(await readFile(join(dir, "network-log.json"), "utf8")).not.toContain("http");
});

test("an invalid settings file is refused and kept", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sandbox-settings-"));
  const original = '{"version":1,"enabled":"sometimes","repos":{}}\n';
  await writeFile(join(dir, "sandbox-settings.json"), original);
  await expect(new SandboxSettingsStore(dir).load()).rejects.toThrow(/Invalid sandbox settings/);
  expect(await readFile(join(dir, "sandbox-settings.json"), "utf8")).toBe(original);
});

test("host names are normalized and URLs are refused", () => {
  expect(normalizeSandboxHost(" API.GitHub.com. ")).toBe("api.github.com");
  expect(normalizeSandboxHost("*.github.com")).toBe("*.github.com");
  expect(normalizeSandboxHost("https://x.test")).toBeUndefined();
  expect(normalizeSandboxHost("a..b")).toBeUndefined();
});
