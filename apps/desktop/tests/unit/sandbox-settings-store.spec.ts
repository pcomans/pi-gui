import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { SandboxSettingsStore } from "../../electron/sandbox/sandbox-settings-store";
import { normalizeSandboxHost, sandboxHostMatches } from "../../contracts/sandbox";

const repo = "/work/repo";
const thread = { workspaceId: "ws", sessionId: "s1" };

async function freshStore(): Promise<{ store: SandboxSettingsStore; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "sandbox-settings-"));
  const store = new SandboxSettingsStore(dir);
  await store.load();
  return { store, dir };
}

test("allows every host by default and records each one", async () => {
  const { store } = await freshStore();
  expect(store.decide(repo, "Example.COM", thread).allowed).toBe(true);
  expect(store.decide(repo, "example.com", thread).allowed).toBe(true);
  const [record] = store.repoRecords([]);
  expect(record?.effectiveMode).toBe("allow-all");
  expect(record?.hosts).toEqual([
    expect.objectContaining({ host: "example.com", allowedCount: 2, blockedCount: 0 }),
  ]);
});

test("a blocked host is refused immediately, even in allow-all mode", async () => {
  const { store } = await freshStore();
  await store.update({ kind: "host-rule", repoPath: repo, host: "evil.test", rule: "block" });
  const verdict = store.decide(repo, "evil.test", thread);
  expect(verdict).toEqual({ allowed: false, reason: "evil.test is blocked for this repository" });
  expect(store.decide("/work/other", "evil.test", thread).allowed).toBe(true);
  await store.update({ kind: "host-rule", repoPath: repo, host: "evil.test", rule: null });
  expect(store.decide(repo, "evil.test", thread).allowed).toBe(true);
});

test("allowlist mode refuses unlisted hosts until they are allowed", async () => {
  const { store } = await freshStore();
  await store.update({ kind: "repo-network-mode", repoPath: repo, mode: "allowlist" });
  expect(store.decide(repo, "registry.npmjs.org", thread).allowed).toBe(false);
  await store.update({ kind: "host-rule", repoPath: repo, host: "*.npmjs.org", rule: "allow" });
  expect(store.decide(repo, "registry.npmjs.org", thread).allowed).toBe(true);
  expect(store.decide(repo, "npmjs.org.evil.test", thread).allowed).toBe(false);
  const record = store.repoRecords([]).find((entry) => entry.repoPath === repo);
  expect(record?.hosts.find((entry) => entry.host === "registry.npmjs.org")).toMatchObject({
    allowedCount: 1,
    blockedCount: 1,
  });
});

test("the default mode applies to repositories without an override", async () => {
  const { store } = await freshStore();
  await store.update({ kind: "default-network-mode", mode: "allowlist" });
  expect(store.decide(repo, "example.com", thread).allowed).toBe(false);
  await store.update({ kind: "repo-network-mode", repoPath: repo, mode: "allow-all" });
  expect(store.decide(repo, "example.com", thread).allowed).toBe(true);
  await store.update({ kind: "repo-network-mode", repoPath: repo, mode: null });
  expect(store.decide(repo, "example.com", thread).allowed).toBe(false);
});

test("settings and the host log survive a restart", async () => {
  const { store, dir } = await freshStore();
  await store.update({ kind: "enabled", enabled: false });
  await store.update({ kind: "host-rule", repoPath: repo, host: "a.test", rule: "block" });
  store.decide(repo, "a.test", thread);
  await store.flush();
  const reopened = new SandboxSettingsStore(dir);
  await reopened.load();
  expect(reopened.enabled(true)).toBe(false);
  expect(reopened.decide(repo, "a.test", thread).allowed).toBe(false);
  expect(reopened.repoRecords([])[0]?.hosts[0]).toMatchObject({ host: "a.test", blockedCount: 2 });
  const log = await readFile(join(dir, "network-log.json"), "utf8");
  expect(log).not.toContain("http");
});

test("an invalid settings file is refused and kept", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sandbox-settings-"));
  const original = '{"version":1,"defaultNetworkMode":"sometimes","repos":{}}\n';
  await writeFile(join(dir, "sandbox-settings.json"), original);
  await expect(new SandboxSettingsStore(dir).load()).rejects.toThrow(/Invalid sandbox settings/);
  expect(await readFile(join(dir, "sandbox-settings.json"), "utf8")).toBe(original);
});

test("host names are normalized and wildcards match like Gondolin's", () => {
  expect(normalizeSandboxHost(" API.GitHub.com. ")).toBe("api.github.com");
  expect(normalizeSandboxHost("https://x.test")).toBeUndefined();
  expect(normalizeSandboxHost("a..b")).toBeUndefined();
  expect(sandboxHostMatches("api.github.com", "*.github.com")).toBe(true);
  expect(sandboxHostMatches("github.com", "*.github.com")).toBe(false);
  expect(sandboxHostMatches("anything", "*")).toBe(true);
});
