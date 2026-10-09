import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
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
 * Drives pi-gui's tool sandbox (one Docker Sandboxes `sbx` sandbox per thread) through the real
 * Electron app. A local scripted provider turns each "run <tag>" prompt into one tool call, then
 * answers with "DONE <tag>" and the tool's output, so the transcript shows what ran inside the
 * sandbox.
 *
 * Needs `sbx` installed and signed in, and opts in with PI_APP_SANDBOX_E2E=1; CI runners have no
 * sbx. The first sandbox ever created on a machine downloads Docker's image, which takes minutes.
 *
 * sbx is a machine-wide daemon holding the person's sandboxes, login and secrets, so these specs
 * touch only what they create: after each test they remove the pi-gui sandboxes that mount the
 * test's own temp folders, never others, and they never change sbx's global policy or secrets.
 */

const execFileAsync = promisify(execFile);
const FIRST_TOOL_CALL_TIMEOUT_MS = 5 * 60_000;
const TOOL_CALL_TIMEOUT_MS = 90_000;
const PROVIDER = "sandbox-e2e";
const SANDBOX_PREFIX = "pi-gui-";

function sbxReady(): boolean {
  try {
    execFileSync("sbx", ["ls", "--json"], { stdio: "ignore", timeout: 60_000 });
    return true;
  } catch {
    return false;
  }
}

const sandboxE2eEnabled =
  process.env.PI_APP_SANDBOX_E2E === "1" &&
  (process.platform === "darwin" || process.platform === "linux") &&
  sbxReady();

test.skip(
  !sandboxE2eEnabled,
  "Set PI_APP_SANDBOX_E2E=1 on macOS or Linux with sbx installed and signed in (`sbx ls` works) to run the sandbox specs.",
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

// HOME stays real: sbx finds its daemon, login and secrets under the person's home (on macOS in
// ~/Library/Application Support/com.docker.sandboxes) and reports "not signed in to Docker" under
// a throwaway HOME. git and gh config are isolated instead, so neither the app nor these helpers
// read the person's git identity or GitHub login.
let isolatedConfigDir: string | undefined;
async function configDir(): Promise<string> {
  if (!isolatedConfigDir) {
    isolatedConfigDir = await mkdtemp(join(tmpdir(), "pi-gui-sandbox-config-"));
    await writeFile(join(isolatedConfigDir, "gitconfig"), "");
    await mkdir(join(isolatedConfigDir, "gh"));
  }
  return isolatedConfigDir;
}

async function isolatedEnv(): Promise<Record<string, string | undefined>> {
  const dir = await configDir();
  return {
    GIT_CONFIG_GLOBAL: join(dir, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GH_CONFIG_DIR: join(dir, "gh"),
    GH_TOKEN: undefined,
    GITHUB_TOKEN: undefined,
    GH_ENTERPRISE_TOKEN: undefined,
    GITHUB_ENTERPRISE_TOKEN: undefined,
    PI_APP_SANDBOX: "1",
  };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(await isolatedEnv())) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const { stdout } = await execFileAsync("git", args, { cwd, env });
  return stdout.trim();
}

interface SbxSandbox {
  readonly name: string;
  readonly status: string;
  readonly workspaces?: readonly string[];
}

async function listSandboxes(): Promise<SbxSandbox[]> {
  const { stdout } = await execFileAsync("sbx", ["ls", "--json"], { timeout: 60_000 });
  return (JSON.parse(stdout) as { sandboxes?: SbxSandbox[] }).sandboxes ?? [];
}

/** What the running test created: temp folders, and apps still open. */
interface TestResources {
  /** Temp folders (as given and resolved); a sandbox mounting one of them is this test's. */
  readonly roots: string[];
  readonly apps: Set<DesktopHarness>;
}

let resources: TestResources = { roots: [], apps: new Set() };

async function trackRoot(path: string): Promise<void> {
  for (const root of [path, await realpath(path)]) {
    if (!resources.roots.includes(root)) resources.roots.push(root);
  }
}

function isOwnSandbox(sandbox: SbxSandbox, roots: readonly string[]): boolean {
  return (
    sandbox.name.startsWith(SANDBOX_PREFIX) &&
    (sandbox.workspaces ?? []).some((workspace) => {
      const mount = workspace.replace(/:ro$/, "");
      return roots.some((root) => mount === root || mount.startsWith(`${root}/`));
    })
  );
}

/** The sandboxes the running test's app created (they mount its temp folders). */
async function ownSandboxes(): Promise<SbxSandbox[]> {
  const roots = [...resources.roots];
  return (await listSandboxes()).filter((sandbox) => isOwnSandbox(sandbox, roots));
}

async function ownSandboxStatuses(): Promise<string[]> {
  return (await ownSandboxes()).map((sandbox) => sandbox.status).sort();
}

test.beforeEach(() => {
  resources = { roots: [], apps: new Set() };
});

test.afterEach(async () => {
  test.setTimeout(5 * 60_000);
  for (const app of resources.apps) await app.close().catch(() => undefined);
  resources.apps.clear();
  // Only this test's sandboxes: never `sbx rm --all`, never the person's own sandboxes.
  for (const sandbox of await ownSandboxes()) {
    await execFileAsync("sbx", ["rm", "--force", sandbox.name], { timeout: 180_000 });
  }
  expect(await ownSandboxes(), "sandboxes this test left behind").toEqual([]);
  for (const root of resources.roots) await rm(root, { recursive: true, force: true });
});

test.afterAll(async () => {
  if (isolatedConfigDir) await rm(isolatedConfigDir, { recursive: true, force: true });
});

interface Fixture {
  readonly userDataDir: string;
  readonly agentDir: string;
  readonly workspacePath: string;
}

async function createFixture(
  name: string,
  scripts: Readonly<Record<string, ScriptedToolCall>>,
): Promise<Fixture> {
  const userDataDir = await makeUserDataDir("pi-gui-sandbox-e2e-");
  await trackRoot(userDataDir);
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
  await trackRoot(dirname(workspacePath));
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
  const harness = await launchDesktop(fixture.userDataDir, {
    agentDir: fixture.agentDir,
    initialWorkspaces: [fixture.workspacePath],
    scrubProviderEnv: true,
    testMode: "background",
    envOverrides: { ...(await isolatedEnv()), ...envOverrides },
  });
  resources.apps.add(harness);
  return harness;
}

async function quit(harness: DesktopHarness): Promise<void> {
  try {
    await harness.close();
  } finally {
    resources.apps.delete(harness);
  }
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

async function expectOwnSandboxes(statuses: readonly string[], message: string, timeout = 30_000) {
  await expect.poll(ownSandboxStatuses, { message, timeout }).toEqual(statuses);
}

function appPid(harness: DesktopHarness): number {
  const pid = harness.electronApp.process().pid;
  if (!pid) throw new Error("The app process has no pid");
  return pid;
}

/** Processes still in a process group (the app's, after it was killed). */
async function processGroup(pgid: number): Promise<{ pid: number; command: string }[]> {
  const { stdout } = await execFileAsync("ps", ["-A", "-o", "pid=,pgid=,command="]);
  return stdout
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null && Number(match[2]) === pgid)
    .map((match) => ({ pid: Number(match[1]), command: match[3]! }));
}

test("SBX-A2/B1: a new thread's bash runs in Linux and the status shows the sandbox", async ({}, testInfo) => {
  test.setTimeout(FIRST_TOOL_CALL_TIMEOUT_MS + 2 * 60_000);
  const fixture = await createFixture("sandbox-uname", {
    "a2-uname": { name: "bash", arguments: { command: "uname -s; pwd; cat /etc/os-release" } },
    "a2-again": { name: "bash", arguments: { command: "uname -sm" } },
  });
  const harness = await launchSandboxedApp(fixture);
  const window = await harness.firstWindow();
  await waitForWorkspaceByPath(window, fixture.workspacePath);
  const output = await timed(testInfo, "first tool call (sandbox create + setup)", async () => {
    await startThreadFromSurface(window, { prompt: "run a2-uname" });
    // Creating the sandbox and installing pnpm take seconds, so Starting is observable.
    await expect(sandboxStatus(window)).toHaveAttribute("data-state", "starting", {
      timeout: 60_000,
    });
    return waitForScriptResult(window, "a2-uname", FIRST_TOOL_CALL_TIMEOUT_MS);
  });
  expect(output).toContain("isError=false");
  expect(output).toMatch(/^Linux$/m);
  expect(output).not.toContain("Darwin");
  expect(output).toMatch(/^ID=ubuntu$/m);
  // The checkout is mounted at the same absolute path it has on the host.
  expect(output).toContain(fixture.workspacePath);
  await expect(sandboxStatus(window)).toHaveAttribute("data-state", "on");

  const sandboxes = await ownSandboxes();
  expect(sandboxes.map((sandbox) => sandbox.status)).toEqual(["running"]);
  expect(sandboxes[0]!.name).toMatch(/^pi-gui-[0-9a-f]{12}-[0-9a-f]{6}$/);
  expect(sandboxes[0]!.workspaces).toContain(fixture.workspacePath);

  const again = await timed(testInfo, "second tool call (sandbox already running)", async () => {
    await sendPrompt(window, "run a2-again");
    return waitForScriptResult(window, "a2-again", TOOL_CALL_TIMEOUT_MS);
  });
  expect(again).toMatch(/^Linux (aarch64|x86_64)$/m);
  await expect(sandboxStatus(window)).toHaveAttribute("data-state", "on");
  expect((await ownSandboxes()).map((sandbox) => sandbox.name)).toEqual([sandboxes[0]!.name]);
  await quit(harness);
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
  const window = await harness.firstWindow();
  await waitForWorkspaceByPath(window, fixture.workspacePath);
  const output = await timed(testInfo, "write tool call (sandbox create + setup)", async () => {
    await startThreadFromSurface(window, { prompt: "run b2-write" });
    return waitForScriptResult(window, "b2-write", FIRST_TOOL_CALL_TIMEOUT_MS);
  });
  expect(output).toContain("isError=false");
  expect(await readFile(join(fixture.workspacePath, "notes.txt"), "utf8")).toBe(
    "WRITTEN_IN_SANDBOX\n",
  );

  await timed(testInfo, "second write tool call", async () => {
    await sendPrompt(window, "run b2-create");
    expect(await waitForScriptResult(window, "b2-create", TOOL_CALL_TIMEOUT_MS)).toContain(
      "isError=false",
    );
  });
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
  await quit(harness);
});

test("SBX-B3: sandboxed tools cannot read or write the host outside the checkout", async ({}, testInfo) => {
  test.setTimeout(FIRST_TOOL_CALL_TIMEOUT_MS + 2 * 60_000);
  const secretDir = await realpath(await mkdtemp(join(tmpdir(), "pi-gui-sandbox-secret-")));
  await trackRoot(secretDir);
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
          `echo '--home--'; ls -A ${homedir()} 2>&1; echo '--end-home--'`,
          `echo '--ssh--'; cat ${join(homedir(), ".ssh")}/id_* 2>&1`,
          `echo '--auth--'; cat ${join(homedir(), ".pi", "agent", "auth.json")} 2>&1`,
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
  const window = await harness.firstWindow();
  await waitForWorkspaceByPath(window, fixture.workspacePath);
  await startThreadFromSurface(window, { prompt: "run b3-bash" });
  const output = await waitForScriptResult(window, "b3-bash", FIRST_TOOL_CALL_TIMEOUT_MS);
  await window.screenshot({ path: testInfo.outputPath("confined-bash.png") });
  expect(output).not.toContain(secretToken);
  expect(output).toMatch(/--secret--\s*\n.*No such file or directory/);
  // The home folder holds at most the read-only mounts of pi's skill folders (SBX-D3).
  const home = /--home--\n([\s\S]*?)--end-home--/.exec(output)?.[1] ?? "";
  const unexpectedHomeEntries = home
    .split("\n")
    .filter((line) => line.trim() !== "" && !/No such file or directory/.test(line))
    .filter((entry) => entry !== ".agents" && entry !== ".pi");
  expect(unexpectedHomeEntries).toEqual([]);
  expect(output).toMatch(/--ssh--\s*\n.*No such file or directory/);
  expect(output).toMatch(/--auth--\s*\n.*No such file or directory/);
  expect(output).not.toContain("sibling-repo");
  expect(existsSync(outsideWritePath)).toBe(false);

  await sendPrompt(window, "run b3-read");
  const read = await waitForScriptResult(window, "b3-read", TOOL_CALL_TIMEOUT_MS);
  expect(read).toContain("isError=true");
  expect(read).not.toContain(secretToken);

  await sendPrompt(window, "run b3-write");
  const write = await waitForScriptResult(window, "b3-write", TOOL_CALL_TIMEOUT_MS);
  expect(write).toContain("isError=true");
  expect(write).toContain("outside this thread's checkout");
  expect(existsSync(outsideWritePath), write).toBe(false);
  expect(await readFile(secretPath, "utf8")).toBe(`${secretToken}\n`);
  await quit(harness);
});

test("SBX-B6: Stop kills a long sandboxed command and the thread keeps working", async ({}, testInfo) => {
  test.setTimeout(FIRST_TOOL_CALL_TIMEOUT_MS + 2 * 60_000);
  const fixture = await createFixture("sandbox-stop", {
    "b6-sleep": { name: "bash", arguments: { command: "echo started; sleep 120; echo finished" } },
    "b6-check": {
      name: "bash",
      arguments: { command: "ps -eo args | grep '[s]leep 120' || echo none" },
    },
  });
  const harness = await launchSandboxedApp(fixture);
  const window = await harness.firstWindow();
  await waitForWorkspaceByPath(window, fixture.workspacePath);
  await startThreadFromSurface(window, { prompt: "run b6-sleep" });
  const send = window.getByTestId("send");
  await expect(send).toHaveAttribute("aria-label", "Stop run");
  // The chip reads "on" before the sandbox starts too, so wait for sbx itself.
  await expectOwnSandboxes(["running"], "the thread's sandbox runs", FIRST_TOOL_CALL_TIMEOUT_MS);
  // Stop only once the command really runs in the sandbox, so the check below means something.
  const [sandbox] = await ownSandboxes();
  expect(sandbox, "the thread's sandbox").toBeDefined();
  await expect
    .poll(
      async () =>
        (
          await execFileAsync(
            "sbx",
            ["exec", sandbox!.name, "sh", "-c", "ps -eo args | grep '[s]leep 120' || true"],
            { timeout: 30_000 },
          )
        ).stdout.trim(),
      { message: "sleep 120 runs in the sandbox", timeout: 30_000 },
    )
    .toContain("sleep 120");

  await timed(testInfo, "Stop until the run ends", async () => {
    await send.click();
    await expect(send).not.toHaveAttribute("aria-label", "Stop run", { timeout: 5_000 });
  });
  await window.screenshot({ path: testInfo.outputPath("stopped.png") });

  const check = await timed(testInfo, "next tool call after Stop", async () => {
    await sendPrompt(window, "run b6-check");
    return waitForScriptResult(window, "b6-check", TOOL_CALL_TIMEOUT_MS);
  });
  expect(check).toContain("isError=false");
  expect(check).toMatch(/^none$/m);
  expect(check).not.toContain("sleep 120");
  await expect(sandboxStatus(window)).toHaveAttribute("data-state", "on");
  await quit(harness);
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
  // The sandbox mounts the worktree and the main repository's shared git directory.
  const [sandbox] = await ownSandboxes();
  expect(sandbox?.status).toBe("running");
  expect(sandbox?.workspaces).toEqual(
    expect.arrayContaining([worktreePath, join(fixture.workspacePath, ".git")]),
  );

  // The commit is visible from the host, in the worktree and in the main repository.
  expect(await git(worktreePath, "log", "-1", "--format=%s")).toBe("Commit from the sandbox");
  expect(await git(worktreePath, "status", "--porcelain")).toBe("");
  const branch = await git(worktreePath, "branch", "--show-current");
  expect(await git(fixture.workspacePath, "log", "-1", "--format=%an|%s", branch)).toBe(
    "Pi App Tests|Commit from the sandbox",
  );
  expect(await git(fixture.workspacePath, "log", "-1", "--format=%s", "main")).toBe("init");
  await quit(harness);
});

interface NetworkFixture extends Fixture {
  readonly logPath: string;
  hostCounts(host: string): Promise<{ allowed: number; blocked: number } | undefined>;
}

/** A repository whose saved settings block example.com, and a reader for its host log. */
async function createNetworkFixture(
  name: string,
  scripts: Readonly<Record<string, ScriptedToolCall>>,
): Promise<NetworkFixture> {
  const fixture = await createFixture(name, scripts);
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
  const logPath = join(sandboxDir, "network-log.json");
  type HostLog = { host: string; allowedCount: number; blockedCount: number }[];
  return {
    ...fixture,
    logPath,
    async hostCounts(host) {
      if (!existsSync(logPath)) return undefined;
      const log = JSON.parse(await readFile(logPath, "utf8")) as {
        repos: Record<string, HostLog>;
      };
      const entry = (log.repos[fixture.workspacePath] ?? []).find(
        (candidate) => candidate.host === host,
      );
      return entry ? { allowed: entry.allowedCount, blocked: entry.blockedCount } : undefined;
    },
  };
}

/** The app folds `sbx policy log` into its host log every 5 s while the thread is open. */
async function waitForBlockedCount(fixture: NetworkFixture, atLeast: number): Promise<void> {
  await expect
    .poll(async () => (await fixture.hostCounts("example.com"))?.blocked ?? 0, {
      message: `example.com is logged as blocked at least ${atLeast} time(s)`,
      timeout: 45_000,
    })
    .toBeGreaterThanOrEqual(atLeast);
}

test("SBX-F2/F3: a blocked host gets the policy response and every host is logged", async ({}, testInfo) => {
  test.setTimeout(FIRST_TOOL_CALL_TIMEOUT_MS + 2 * 60_000);
  const fixture = await createNetworkFixture("sandbox-network", {
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
  const harness = await launchSandboxedApp(fixture);
  const window = await harness.firstWindow();
  await waitForWorkspaceByPath(window, fixture.workspacePath);
  const output = await timed(testInfo, "blocked and allowed curl", async () => {
    await startThreadFromSurface(window, { prompt: "run f2-curl" });
    return waitForScriptResult(window, "f2-curl", FIRST_TOOL_CALL_TIMEOUT_MS);
  });
  await window.screenshot({ path: testInfo.outputPath("network-policy.png") });
  expect(output).toContain("Blocked by local rule for example.com");
  expect(output).toContain("allowed-status=200");

  await timed(testInfo, "blocked host reaches the host log", () => waitForBlockedCount(fixture, 1));
  await expect
    .poll(async () => (await fixture.hostCounts("example.org"))?.allowed ?? 0, {
      message: "example.org is logged as allowed",
      timeout: 30_000,
    })
    .toBeGreaterThanOrEqual(1);
  await quit(harness);

  // Quitting flushes the log; it keeps host names and counts, never URLs.
  const logSource = await readFile(fixture.logPath, "utf8");
  expect(await fixture.hostCounts("example.com")).toEqual({ allowed: 0, blocked: 1 });
  expect((await fixture.hostCounts("example.org"))?.allowed).toBeGreaterThanOrEqual(1);
  expect(logSource).not.toContain("secret-query");
  expect(logSource).not.toContain("/some/path");
});

test("SBX-F2: the host log survives a restart and counts each request once", async ({}, testInfo) => {
  test.setTimeout(FIRST_TOOL_CALL_TIMEOUT_MS + 3 * 60_000);
  const fixture = await createNetworkFixture("sandbox-network-restart", {
    "f2r-curl": { name: "bash", arguments: { command: "curl -sS https://example.com/ 2>&1" } },
  });
  let harness = await launchSandboxedApp(fixture);
  let window = await harness.firstWindow();
  await waitForWorkspaceByPath(window, fixture.workspacePath);
  await startThreadFromSurface(window, { prompt: "run f2r-curl" });
  expect(await waitForScriptResult(window, "f2r-curl", FIRST_TOOL_CALL_TIMEOUT_MS)).toContain(
    "Blocked by local rule for example.com",
  );
  await waitForBlockedCount(fixture, 1);
  await quit(harness);
  expect((await fixture.hostCounts("example.com"))?.blocked).toBe(1);

  harness = await launchSandboxedApp(fixture);
  window = await harness.firstWindow();
  await waitForWorkspaceByPath(window, fixture.workspacePath);
  const replies = window
    .locator(".timeline-item--assistant .message__content")
    .filter({ hasText: "DONE f2r-curl " });
  await expect(replies).toHaveCount(1, { timeout: 15_000 });
  await timed(testInfo, "blocked curl after restart", async () => {
    await sendPrompt(window, "run f2r-curl");
    await expect(replies).toHaveCount(2, { timeout: TOOL_CALL_TIMEOUT_MS });
  });
  await expect(replies.nth(1)).toContainText("Blocked by local rule for example.com");
  await waitForBlockedCount(fixture, 2);
  // Two more polls of sbx's log must not count anything again.
  await new Promise((resolve) => setTimeout(resolve, 12_000));
  await quit(harness);
  expect((await fixture.hostCounts("example.com"))?.blocked).toBe(2);
});

test("SBX-G1: without sbx the tool fails closed and nothing runs on the host", async ({}, testInfo) => {
  test.setTimeout(2 * 60_000);
  const fixture = await createFixture("sandbox-no-sbx", {
    "g1-touch": { name: "bash", arguments: { command: "touch g1-marker.txt; uname -s" } },
    "g1-write": { name: "write", arguments: { path: "g1-written.txt", content: "host\n" } },
  });
  // git lives in /usr/bin on macOS and Linux; sbx (Homebrew or a package) must not be reachable.
  const noSbxPath = "/usr/bin:/bin:/usr/sbin:/sbin";
  for (const folder of noSbxPath.split(":")) {
    expect(existsSync(join(folder, "sbx")), `sbx in ${folder}`).toBe(false);
  }
  const harness = await launchSandboxedApp(fixture, {
    PATH: noSbxPath,
    PI_APP_TEST_EXACT_PATH: "1",
  });
  const window = await harness.firstWindow();
  await waitForWorkspaceByPath(window, fixture.workspacePath);
  const output = await timed(testInfo, "failing tool call", async () => {
    await startThreadFromSurface(window, { prompt: "run g1-touch" });
    return waitForScriptResult(window, "g1-touch", TOOL_CALL_TIMEOUT_MS);
  });
  await window.screenshot({ path: testInfo.outputPath("no-sbx.png") });
  expect(output).toContain("isError=true");
  expect(output).toContain("Docker Sandboxes (sbx) is not installed");
  expect(output).not.toContain("Darwin");
  await expect(sandboxStatus(window)).toHaveAttribute("data-state", "failed");
  await expect(sandboxStatus(window)).toHaveAttribute("title", /sbx\) is not installed/);
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
  expect(await ownSandboxes()).toEqual([]);
  await quit(harness);
});

test("SBX-E5: quitting the app stops the thread's sandbox and a reopened thread starts it again", async ({}, testInfo) => {
  test.setTimeout(FIRST_TOOL_CALL_TIMEOUT_MS + 3 * 60_000);
  const fixture = await createFixture("sandbox-quit", {
    "e5-before": { name: "bash", arguments: { command: "echo before > before.txt; uname -s" } },
    "e5-after": { name: "bash", arguments: { command: "cat before.txt; uname -s" } },
  });
  let harness = await launchSandboxedApp(fixture);
  let window = await harness.firstWindow();
  await waitForWorkspaceByPath(window, fixture.workspacePath);
  await startThreadFromSurface(window, { prompt: "run e5-before" });
  expect(await waitForScriptResult(window, "e5-before", FIRST_TOOL_CALL_TIMEOUT_MS)).toMatch(
    /^Linux$/m,
  );
  await expectOwnSandboxes(["running"], "the thread's sandbox runs");
  const [sandbox] = await ownSandboxes();
  await timed(testInfo, "quit until the sandbox is stopped", async () => {
    await quit(harness);
    await expectOwnSandboxes(["stopped"], "quitting stops the thread's sandbox", 15_000);
  });

  harness = await launchSandboxedApp(fixture);
  window = await harness.firstWindow();
  await waitForWorkspaceByPath(window, fixture.workspacePath);
  await expect(
    window.locator(".timeline-item--assistant .message__content").filter({
      hasText: "DONE e5-before ",
    }),
  ).toBeVisible({ timeout: 15_000 });
  const output = await timed(testInfo, "tool call after restart (stopped sandbox)", async () => {
    await sendPrompt(window, "run e5-after");
    return waitForScriptResult(window, "e5-after", TOOL_CALL_TIMEOUT_MS);
  });
  expect(output).toContain("isError=false");
  expect(output).toMatch(/^before$/m);
  expect(output).toMatch(/^Linux$/m);
  // The thread reuses its sandbox (same name), started again.
  expect((await ownSandboxes()).map((entry) => [entry.name, entry.status])).toEqual([
    [sandbox!.name, "running"],
  ]);
  await quit(harness);
  await expectOwnSandboxes(["stopped"], "quitting stops the thread's sandbox", 15_000);
});

test("SBX-E5: a sandbox left running by a crashed app is stopped on the next launch", async ({}, testInfo) => {
  test.setTimeout(FIRST_TOOL_CALL_TIMEOUT_MS + 3 * 60_000);
  const fixture = await createFixture("sandbox-crash", {
    "e5c-start": { name: "bash", arguments: { command: "uname -s" } },
  });
  let harness = await launchSandboxedApp(fixture);
  const window = await harness.firstWindow();
  await waitForWorkspaceByPath(window, fixture.workspacePath);
  await startThreadFromSurface(window, { prompt: "run e5c-start" });
  expect(await waitForScriptResult(window, "e5c-start", FIRST_TOOL_CALL_TIMEOUT_MS)).toMatch(
    /^Linux$/m,
  );
  await expectOwnSandboxes(["running"], "the thread's sandbox runs");

  // A crash: the app gets no chance to stop its sandbox.
  const crashedPid = appPid(harness);
  process.kill(crashedPid, "SIGKILL");
  await quit(harness).catch(() => undefined);
  const orphans = await processGroup(crashedPid);
  testInfo.annotations.push({
    type: "after crash",
    description: `own sandboxes: ${(await ownSandboxStatuses()).join(", ")}; processes left in the app's group: ${
      orphans.map((row) => `${row.pid} ${row.command.slice(0, 120)}`).join(" | ") || "none"
    }`,
  });
  expect(await ownSandboxStatuses(), "the crash leaves the sandbox running").toEqual(["running"]);

  try {
    harness = await launchSandboxedApp(fixture);
    await harness.firstWindow();
    await timed(testInfo, "relaunch until the leftover sandbox is stopped", () =>
      expectOwnSandboxes(["stopped"], "the relaunched app stops the crashed run's sandbox", 60_000),
    );
    await quit(harness);
  } finally {
    // The crashed app's own children (its sbx exec connections), by PID, if any outlived it.
    for (const row of await processGroup(crashedPid)) {
      try {
        process.kill(row.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
});

test("SBX-E6: archiving a thread stops its sandbox", async ({}, testInfo) => {
  test.setTimeout(FIRST_TOOL_CALL_TIMEOUT_MS + 2 * 60_000);
  const fixture = await createFixture("sandbox-archive", {
    "e6-start": { name: "bash", arguments: { command: "uname -s" } },
  });
  const harness = await launchSandboxedApp(fixture);
  const window = await harness.firstWindow();
  await waitForWorkspaceByPath(window, fixture.workspacePath);
  await startThreadFromSurface(window, { prompt: "run e6-start" });
  expect(await waitForScriptResult(window, "e6-start", FIRST_TOOL_CALL_TIMEOUT_MS)).toMatch(
    /^Linux$/m,
  );
  await expectOwnSandboxes(["running"], "the thread's sandbox runs");

  const title = (await window.locator(".chat-header__title").innerText()).trim();
  const row = window.locator(".session-list > .session-row").filter({ hasText: title }).first();
  await row.hover();
  await row.getByLabel(`Archive ${title}`).click();
  await expect(window.locator(".archived-thread-group")).toContainText("Archived");
  await timed(testInfo, "archive until the sandbox is stopped", () =>
    expectOwnSandboxes(["stopped"], "archiving stops the thread's sandbox"),
  );
  await window.screenshot({ path: testInfo.outputPath("archived.png") });
  await quit(harness);
});
