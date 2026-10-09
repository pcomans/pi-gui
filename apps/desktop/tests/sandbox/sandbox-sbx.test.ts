import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SandboxOwner } from "../../electron/sandbox/sandbox-owner";

/**
 * Drives the sandbox extension against real Docker sandboxes; needs sbx installed and signed in.
 * Run with `pnpm --filter @pi-gui/desktop test:sandbox`. It removes only the sandboxes it
 * created (those mounting its temp folder).
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
      getSessionId: () => sessionId,
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

const sessionId = `test-${randomUUID()}`;
let root: string;
let mainRepo: string;
let worktree: string;
let owner: SandboxOwner;
let pi: ReturnType<typeof fakePi>;

async function run(
  tool: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  const result = await pi.tools.get(tool)!.execute("call", params, signal, undefined, pi.ctx);
  return result.content.map((part) => part.text ?? "").join("");
}

interface SbxSandbox {
  readonly name: string;
  readonly status: string;
  readonly workspaces?: readonly string[];
}

function ownSandboxes(): SbxSandbox[] {
  const listed = JSON.parse(execFileSync("sbx", ["ls", "--json"], { encoding: "utf8" })) as {
    sandboxes?: SbxSandbox[];
  };
  return (listed.sandboxes ?? []).filter(
    (sandbox) =>
      sandbox.name.startsWith("pi-gui-") &&
      (sandbox.workspaces ?? []).some((workspace) => workspace.startsWith(root)),
  );
}

async function setUp(): Promise<void> {
  root = await realpath(await mkdtemp(join(tmpdir(), "pi-gui-sandbox-sbx-")));
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

try {
  await test("bash runs in Linux at the checkout's own path, with pnpm", async () => {
    const output = await run("bash", { command: "uname -s; pwd; pnpm --version" });
    assert.match(output, /Linux/);
    assert.ok(output.includes(worktree), output);
    assert.match(output, /\n\d+\.\d+\.\d+/);
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
    await run("write", { path: "from-tool.txt", content: "written in the sandbox\n" });
    assert.equal(
      await readFile(join(worktree, "from-tool.txt"), "utf8"),
      "written in the sandbox\n",
    );
    await writeFile(join(worktree, "from-host.txt"), "written on the host\n");
    assert.match(
      await run("read", { path: join(worktree, "from-host.txt") }),
      /written on the host/,
    );
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
    assert.equal(
      typeof (claim as { operations?: { exec?: unknown } }).operations?.exec,
      "function",
    );
  });

  await test("write and edit refuse paths outside the checkout instead of faking success", async () => {
    await assert.rejects(
      run("write", { path: join(root, "elsewhere.txt"), content: "x" }),
      /outside this thread's checkout/,
    );
    assert.match(await run("write", { path: "/tmp/scratch.txt", content: "ok" }), /Successfully/);
  });

  await test("Stop kills the command inside the sandbox", async () => {
    const controller = new AbortController();
    const running = run("bash", { command: "sleep 300; echo finished" }, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    controller.abort();
    await assert.rejects(running);
    // The bracket keeps grep from matching its own command line.
    const left = await run("bash", { command: "ps -eo args | grep '[s]leep 300' || echo none" });
    assert.match(left, /none/);
  });

  await test("git in one worktree's sandbox cannot prune another worktree", async () => {
    const other = join(root, "repo-other");
    git(mainRepo, "worktree", "add", "-q", "-b", "other", other);
    // A new start reads the worktree list again and protects the new one.
    await pi.emit("session_shutdown");
    await pi.emit("session_start");
    await run("bash", { command: "git worktree prune -v 2>&1; git gc --quiet 2>&1; true" });
    assert.match(git(other, "status", "--short", "--branch"), /## other/);
  });

  await test("network rules apply to the running sandbox and hosts are logged", async () => {
    await owner.update({
      kind: "host-rule",
      repoPath: mainRepo,
      host: "example.com",
      rule: "block",
    });
    const output = await run("bash", {
      command:
        "curl -sS -m 20 https://example.com/ 2>&1; echo; curl -sS -m 20 -o /dev/null -w '%{http_code}' https://example.org/",
    });
    assert.match(output, /Blocked/i);
    assert.match(output, /200/);
    const repo = (await owner.snapshot()).repos.find((entry) => entry.repoPath === mainRepo);
    assert.ok((repo?.hosts.find((entry) => entry.host === "example.com")?.blockedCount ?? 0) >= 1);
    assert.ok((repo?.hosts.find((entry) => entry.host === "example.org")?.allowedCount ?? 0) >= 1);
    await owner.update({ kind: "host-rule", repoPath: mainRepo, host: "example.com", rule: null });
    assert.match(
      await run("bash", {
        command: "curl -sS -m 20 -o /dev/null -w '%{http_code}' https://example.com/",
      }),
      /200/,
    );
  });

  await test("a dropped connection is reported and the next call reconnects", async () => {
    await run("bash", { command: "true" });
    // Kill this test's own `sbx exec` worker connection, as a crash of it would.
    const pids = execFileSync("pgrep", ["-P", String(process.pid), "-f", "sbx exec -i"], {
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .filter(Boolean);
    assert.ok(pids.length > 0, "the worker connection is a child of this process");
    for (const pid of pids) process.kill(Number(pid), "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.ok(pi.statuses.some((status) => status.startsWith("Sandbox: failed")));
    assert.match(await run("bash", { command: "echo recovered" }), /recovered/);
  });

  await test("closing the app stops the thread's sandbox", async () => {
    await owner.closeAll();
    assert.deepEqual((await owner.snapshot()).sessions, []);
    await assert.rejects(run("bash", { command: "true" }), /closed/);
    assert.ok(ownSandboxes().every((sandbox) => sandbox.status !== "running"));
  });
} finally {
  await owner.closeAll().catch(() => undefined);
  for (const sandbox of ownSandboxes()) {
    execFileSync("sbx", ["rm", "--force", sandbox.name], { stdio: "ignore" });
  }
}
