import { execFile, execFileSync } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import {
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  selectSidePanel,
  chooseReviewScope,
  startThreadFromSurface,
  waitForWorkspaceByPath,
  writeProjectExtension,
  type DesktopHarness,
} from "../helpers/electron-app";

/**
 * Drives pi-gui's tool sandbox (one Gondolin VM per thread) through the real Electron app.
 * A local scripted provider turns each "run <tag>" prompt into one tool call, then answers with
 * "DONE <tag>" and the tool's output, so the transcript shows what ran inside the VM.
 *
 * Needs QEMU and opts in with PI_APP_SANDBOX_E2E=1; CI runners have no QEMU. The first VM start
 * in a fresh user-data dir builds the base image, which needs network access and takes minutes.
 */

const execFileAsync = promisify(execFile);
const QEMU_BINARY = process.arch === "arm64" ? "qemu-system-aarch64" : "qemu-system-x86_64";
const FIRST_TOOL_CALL_TIMEOUT_MS = 5 * 60_000;
const TOOL_CALL_TIMEOUT_MS = 90_000;
const PROVIDER = "sandbox-e2e";

function qemuOnPath(): boolean {
  try {
    execFileSync("/bin/sh", ["-c", `command -v ${QEMU_BINARY}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const sandboxE2eEnabled =
  process.env.PI_APP_SANDBOX_E2E === "1" &&
  (process.platform === "darwin" || process.platform === "linux") &&
  qemuOnPath();

test.skip(
  !sandboxE2eEnabled,
  `Set PI_APP_SANDBOX_E2E=1 on macOS or Linux with ${QEMU_BINARY} on PATH to run the sandbox specs.`,
);

interface ScriptedToolCall {
  readonly name: "bash" | "read" | "write";
  readonly arguments: Readonly<Record<string, unknown>>;
}

function scriptedProviderExtension(scripts: Readonly<Record<string, ScriptedToolCall>>): string {
  return String.raw`
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const SCRIPTS = ${JSON.stringify(scripts)};

function textOf(message) {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  return (message.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

export default function sandboxE2eProvider(pi) {
  pi.registerProvider("${PROVIDER}", {
    baseUrl: "http://127.0.0.1:9/never-contact",
    apiKey: "LOCAL_TEST_CANARY",
    api: "${PROVIDER}",
    models: [{
      id: "scripted", name: "Scripted sandbox driver", reasoning: false,
      input: ["text"], contextWindow: 128000, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
    streamSimple(model, context) {
      const lastUser = context.messages.findLastIndex((message) => message.role === "user");
      const match = /\brun ([a-z0-9-]+)/.exec(textOf(context.messages[lastUser]));
      const tag = match ? match[1] : undefined;
      const script = tag ? SCRIPTS[tag] : undefined;
      const result = context.messages
        .slice(lastUser + 1)
        .find((message) => message.role === "toolResult");
      const content = !script
        ? [{ type: "text", text: "No sandbox script for this prompt." }]
        : !result
          ? [{ type: "toolCall", id: "sbx-" + tag, name: script.name, arguments: script.arguments }]
          : [{
              type: "text",
              text: "DONE " + tag + " isError=" + Boolean(result.isError) +
                "\n\n~~~text\n" + textOf(result) + "\n~~~\n",
            }];
      const toolUse = content[0].type === "toolCall";
      const message = {
        role: "assistant", content,
        api: model.api, provider: model.provider, model: model.id,
        usage: {
          input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: toolUse ? "toolUse" : "stop", timestamp: Date.now(),
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: { ...message, content: [] } });
      if (!toolUse) {
        stream.push({ type: "text_delta", contentIndex: 0, delta: content[0].text, partial: message });
      }
      stream.push({ type: "done", reason: message.stopReason, message });
      return stream;
    },
  });
}
`;
}

// The app and every git call here run with a throwaway HOME, so neither reads the person's git
// or gh config (the sandbox asks `gh auth token` for a GitHub token). Gondolin's guest image
// cache stays shared through XDG_CACHE_HOME.
let isolatedHome: string | undefined;
async function fakeHome(): Promise<string> {
  isolatedHome ??= await mkdtemp(join(tmpdir(), "pi-gui-sandbox-home-"));
  return isolatedHome;
}

async function isolatedEnv(): Promise<Record<string, string | undefined>> {
  const home = await fakeHome();
  return {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
    GH_CONFIG_DIR: join(home, ".config", "gh"),
    GH_TOKEN: undefined,
    GITHUB_TOKEN: undefined,
    GH_ENTERPRISE_TOKEN: undefined,
    GITHUB_ENTERPRISE_TOKEN: undefined,
    PI_APP_SANDBOX: "1",
  };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1" };
  for (const [key, value] of Object.entries(await isolatedEnv())) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const { stdout } = await execFileAsync("git", args, { cwd, env });
  return stdout.trim();
}

// Built images are copied into later tests' user-data dirs, so only the first test builds one.
let warmImagesDir: string | undefined;

async function seedWarmImages(userDataDir: string): Promise<void> {
  if (!warmImagesDir) return;
  const target = join(userDataDir, "sandbox", "images");
  await mkdir(target, { recursive: true });
  for (const name of await readdir(warmImagesDir)) {
    if (!name.endsWith(".qcow2")) continue;
    await copyFile(join(warmImagesDir, name), join(target, name), constants.COPYFILE_FICLONE);
  }
}

async function rememberWarmImages(userDataDir: string): Promise<void> {
  const images = join(userDataDir, "sandbox", "images");
  if (warmImagesDir || !existsSync(images)) return;
  if ((await readdir(images)).some((name) => /^base-.*\.qcow2$/.test(name))) {
    warmImagesDir = images;
  }
}

interface Fixture {
  readonly userDataDir: string;
  readonly agentDir: string;
  readonly workspacePath: string;
}

async function createFixture(
  name: string,
  scripts: Readonly<Record<string, ScriptedToolCall>>,
  options: { readonly warmImages?: boolean } = {},
): Promise<Fixture> {
  const userDataDir = await makeUserDataDir("pi-gui-sandbox-e2e-");
  if (options.warmImages !== false) await seedWarmImages(userDataDir);
  const agentDir = join(userDataDir, "agent");
  await seedAgentDir(agentDir, { withOpenAiAuth: false, withDefaultModel: false });
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: PROVIDER,
      defaultModel: "scripted",
      enabledModels: [`${PROVIDER}/scripted`],
      packages: [],
      cacheWarming: "off",
      compaction: { enabled: false },
    }),
  );
  const workspacePath = await makeWorkspace(name);
  await writeFile(join(workspacePath, "notes.txt"), "ORIGINAL_NOTES\n");
  await writeProjectExtension(workspacePath, "sandbox-e2e.ts", scriptedProviderExtension(scripts));
  await git(workspacePath, "init", "-q", "-b", "main");
  await git(workspacePath, "config", "user.name", "Pi App Tests");
  await git(workspacePath, "config", "user.email", "pi-gui-tests@example.com");
  await git(workspacePath, "add", "-A");
  await git(workspacePath, "commit", "-q", "-m", "init");
  return { userDataDir, agentDir, workspacePath };
}

async function launchSandboxedApp(
  fixture: Fixture,
  envOverrides: Readonly<Record<string, string | undefined>> = {},
): Promise<DesktopHarness> {
  return launchDesktop(fixture.userDataDir, {
    agentDir: fixture.agentDir,
    initialWorkspaces: [fixture.workspacePath],
    scrubProviderEnv: true,
    testMode: "background",
    envOverrides: { ...(await isolatedEnv()), ...envOverrides },
  });
}

/** Waits for the scripted "DONE <tag>" reply and returns its text. */
async function waitForScriptResult(window: Page, tag: string, timeout: number): Promise<string> {
  const reply = window
    .locator(".timeline-item--assistant .message__content")
    .filter({ hasText: `DONE ${tag} ` });
  await expect(reply).toBeVisible({ timeout });
  await expect(window.getByTestId("send")).not.toHaveAttribute("aria-label", "Stop run");
  return reply.innerText();
}

async function sendPrompt(window: Page, prompt: string): Promise<void> {
  const composer = window.getByTestId("composer");
  await composer.fill(prompt);
  await composer.press("Enter");
}

async function timed<T>(testInfo: TestInfo, label: string, work: () => Promise<T>): Promise<T> {
  const started = Date.now();
  const result = await work();
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  testInfo.annotations.push({ type: "timing", description: `${label}: ${seconds} s` });
  console.log(`[sandbox e2e] ${testInfo.title} | ${label}: ${seconds} s`);
  return result;
}

/** The composer chip; its data-state is starting, on, failed or off. */
function sandboxStatus(window: Page) {
  return window.getByTestId("sandbox-badge");
}

interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly command: string;
}

async function processTable(): Promise<ProcessRow[]> {
  const { stdout } = await execFileAsync("ps", ["-A", "-o", "pid=,ppid=,command="]);
  return stdout
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3]! }));
}

/** QEMU processes started (directly or not) by the given app process. */
async function qemuDescendants(rootPid: number): Promise<ProcessRow[]> {
  const rows = await processTable();
  const descendants = new Set([rootPid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows) {
      if (!descendants.has(row.pid) && descendants.has(row.ppid)) {
        descendants.add(row.pid);
        grew = true;
      }
    }
  }
  return rows.filter((row) => descendants.has(row.pid) && row.command.includes("qemu-system"));
}

async function runningPids(pids: readonly number[]): Promise<number[]> {
  const alive = new Set((await processTable()).map((row) => row.pid));
  return pids.filter((pid) => alive.has(pid));
}

function appPid(harness: DesktopHarness): number {
  const pid = harness.electronApp.process().pid;
  if (!pid) throw new Error("The app process has no pid");
  return pid;
}

test("SBX-A2/B1: a new thread's bash runs in Linux and the status shows the sandbox", async ({}, testInfo) => {
  test.setTimeout(FIRST_TOOL_CALL_TIMEOUT_MS + 2 * 60_000);
  const fixture = await createFixture(
    "sandbox-uname",
    {
      "a2-uname": { name: "bash", arguments: { command: "uname -s; pwd; cat /etc/os-release" } },
      "a2-again": { name: "bash", arguments: { command: "uname -sm" } },
    },
    { warmImages: false },
  );
  const harness = await launchSandboxedApp(fixture);
  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, fixture.workspacePath);
    const output = await timed(
      testInfo,
      "first tool call (base image build + VM start)",
      async () => {
        await startThreadFromSurface(window, { prompt: "run a2-uname" });
        // The base image build takes far longer than a render, so Starting is observable.
        await expect(sandboxStatus(window)).toHaveAttribute("data-state", "starting", {
          timeout: 60_000,
        });
        return waitForScriptResult(window, "a2-uname", FIRST_TOOL_CALL_TIMEOUT_MS);
      },
    );
    expect(output).toContain("isError=false");
    expect(output).toMatch(/^Linux$/m);
    expect(output).not.toContain("Darwin");
    expect(output).toContain("Alpine");
    // The checkout is mounted at the same absolute path it has on the host.
    expect(output).toContain(fixture.workspacePath);
    await expect(sandboxStatus(window)).toHaveAttribute("data-state", "on");

    const again = await timed(testInfo, "second tool call (VM already running)", async () => {
      await sendPrompt(window, "run a2-again");
      return waitForScriptResult(window, "a2-again", TOOL_CALL_TIMEOUT_MS);
    });
    expect(again).toMatch(/^Linux (aarch64|x86_64)$/m);
    await expect(sandboxStatus(window)).toHaveAttribute("data-state", "on");
  } finally {
    await harness.close();
    await rememberWarmImages(fixture.userDataDir);
  }
});

test("SBX-B2: a file the write tool creates in the sandbox lands in the host checkout and Review", async ({}, testInfo) => {
  test.setTimeout(FIRST_TOOL_CALL_TIMEOUT_MS + 2 * 60_000);
  const fixture = await createFixture("sandbox-write", {
    "b2-write": {
      name: "write",
      arguments: { path: "notes.txt", content: "WRITTEN_IN_SANDBOX\n" },
    },
    "b2-create": {
      name: "write",
      arguments: { path: "created/by-sandbox.txt", content: "CREATED_IN_SANDBOX\n" },
    },
  });
  const harness = await launchSandboxedApp(fixture);
  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, fixture.workspacePath);
    const output = await timed(testInfo, "write tool call", async () => {
      await startThreadFromSurface(window, { prompt: "run b2-write" });
      return waitForScriptResult(window, "b2-write", FIRST_TOOL_CALL_TIMEOUT_MS);
    });
    expect(output).toContain("isError=false");
    expect(await readFile(join(fixture.workspacePath, "notes.txt"), "utf8")).toBe(
      "WRITTEN_IN_SANDBOX\n",
    );

    await sendPrompt(window, "run b2-create");
    expect(await waitForScriptResult(window, "b2-create", TOOL_CALL_TIMEOUT_MS)).toContain(
      "isError=false",
    );
    expect(await readFile(join(fixture.workspacePath, "created", "by-sandbox.txt"), "utf8")).toBe(
      "CREATED_IN_SANDBOX\n",
    );
    expect(await git(fixture.workspacePath, "status", "--porcelain")).toContain("M notes.txt");

    await selectSidePanel(window, "Review");
    await chooseReviewScope(window, "Uncommitted");
    const panel = window.getByRole("region", { name: "Review", exact: true });
    const row = panel.locator('.diff-panel__file[data-file-path="notes.txt"]');
    await expect(row).toBeVisible();
    await row.locator(".diff-panel__file-name").click();
    const diff = panel.getByRole("region", { name: "Diff", exact: true });
    await expect(diff).toContainText("ORIGINAL_NOTES");
    await expect(diff).toContainText("WRITTEN_IN_SANDBOX");
    await window.screenshot({ path: testInfo.outputPath("review-after-sandbox-write.png") });
  } finally {
    await harness.close();
    await rememberWarmImages(fixture.userDataDir);
  }
});

test("SBX-B3: sandboxed tools cannot read or write the host outside the checkout", async ({}, testInfo) => {
  test.setTimeout(FIRST_TOOL_CALL_TIMEOUT_MS + 2 * 60_000);
  const secretDir = await realpath(await mkdtemp(join(tmpdir(), "pi-gui-sandbox-secret-")));
  const secretToken = `HOST_SECRET_${Date.now()}`;
  const secretPath = join(secretDir, "secret.txt");
  await writeFile(secretPath, `${secretToken}\n`);
  const outsideWritePath = join(secretDir, "written-from-sandbox.txt");
  const fixture = await createFixture("sandbox-confined", {
    "b3-bash": {
      name: "bash",
      arguments: {
        command: [
          `echo '--secret--'; cat ${secretPath} 2>&1`,
          `echo '--home--'; ls -la ${homedir()} 2>&1`,
          `echo '--parent--'; ls .. 2>&1`,
          `echo '--outside-write--'; echo nope > ${outsideWritePath} 2>&1`,
          "true",
        ].join("; "),
      },
    },
    "b3-read": { name: "read", arguments: { path: secretPath } },
    "b3-write": { name: "write", arguments: { path: outsideWritePath, content: "escaped\n" } },
  });
  // A sibling repository next to the checkout must stay invisible from inside it.
  await mkdir(join(dirname(fixture.workspacePath), "sibling-repo"));
  await writeFile(join(dirname(fixture.workspacePath), "sibling-repo", "README.md"), "sibling\n");
  const harness = await launchSandboxedApp(fixture);
  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, fixture.workspacePath);
    await startThreadFromSurface(window, { prompt: "run b3-bash" });
    const output = await waitForScriptResult(window, "b3-bash", FIRST_TOOL_CALL_TIMEOUT_MS);
    await window.screenshot({ path: testInfo.outputPath("confined-bash.png") });
    expect(output).not.toContain(secretToken);
    expect(output).toMatch(/--secret--\s*\n.*No such file or directory/);
    expect(output).toMatch(/--home--\s*\n.*No such file or directory/);
    expect(output).not.toContain("sibling-repo");
    expect(existsSync(outsideWritePath)).toBe(false);

    await sendPrompt(window, "run b3-read");
    const read = await waitForScriptResult(window, "b3-read", TOOL_CALL_TIMEOUT_MS);
    expect(read).toContain("isError=true");
    expect(read).not.toContain(secretToken);

    await sendPrompt(window, "run b3-write");
    const write = await waitForScriptResult(window, "b3-write", TOOL_CALL_TIMEOUT_MS);
    expect(existsSync(outsideWritePath), write).toBe(false);
    expect(await readFile(secretPath, "utf8")).toBe(`${secretToken}\n`);
  } finally {
    await harness.close();
    await rememberWarmImages(fixture.userDataDir);
  }
});

test("SBX-E1: a new worktree thread can run git status and git commit in its sandbox", async ({}, testInfo) => {
  test.setTimeout(FIRST_TOOL_CALL_TIMEOUT_MS + 2 * 60_000);
  const fixture = await createFixture("sandbox-worktree", {
    "e1-git": {
      name: "bash",
      arguments: {
        command: [
          "git status --short --branch",
          "echo sandboxed > sandbox-commit.txt",
          "git add sandbox-commit.txt",
          "git commit -q -m 'Commit from the sandbox'",
          "git log -1 --format='commit=%an <%ae>|%s'",
          "git branch --show-current",
          "uname -s",
        ].join(" && "),
      },
    },
  });
  const harness = await launchSandboxedApp(fixture);
  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, fixture.workspacePath);
    const output = await timed(testInfo, "git in a worktree sandbox", async () => {
      await startThreadFromSurface(window, { environment: "worktree", prompt: "run e1-git" });
      return waitForScriptResult(window, "e1-git", FIRST_TOOL_CALL_TIMEOUT_MS);
    });
    await window.screenshot({ path: testInfo.outputPath("worktree-commit.png") });
    expect(output).toContain("isError=false");
    expect(output).toMatch(/^Linux$/m);
    // SBX-C4: the commit uses the checkout's git identity.
    expect(output).toContain(
      "commit=Pi App Tests <pi-gui-tests@example.com>|Commit from the sandbox",
    );
    await expect(sandboxStatus(window)).toHaveAttribute("data-state", "on");

    const state = await getDesktopState(window);
    const worktree = state.workspaces.find((entry) => entry.id === state.selectedWorkspaceId);
    expect(worktree?.kind).toBe("worktree");
    const worktreePath = worktree!.path;
    expect(worktreePath).not.toBe(fixture.workspacePath);
    expect(output).toContain(`## ${await git(worktreePath, "branch", "--show-current")}`);

    // The commit is visible from the host, in the worktree and in the main repository.
    expect(await git(worktreePath, "log", "-1", "--format=%s")).toBe("Commit from the sandbox");
    expect(await git(worktreePath, "status", "--porcelain")).toBe("");
    const branch = await git(worktreePath, "branch", "--show-current");
    expect(await git(fixture.workspacePath, "log", "-1", "--format=%an|%s", branch)).toBe(
      "Pi App Tests|Commit from the sandbox",
    );
    expect(await git(fixture.workspacePath, "log", "-1", "--format=%s", "main")).toBe("init");
  } finally {
    await harness.close();
    await rememberWarmImages(fixture.userDataDir);
  }
});

test("SBX-F2/F3: a blocked host gets the policy response and every host is logged", async ({}, testInfo) => {
  test.setTimeout(FIRST_TOOL_CALL_TIMEOUT_MS + 2 * 60_000);
  const fixture = await createFixture("sandbox-network", {
    "f2-curl": {
      name: "bash",
      arguments: {
        command: [
          "curl -sS https://example.com/some/path?q=secret-query 2>&1",
          "echo",
          "echo \"allowed-status=$(curl -sS -o /dev/null -w '%{http_code}' https://example.org/ 2>&1)\"",
        ].join("; "),
      },
    },
  });
  const sandboxDir = join(fixture.userDataDir, "sandbox");
  await mkdir(sandboxDir, { recursive: true });
  await writeFile(
    join(sandboxDir, "sandbox-settings.json"),
    `${JSON.stringify({
      version: 1,
      defaultNetworkMode: "allow-all",
      repos: { [fixture.workspacePath]: { allowedHosts: [], blockedHosts: ["example.com"] } },
    })}\n`,
  );
  const harness = await launchSandboxedApp(fixture);
  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, fixture.workspacePath);
    const output = await timed(testInfo, "blocked and allowed curl", async () => {
      await startThreadFromSurface(window, { prompt: "run f2-curl" });
      return waitForScriptResult(window, "f2-curl", FIRST_TOOL_CALL_TIMEOUT_MS);
    });
    await window.screenshot({ path: testInfo.outputPath("network-policy.png") });
    expect(output).toContain(
      "Blocked by the pi-gui sandbox network policy: example.com is blocked for this repository",
    );
    expect(output).toContain("allowed-status=200");
  } finally {
    await harness.close();
    await rememberWarmImages(fixture.userDataDir);
  }

  // Quitting flushes the log; it keeps host names and counts, never URLs.
  const logSource = await readFile(join(sandboxDir, "network-log.json"), "utf8");
  const log = JSON.parse(logSource) as {
    repos: Record<string, { host: string; allowedCount: number; blockedCount: number }[]>;
  };
  const hosts = log.repos[fixture.workspacePath] ?? [];
  expect(hosts.find((entry) => entry.host === "example.com")?.blockedCount).toBeGreaterThanOrEqual(
    1,
  );
  expect(hosts.find((entry) => entry.host === "example.com")?.allowedCount).toBe(0);
  expect(hosts.find((entry) => entry.host === "example.org")?.allowedCount).toBeGreaterThanOrEqual(
    1,
  );
  expect(logSource).not.toContain("secret-query");
  expect(logSource).not.toContain("/some/path");
});

test("SBX-G1: without QEMU the tool fails closed and nothing runs on the host", async ({}, testInfo) => {
  test.setTimeout(2 * 60_000);
  const fixture = await createFixture(
    "sandbox-no-qemu",
    {
      "g1-touch": {
        name: "bash",
        arguments: { command: "touch g1-marker.txt; uname -s" },
      },
      "g1-write": { name: "write", arguments: { path: "g1-written.txt", content: "host\n" } },
    },
    { warmImages: false },
  );
  // git lives in /usr/bin on macOS and Linux; QEMU (Homebrew or apt) must not be reachable.
  const noQemuPath = "/usr/bin:/bin:/usr/sbin:/sbin";
  for (const folder of noQemuPath.split(":")) {
    expect(existsSync(join(folder, QEMU_BINARY)), `${QEMU_BINARY} in ${folder}`).toBe(false);
  }
  const harness = await launchSandboxedApp(fixture, {
    PATH: noQemuPath,
    PI_APP_TEST_EXACT_PATH: "1",
  });
  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, fixture.workspacePath);
    const output = await timed(testInfo, "failing tool call", async () => {
      await startThreadFromSurface(window, { prompt: "run g1-touch" });
      return waitForScriptResult(window, "g1-touch", TOOL_CALL_TIMEOUT_MS);
    });
    await window.screenshot({ path: testInfo.outputPath("no-qemu.png") });
    expect(output).toContain("isError=true");
    expect(output).toContain("QEMU is not installed");
    expect(output).not.toContain("Darwin");
    await expect(sandboxStatus(window)).toHaveAttribute("data-state", "failed");
    await expect(sandboxStatus(window)).toHaveAttribute("title", /QEMU is not installed/);
    expect(existsSync(join(fixture.workspacePath, "g1-marker.txt"))).toBe(false);

    await sendPrompt(window, "run g1-write");
    expect(await waitForScriptResult(window, "g1-write", TOOL_CALL_TIMEOUT_MS)).toContain(
      "isError=true",
    );
    expect(existsSync(join(fixture.workspacePath, "g1-written.txt"))).toBe(false);

    // Chatting without tools still works.
    await sendPrompt(window, "hello without tools");
    await expect(
      window
        .locator(".timeline-item--assistant .message__content")
        .filter({ hasText: "No sandbox script for this prompt." }),
    ).toBeVisible();
  } finally {
    await harness.close();
  }
});

test("SBX-E5: quitting the app stops the thread's VM and a reopened thread starts a new one", async ({}, testInfo) => {
  test.setTimeout(FIRST_TOOL_CALL_TIMEOUT_MS + 3 * 60_000);
  const fixture = await createFixture("sandbox-quit", {
    "e5-before": { name: "bash", arguments: { command: "echo before > before.txt; uname -s" } },
    "e5-after": { name: "bash", arguments: { command: "cat before.txt; uname -s" } },
  });
  let harness = await launchSandboxedApp(fixture);
  let vmPids: number[] = [];
  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, fixture.workspacePath);
    await startThreadFromSurface(window, { prompt: "run e5-before" });
    expect(await waitForScriptResult(window, "e5-before", FIRST_TOOL_CALL_TIMEOUT_MS)).toMatch(
      /^Linux$/m,
    );
    const vms = await qemuDescendants(appPid(harness));
    testInfo.annotations.push({
      type: "qemu",
      description: vms.map((row) => `${row.pid}: ${row.command.slice(0, 300)}`).join("\n"),
    });
    expect(vms.length, "the thread's VM runs as a QEMU process under the app").toBeGreaterThan(0);
    vmPids = vms.map((row) => row.pid);
  } finally {
    await harness.close();
  }
  expect(await runningPids(vmPids), "QEMU processes left after quitting").toEqual([]);

  harness = await launchSandboxedApp(fixture);
  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, fixture.workspacePath);
    await expect(
      window.locator(".timeline-item--assistant .message__content").filter({
        hasText: "DONE e5-before ",
      }),
    ).toBeVisible({ timeout: 15_000 });
    const output = await timed(testInfo, "tool call after restart", async () => {
      await sendPrompt(window, "run e5-after");
      return waitForScriptResult(window, "e5-after", TOOL_CALL_TIMEOUT_MS);
    });
    expect(output).toContain("isError=false");
    expect(output).toMatch(/^before$/m);
    expect(output).toMatch(/^Linux$/m);
    vmPids = (await qemuDescendants(appPid(harness))).map((row) => row.pid);
    expect(vmPids.length).toBeGreaterThan(0);
  } finally {
    await harness.close();
    await rememberWarmImages(fixture.userDataDir);
  }
  expect(await runningPids(vmPids), "QEMU processes left after quitting").toEqual([]);
});

test("SBX-E5: a VM left behind by a crashed app is stopped on the next launch", async ({}, testInfo) => {
  test.setTimeout(FIRST_TOOL_CALL_TIMEOUT_MS + 3 * 60_000);
  const fixture = await createFixture("sandbox-crash", {
    "e5c-start": { name: "bash", arguments: { command: "uname -s" } },
  });
  let harness = await launchSandboxedApp(fixture);
  let vmPids: number[] = [];
  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, fixture.workspacePath);
    await startThreadFromSurface(window, { prompt: "run e5c-start" });
    expect(await waitForScriptResult(window, "e5c-start", FIRST_TOOL_CALL_TIMEOUT_MS)).toMatch(
      /^Linux$/m,
    );
    vmPids = (await qemuDescendants(appPid(harness))).map((row) => row.pid);
    expect(vmPids.length).toBeGreaterThan(0);
    // A crash: the app gets no chance to stop its VMs.
    process.kill(appPid(harness), "SIGKILL");
    await harness.close().catch(() => undefined);
    testInfo.annotations.push({
      type: "orphans",
      description: `still running after the crash: ${(await runningPids(vmPids)).join(", ")}`,
    });

    harness = await launchSandboxedApp(fixture);
    await harness.firstWindow();
    await expect
      .poll(() => runningPids(vmPids), {
        message: "the relaunched app stops the crashed run's QEMU",
        timeout: 15_000,
      })
      .toEqual([]);
  } finally {
    await harness.close().catch(() => undefined);
    // Only this test's own VMs, in case the assertion above failed.
    for (const pid of await runningPids(vmPids)) process.kill(pid, "SIGKILL");
    await rememberWarmImages(fixture.userDataDir);
  }
});

test("SBX-E6: archiving a thread stops its VM", async ({}, testInfo) => {
  test.setTimeout(FIRST_TOOL_CALL_TIMEOUT_MS + 2 * 60_000);
  const fixture = await createFixture("sandbox-archive", {
    "e6-start": { name: "bash", arguments: { command: "uname -s" } },
  });
  const harness = await launchSandboxedApp(fixture);
  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, fixture.workspacePath);
    await startThreadFromSurface(window, { prompt: "run e6-start" });
    expect(await waitForScriptResult(window, "e6-start", FIRST_TOOL_CALL_TIMEOUT_MS)).toMatch(
      /^Linux$/m,
    );
    const vmPids = (await qemuDescendants(appPid(harness))).map((row) => row.pid);
    expect(vmPids.length).toBeGreaterThan(0);

    const title = (await window.locator(".chat-header__title").innerText()).trim();
    const row = window.locator(".session-list > .session-row").filter({ hasText: title }).first();
    await row.hover();
    await row.getByLabel(`Archive ${title}`).click();
    await expect(window.locator(".archived-thread-group")).toContainText("Archived");
    await expect
      .poll(() => runningPids(vmPids), {
        message: "the archived thread's QEMU process should stop",
        timeout: 15_000,
      })
      .toEqual([]);
    await window.screenshot({ path: testInfo.outputPath("archived.png") });
  } finally {
    await harness.close();
    await rememberWarmImages(fixture.userDataDir);
  }
});
