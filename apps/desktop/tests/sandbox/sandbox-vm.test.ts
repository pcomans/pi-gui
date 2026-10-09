import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SandboxOwner } from "../../electron/sandbox/sandbox-owner";

/**
 * Drives the sandbox extension against real Gondolin VMs; needs QEMU. Run with
 * `pnpm --filter @pi-gui/desktop test:sandbox-vm`. The first run builds the base image.
 */

interface RegisteredTool {
  readonly name: string;
  readonly exposure?: string;
  execute(
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: unknown,
  ): Promise<{ content: { type: string; text?: string }[] }>;
}

type Handler = (event: unknown, ctx: unknown) => unknown;

function fakePi() {
  const tools = new Map<string, RegisteredTool>();
  const handlers = new Map<string, Handler[]>();
  const statuses: string[] = [];
  const api = {
    registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
    on: (event: string, handler: Handler) =>
      handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    registerCommand: () => undefined,
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: "",
    hasUI: true,
    sessionManager: {
      getSessionId: () => "session-1",
      getSessionFile: () => undefined,
      getCwd: () => worktree,
    },
    ui: { setStatus: (_key: string, text: string) => statuses.push(text), notify: () => undefined },
  };
  const emit = (event: string, payload: unknown = {}) =>
    Promise.all((handlers.get(event) ?? []).map((handler) => handler(payload, ctx)));
  return { api, tools, emit, statuses, ctx };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

let root: string;
let mainRepo: string;
let worktree: string;
let owner: SandboxOwner;
let pi: ReturnType<typeof fakePi>;

async function run(tool: string, params: Record<string, unknown>): Promise<string> {
  const result = await pi.tools.get(tool)!.execute("call", params, undefined, undefined, pi.ctx);
  return result.content.map((part) => part.text ?? "").join("");
}

async function setUp(): Promise<void> {
  root = await realpath(await mkdtemp(join(tmpdir(), "pi-gui-sandbox-vm-")));
  // The sandbox asks the host's gh for a token; keep the person's real login out of tests.
  process.env.GH_CONFIG_DIR = join(root, "gh-config");
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  mainRepo = join(root, "repo");
  worktree = join(root, "repo-wt");
  await mkdir(mainRepo);
  git(mainRepo, "init", "-q", "-b", "main");
  git(mainRepo, "config", "user.name", "Sandbox Tester");
  git(mainRepo, "config", "user.email", "sandbox@example.invalid");
  await writeFile(join(mainRepo, "README.md"), "hello\n");
  git(mainRepo, "add", ".");
  git(mainRepo, "commit", "-qm", "init");
  git(mainRepo, "worktree", "add", "-q", "-b", "feature", worktree);

  owner = new SandboxOwner({ userDataDir: join(root, "user-data"), enabledByDefault: true });
  await owner.initialize();
  pi = fakePi();
  const [extension] = owner.sessionExtensions({ workspaceId: "ws", path: worktree });
  // The lint project cannot resolve pi's InlineExtension type, so name the factory's shape here.
  const factory = extension!.factory as (api: ExtensionAPI) => unknown;
  await factory(pi.api);
  await pi.emit("session_start");
}

await setUp();

await test("bash runs in a Linux VM at the checkout's own path", async () => {
  const output = await run("bash", { command: "uname -s; pwd; pnpm --version" });
  assert.match(output, /Linux/);
  assert.match(output, /\n\d+\.\d+\.\d+/);
  assert.ok(output.includes(worktree), output);
  assert.ok(pi.statuses.includes("Sandbox: on"), pi.statuses.join());
});

await test("git works in a linked worktree and commits as the person", async () => {
  const output = await run("bash", {
    command:
      "echo change > note.txt && git add note.txt && git commit -qm sandboxed && git log -1 --format='%an <%ae>'",
  });
  assert.ok(output.includes("Sandbox Tester <sandbox@example.invalid>"), output);
  assert.equal(git(mainRepo, "log", "-1", "--format=%s", "feature"), "sandboxed");
});

await test("file tools read and write the host checkout", async () => {
  await run("write", { path: "from-tool.txt", content: "written in the VM\n" });
  assert.equal(await readFile(join(worktree, "from-tool.txt"), "utf8"), "written in the VM\n");
  await writeFile(join(worktree, "from-host.txt"), "written on the host\n");
  assert.match(await run("read", { path: join(worktree, "from-host.txt") }), /written on the host/);
});

await test("the rest of the host is out of reach", async () => {
  const outside = join(root, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "secret.txt"), "host secret\n");
  await symlink(outside, join(worktree, "escape"));
  const output = await run("bash", {
    command: `ls ${homedir()} 2>&1; cat ${join(outside, "secret.txt")} 2>&1; cat escape/secret.txt 2>&1; true`,
  });
  assert.ok(!output.includes("host secret"), output);
  await assert.rejects(run("read", { path: join(outside, "secret.txt") }));
  await assert.rejects(run("read", { path: join(worktree, "escape", "secret.txt") }));
});

await test("grep, find and ls are withdrawn and ! commands are claimed", async () => {
  for (const name of ["grep", "find", "ls"]) {
    assert.equal(pi.tools.get(name)?.exposure, "hidden");
  }
  const [claim] = await pi.emit("user_bash", { command: "pwd" });
  assert.equal(typeof (claim as { operations?: { exec?: unknown } }).operations?.exec, "function");
});

await test("network rules apply to the running VM and every host is logged", async () => {
  await owner.update({ kind: "host-rule", repoPath: mainRepo, host: "example.com", rule: "block" });
  const output = await run("bash", {
    command:
      "curl -sS https://example.com/; curl -sS -o /dev/null -w '%{http_code}' https://example.org/",
  });
  assert.match(output, /Blocked by the pi-gui sandbox network policy/);
  assert.match(output, /200/);
  const repo = (await owner.snapshot()).repos.find((entry) => entry.repoPath === mainRepo);
  assert.equal(repo?.hosts.find((entry) => entry.host === "example.com")?.blockedCount, 1);
  assert.equal(repo?.hosts.find((entry) => entry.host === "example.org")?.allowedCount, 1);
});

await test("closing the app stops every VM", async () => {
  await owner.closeAll();
  assert.deepEqual((await owner.snapshot()).sessions, []);
  await assert.rejects(run("bash", { command: "true" }), /closed/);
});
