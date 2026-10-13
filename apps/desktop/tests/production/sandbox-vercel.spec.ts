import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";
import { Sandbox } from "@vercel/sandbox";
import { vercelSandboxCredentials } from "../../electron/sandbox/sandbox-vercel";
import {
  chooseReviewScope,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  selectSidePanel,
  startThreadFromSurface,
  waitForWorkspaceByPath,
  waitForTimelineLayout,
  writeProjectExtension,
  type DesktopHarness,
} from "../helpers/electron-app";
import { scriptedProviderExtension } from "../helpers/sandbox-scripted-provider";

const execFileAsync = promisify(execFile);
const enabled = process.env.PI_APP_VERCEL_SANDBOX_E2E === "1";
test.skip(
  !enabled,
  "Opt in with PI_APP_VERCEL_SANDBOX_E2E=1 and VERCEL_TEAM_ID / VERCEL_PROJECT_ID.",
);

async function result(page: Page, tag: string) {
  const reply = page
    .locator(".timeline-item--assistant .message__content")
    .filter({ hasText: `DONE ${tag} isError=` })
    .last();
  await expect(reply).toBeVisible({ timeout: 180_000 });
  await expect(page.getByTestId("send")).not.toHaveAttribute("aria-label", "Stop run");
  return await reply.innerText();
}

async function send(page: Page, prompt: string) {
  await page.getByTestId("composer").fill(prompt);
  await page.getByTestId("composer").press("Enter");
}

test("Vercel POC: remote tools, Review, last turn, Stop, conflicts and persistent resume", async ({}, testInfo) => {
  test.setTimeout(600_000);
  if (!process.env.VERCEL_TEAM_ID || !process.env.VERCEL_PROJECT_ID)
    throw new Error("Vercel project configuration is required; this proof never silently skips.");
  const profile = await makeUserDataDir("pi-gui-vercel-proof-");
  const agentDir = path.join(profile, "agent");
  const workspace = await makeWorkspace("vercel-poc");
  await seedAgentDir(agentDir, { withOpenAiAuth: false, withDefaultModel: false });
  await writeFile(
    path.join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: "sandbox-e2e",
      defaultModel: "scripted",
      enabledModels: ["sandbox-e2e/scripted"],
      packages: [],
      compaction: { enabled: false },
    }),
  );
  await writeFile(path.join(workspace, "notes.txt"), "LOCAL_INITIAL\n");
  await mkdir(path.join(workspace, ".pi"));
  await writeFile(
    path.join(workspace, ".pi", "sandbox.json"),
    JSON.stringify({ setup: "test -f notes.txt; printf 'SETUP_REMOTE\\n' > /tmp/pi-gui-setup" }),
  );
  await writeFile(path.join(workspace, ".gitignore"), "ignored/\n");
  await mkdir(path.join(workspace, "ignored"));
  await writeFile(path.join(workspace, "ignored", "private.txt"), "HOST_ONLY\n");
  await writeProjectExtension(
    workspace,
    "sandbox-e2e.ts",
    scriptedProviderExtension({
      remote: {
        name: "bash",
        arguments: {
          command:
            "uname -s; cat /tmp/pi-gui-setup; printf 'FROM_REMOTE\\n' > notes.txt; printf 'PERSISTED\\n' > /tmp/pi-gui-persisted; test ! -e ignored/private.txt && echo IGNORED_EXCLUDED",
        },
      },
      write: { name: "write", arguments: { path: "created/tool.txt", content: "TOOL_WRITE\n" } },
      edit: {
        name: "edit",
        arguments: { path: "notes.txt", oldText: "FROM_REMOTE", newText: "EDITED_REMOTE" },
      },
      stop: {
        name: "bash",
        arguments: {
          command:
            "touch /tmp/pi-gui-stop-started; sleep 120; printf 'SHOULD_NOT_EXIST\\n' > cancelled.txt",
        },
      },
      conflict: {
        name: "bash",
        arguments: {
          command:
            "touch /tmp/pi-gui-conflict-started; sleep 8; printf 'REMOTE_CONFLICT\\n' > notes.txt",
        },
      },
      "resume-stop": {
        name: "bash",
        arguments: {
          command:
            "cat /tmp/pi-gui-persisted; cat notes.txt; cat created/tool.txt; if ps -eo args | grep -q '[s]leep 120'; then echo CHILD_STILL_RUNNING; else echo CHILD_STOPPED; fi",
        },
      },
      "resume-resolved": {
        name: "bash",
        arguments: {
          command:
            "cat /tmp/pi-gui-persisted; cat notes.txt; cat created/tool.txt; if ps -eo args | grep -q '[s]leep 120'; then echo CHILD_STILL_RUNNING; else echo CHILD_STOPPED; fi",
        },
      },
      "resume-restart": {
        name: "bash",
        arguments: {
          command:
            "cat /tmp/pi-gui-persisted; cat notes.txt; cat created/tool.txt; if ps -eo args | grep -q '[s]leep 120'; then echo CHILD_STILL_RUNNING; else echo CHILD_STOPPED; fi",
        },
      },
    }),
  );
  await execFileAsync("git", ["init", "-q", workspace]);
  await execFileAsync("git", ["add", "-A"], { cwd: workspace });
  await execFileAsync(
    "git",
    ["-c", "user.name=Proof", "-c", "user.email=proof@localhost", "commit", "-qm", "initial"],
    { cwd: workspace },
  );
  let app: DesktopHarness | undefined;
  const launch = async () =>
    launchDesktop(profile, {
      agentDir,
      initialWorkspaces: [workspace],
      scrubProviderEnv: true,
      testMode: "foreground",
      envOverrides: { PI_APP_SANDBOX: "1", PI_APP_SANDBOX_BACKEND: "vercel" },
    });
  try {
    app = await launch();
    const page = await app.firstWindow();
    await waitForWorkspaceByPath(page, workspace);
    await startThreadFromSurface(page, { prompt: "run remote" });
    const initial = await result(page, "remote");
    expect(initial).toContain("isError=false");
    expect(initial).toContain("SETUP_REMOTE");
    await expect(page.locator(".timeline-item--assistant .message__content").last()).toContainText(
      "Linux",
    );
    expect(await readFile(path.join(workspace, "notes.txt"), "utf8")).toBe("FROM_REMOTE\n");
    const [state] = await readdir(path.join(profile, "sandbox", "vercel"));
    const remote = await Sandbox.get({
      ...(await vercelSandboxCredentials()),
      name: `pi-gui-poc-${state!}`,
    });
    await expect(page.getByTestId("timeline-tool-location").first()).toHaveAttribute(
      "data-location",
      "sandbox",
    );

    await selectSidePanel(page, "Review");
    await chooseReviewScope(page, "Uncommitted");
    const review = page.getByRole("region", { name: "Review", exact: true });
    const notes = review.locator('.diff-panel__file[data-file-path="notes.txt"]');
    await expect(notes).toBeVisible();
    await notes.locator(".diff-panel__file-name").click();
    await expect(review.getByRole("region", { name: "Diff", exact: true })).toContainText(
      "FROM_REMOTE",
    );
    await page.screenshot({ path: testInfo.outputPath("vercel-review.png") });
    await chooseReviewScope(page, "Last Turn");
    await expect(review.locator('.diff-panel__file[data-file-path="notes.txt"]')).toBeVisible();

    await send(page, "run write");
    expect(await result(page, "write")).toContain("isError=false");
    await send(page, "run edit");
    expect(await result(page, "edit")).toContain("isError=false");
    expect(await readFile(path.join(workspace, "notes.txt"), "utf8")).toBe("EDITED_REMOTE\n");
    await send(page, "run stop");
    await expect
      .poll(
        async () => (await remote.readFileToBuffer({ path: "/tmp/pi-gui-stop-started" })) !== null,
        { timeout: 30_000 },
      )
      .toBe(true);
    await page.getByRole("button", { name: "Stop run", exact: true }).click();
    await expect(page.getByTestId("send")).not.toHaveAttribute("aria-label", "Stop run", {
      timeout: 30_000,
    });
    await expect(readFile(path.join(workspace, "cancelled.txt"))).rejects.toThrow();
    await send(page, "run resume-stop");
    const afterStop = await result(page, "resume-stop");
    expect(afterStop).toContain("PERSISTED");
    expect(afterStop).toContain("CHILD_STOPPED");
    expect(afterStop).not.toContain("CHILD_STILL_RUNNING");

    // Modify the local checkout while a remote command is running.
    await send(page, "run conflict");
    await expect
      .poll(
        async () =>
          (await remote.readFileToBuffer({ path: "/tmp/pi-gui-conflict-started" })) !== null,
        { timeout: 30_000 },
      )
      .toBe(true);
    await writeFile(path.join(workspace, "notes.txt"), "LOCAL_CONFLICT\n");
    expect(await result(page, "conflict")).toContain("Sandbox sync conflict");
    expect(await readFile(path.join(workspace, "notes.txt"), "utf8")).toBe("LOCAL_CONFLICT\n");
    const recovery = path.join(profile, "sandbox", "vercel", state!, "recovery");
    const recoveries = await readdir(recovery, { recursive: true });
    const saved = recoveries.filter((name) => name.endsWith("notes.txt"));
    const contents = await Promise.all(
      saved.map((name) => readFile(path.join(recovery, name), "utf8")),
    );
    expect(contents).toContain("REMOTE_CONFLICT\n");
    // Explicitly resolve by choosing the remote version.
    await writeFile(path.join(workspace, "notes.txt"), "REMOTE_CONFLICT\n");
    await send(page, "run resume-resolved");
    expect(await result(page, "resume-resolved")).toContain("isError=false");
    await app.close();
    app = undefined;
    const credentials = await vercelSandboxCredentials();
    // stop() acknowledges the request before Vercel finishes snapshotting the filesystem.
    await expect
      .poll(async () => (await Sandbox.get({ ...credentials, name: remote.name! })).status, {
        timeout: 30_000,
      })
      .toBe("stopped");
    const stopped = await Sandbox.get({ ...credentials, name: remote.name! });
    app = await launch();
    const restarted = await app.firstWindow();
    await expect(restarted.getByTestId("composer")).toBeVisible();
    await send(restarted, "run resume-restart");
    const resumed = await result(restarted, "resume-restart");
    expect(resumed).toContain("PERSISTED");
    expect(resumed).toContain("REMOTE_CONFLICT");
    expect(resumed).toContain("TOOL_WRITE");
    const running = await Sandbox.get({
      ...(await vercelSandboxCredentials()),
      name: remote.name!,
    });
    expect(running.status).toBe("running");
    expect(running.currentSession().sessionId).not.toBe(stopped.currentSession().sessionId);
    await restarted.screenshot({ path: testInfo.outputPath("vercel-resumed.png") });
    await writeFile(
      testInfo.outputPath("proof.json"),
      JSON.stringify(
        {
          profile,
          workspace,
          evidence: "Scripted provider, real Vercel Sandbox, visible Electron",
          sandboxName: running.name,
          stoppedStatus: stopped.status,
          resumedStatus: running.status,
          stoppedSessionId: stopped.currentSession().sessionId,
          resumedSessionId: running.currentSession().sessionId,
          passed: [
            "bash",
            "write",
            "edit",
            "review",
            "last-turn",
            "stop",
            "conflict-recovery",
            "restart-resume",
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    await app?.close();
    // Preserve the profile, source checkout, screenshots and stopped sandbox for review.
  }
});

test("Vercel POC: real model executes tools through visible Electron", async ({}, testInfo) => {
  test.skip(process.env.PI_APP_REAL_AUTH !== "1", "Explicit real-provider opt-in is required.");
  test.setTimeout(180_000);
  const source = process.env.PI_APP_REAL_AUTH_SOURCE_DIR;
  if (!source) throw new Error("PI_APP_REAL_AUTH_SOURCE_DIR is required for the real-model proof.");
  const provider = process.env.PI_GUI_PROVIDER ?? "vercel-ai-gateway";
  const model = process.env.PI_GUI_MODEL ?? "anthropic/claude-haiku-4.5";
  const profile = await makeUserDataDir("pi-gui-vercel-model-proof-");
  await chmod(profile, 0o700);
  const agentDir = path.join(profile, "agent");
  await mkdir(agentDir, { mode: 0o700 });
  const auth = JSON.parse(await readFile(path.join(source, "auth.json"), "utf8")) as Record<
    string,
    unknown
  >;
  if (!auth[provider]) throw new Error(`No saved authentication for ${provider}`);
  await writeFile(
    path.join(agentDir, "auth.json"),
    JSON.stringify({ [provider]: auth[provider] }),
    { mode: 0o600 },
  );
  await writeFile(
    path.join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: provider,
      defaultModel: model,
      defaultThinkingLevel: "off",
      enabledModels: [`${provider}/${model}`],
      packages: [],
      compaction: { enabled: false },
    }),
  );
  const workspace = await makeWorkspace("vercel-live-model");
  await execFileAsync("git", ["init", "-q", workspace]);
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Proof",
      "-c",
      "user.email=proof@localhost",
      "commit",
      "-qm",
      "initial",
      "--allow-empty",
    ],
    { cwd: workspace },
  );
  const app = await launchDesktop(profile, {
    agentDir,
    initialWorkspaces: [workspace],
    scrubProviderEnv: true,
    envOverrides: { PI_APP_TEST_MODE: undefined, PI_APP_SANDBOX_BACKEND: "vercel" },
  });
  try {
    await app.focusWindow();
    const page = await app.firstWindow();
    const identity = await app.electronApp.evaluate(({ app, BrowserWindow }) => ({
      appPath: app.getAppPath(),
      pid: process.pid,
      userData: app.getPath("userData"),
      visible: BrowserWindow.getAllWindows()[0]?.isVisible(),
      focused: BrowserWindow.getAllWindows()[0]?.isFocused(),
      testMode: process.env.PI_APP_TEST_MODE ?? null,
      hooks: "__PI_APP_TEST_HOOKS" in globalThis,
    }));
    expect(identity).toMatchObject({
      userData: profile,
      visible: true,
      focused: true,
      testMode: null,
      hooks: false,
    });
    expect(identity.appPath).toBe(path.resolve("apps/desktop"));
    await writeFile(testInfo.outputPath("doctor.json"), JSON.stringify(identity, null, 2));
    await waitForWorkspaceByPath(page, workspace);
    await startThreadFromSurface(page, {
      prompt:
        "Verify this tool sandbox. Use the bash tool to run uname -s and create live-proof.txt containing exactly REMOTE_PROVIDER_FILE followed by a newline. Then use the read tool to read live-proof.txt. Finish with exactly LIVE_SANDBOX_CONFIRMED. Do not use other tools.",
    });
    const answer = page
      .locator(".timeline-item--assistant .message__content")
      .filter({ hasText: "LIVE_SANDBOX_CONFIRMED" })
      .last();
    const error = page.getByTestId("composer-error-banner");
    await expect(answer.or(error)).toBeVisible({ timeout: 150_000 });
    await expect(error).toHaveCount(0);
    await expect(answer).toBeVisible();
    await expect(page.getByTestId("send")).not.toHaveAttribute("aria-label", "Stop run");
    expect(await readFile(path.join(workspace, "live-proof.txt"), "utf8")).toBe(
      "REMOTE_PROVIDER_FILE\n",
    );
    await expect(page.getByTestId("timeline-tool-location").first()).toHaveAttribute(
      "data-location",
      "sandbox",
    );
    await waitForTimelineLayout(page);
    const tools = page.locator(".timeline-tool");
    const bash = tools
      .filter({ has: page.locator(".timeline-tool__header").filter({ hasText: /\bbash\b/i }) })
      .first();
    const read = tools
      .filter({ has: page.locator(".timeline-tool__header").filter({ hasText: /\bread\b/i }) })
      .first();
    await bash.locator(".timeline-tool__header").click();
    await expect(bash.locator(".timeline-tool__pre")).toContainText("Linux");
    await read.locator(".timeline-tool__header").click();
    await expect(read.locator(".timeline-tool__pre")).toContainText("REMOTE_PROVIDER_FILE");
    await selectSidePanel(page, "Review");
    await chooseReviewScope(page, "Last Turn");
    await expect(page.locator('.diff-panel__file[data-file-path="live-proof.txt"]')).toBeVisible();
    await expect(page.getByRole("region", { name: "Diff", exact: true })).toContainText(
      "REMOTE_PROVIDER_FILE",
    );
    await page.screenshot({ path: testInfo.outputPath("vercel-real-model.png") });
    await writeFile(
      testInfo.outputPath("model-proof.json"),
      JSON.stringify(
        {
          provider,
          model,
          workspace,
          identity,
          passed: ["real-provider", "remote-bash", "remote-read", "local-file", "last-turn"],
        },
        null,
        2,
      ),
    );
  } finally {
    await app.close();
  }
});
