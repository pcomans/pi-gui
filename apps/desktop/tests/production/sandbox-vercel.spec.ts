import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { Sandbox } from "@vercel/sandbox";
import { vercelSandboxCredentials } from "../../electron/sandbox/sandbox-vercel";
import {
  chooseReviewScope,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  seedAgentDir,
  selectSidePanel,
  selectSession,
  startThreadFromSurface,
  waitForTimelineLayout,
  type DesktopHarness,
} from "../helpers/electron-app";
import { scriptedProviderExtension } from "../helpers/sandbox-scripted-provider";

const repository = "https://github.com/octocat/Hello-World";
test.skip(
  process.env.PI_APP_VERCEL_SANDBOX_E2E !== "1",
  "Opt in with PI_APP_VERCEL_SANDBOX_E2E=1 and Vercel project credentials.",
);

async function openRepository(page: Page) {
  await page.getByRole("button", { name: "Open repository", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Open repository" });
  await dialog.getByLabel("Repository URL").fill(repository);
  await dialog.getByRole("button", { name: "Open repository", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  return (await getDesktopState(page)).workspaces.find(
    (workspace) => workspace.repositoryUrl === repository,
  )!;
}
async function result(page: Page, tag: string) {
  const reply = page
    .locator(".timeline-item--assistant .message__content")
    .filter({ hasText: `DONE ${tag} isError=` })
    .last();
  await expect(reply).toBeVisible({ timeout: 180_000 });
  await expect(page.getByTestId("send")).not.toHaveAttribute("aria-label", "Stop run");
  return reply.innerText();
}
async function send(page: Page, text: string) {
  await page.getByTestId("composer").fill(text);
  await page.getByTestId("composer").press("Enter");
}
async function sandboxName(profile: string): Promise<string> {
  const root = path.join(profile, "sandbox", "vercel");
  const dirs = await readdir(root);
  const markers = await Promise.all(
    dirs.map(
      async (dir) =>
        JSON.parse(await readFile(path.join(root, dir, "created.json"), "utf8")) as {
          name: string;
        },
    ),
  );
  return markers[0]!.name;
}

test("remote workspace: tools, Files, Review, staging, PTY, Stop and persistent resume without a local checkout", async ({}, testInfo) => {
  test.setTimeout(600_000);
  await vercelSandboxCredentials();
  const profile = await makeUserDataDir("pi-gui-remote-proof-");
  const agentDir = path.join(profile, "agent");
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
  await mkdir(path.join(agentDir, "extensions"));
  await writeFile(
    path.join(agentDir, "extensions", "sandbox-e2e.ts"),
    scriptedProviderExtension({
      remote: {
        name: "bash",
        arguments: {
          command:
            "uname -s; pwd; cat README; printf 'REMOTE_ONLY\\n' > notes.txt; printf PERSISTED > /tmp/pi-gui-persisted",
        },
      },
      write: { name: "write", arguments: { path: "created/tool.txt", content: "TOOL_WRITE\n" } },
      edit: {
        name: "edit",
        arguments: { path: "notes.txt", oldText: "REMOTE_ONLY", newText: "EDITED_REMOTE" },
      },
      stop: {
        name: "bash",
        arguments: {
          command: "touch /tmp/pi-gui-stop-started; (sleep 30; printf BAD > cancelled.txt) & wait",
        },
      },
      resume: {
        name: "bash",
        arguments: {
          command:
            "cat notes.txt created/tool.txt /tmp/pi-gui-persisted; test ! -e cancelled.txt && echo STOPPED; cat terminal.txt",
        },
      },
      fork: {
        name: "bash",
        arguments: {
          command: "cat notes.txt; printf FORK_ONLY > fork.txt; printf FORK_EDIT > notes.txt",
        },
      },
      source: {
        name: "bash",
        arguments: { command: "cat notes.txt; test ! -e fork.txt && echo ISOLATED_SOURCE" },
      },
    }),
  );
  const launch = () => launchDesktop(profile, { agentDir, scrubProviderEnv: true });
  let app: DesktopHarness | undefined = await launch();
  try {
    const page = await app.firstWindow();
    const workspace = await openRepository(page);
    await startThreadFromSurface(page, { prompt: "run remote" });
    const output = await result(page, "remote");
    expect(output).toContain("isError=false");
    expect(output).toContain("Linux");
    expect(output).toContain("/vercel/sandbox");
    await send(page, "run write");
    expect(await result(page, "write")).toContain("isError=false");
    await send(page, "run edit");
    expect(await result(page, "edit")).toContain("isError=false");
    await selectSidePanel(page, "Files");
    const remoteFile = page.getByTestId("file-explorer").locator('[data-file-path="notes.txt"]');
    await expect(remoteFile).toBeVisible();
    await remoteFile.click();
    await expect(page.getByTestId("file-editor")).toContainText("EDITED_REMOTE");
    await selectSidePanel(page, "Review");
    await chooseReviewScope(page, "Last Turn");
    await expect(page.locator('.diff-panel__file[data-file-path="notes.txt"]')).toBeVisible();
    await expect(page.getByRole("region", { name: "Diff", exact: true })).toContainText(
      "EDITED_REMOTE",
    );
    await chooseReviewScope(page, "Uncommitted");
    const notes = page.locator('.diff-panel__file[data-file-path="notes.txt"]');
    await notes.getByRole("button", { name: "Stage", exact: true }).click();
    await chooseReviewScope(page, "Staged");
    await expect(notes).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("remote-review.png") });
    await selectSidePanel(page, "Terminal");
    await expect(page.locator(".terminal-panel")).toContainText(
      "Runs in this thread’s Vercel Sandbox",
    );
    const terminal = page.locator(".terminal-panel .xterm-helper-textarea");
    await terminal.pressSequentially(
      "printf 'TERMINAL_REMOTE\\n' > terminal.txt; pwd; test -t 0 && echo PTY_CONFIRMED",
    );
    await terminal.press("Enter");
    await expect
      .poll(async () => page.locator(".terminal-panel .xterm-screen").innerText(), {
        timeout: 30_000,
      })
      .toContain("PTY_CONFIRMED");
    await page.screenshot({ path: testInfo.outputPath("remote-terminal.png") });
    const name = await sandboxName(profile);
    const remote = await Sandbox.get({ ...(await vercelSandboxCredentials()), name });
    const terminalFile = await remote.runCommand("cat", ["/vercel/sandbox/terminal.txt"]);
    expect(await terminalFile.stdout()).toBe("TERMINAL_REMOTE\n");
    await send(page, "run stop");
    await expect
      .poll(
        async () => (await remote.runCommand("test", ["-f", "/tmp/pi-gui-stop-started"])).exitCode,
        { timeout: 30_000 },
      )
      .toBe(0);
    await page.getByRole("button", { name: "Stop run", exact: true }).click();
    await expect(page.getByTestId("send")).not.toHaveAttribute("aria-label", "Stop run");
    const descendants = await remote.runCommand("bash", ["-c", "pgrep -af '[s]leep 30' || true"]);
    expect((await descendants.stdout()).trim()).toBe("");
    expect(await readdir(workspace.path)).not.toContain("notes.txt");
    expect(await readdir(workspace.path)).not.toContain(".git");
    await app.close();
    app = undefined;
    const credentials = await vercelSandboxCredentials();
    await expect
      .poll(async () => (await Sandbox.get({ ...credentials, name })).status, { timeout: 30_000 })
      .toBe("stopped");
    const stopped = await Sandbox.get({ ...credentials, name });
    app = await launch();
    const restarted = await app.firstWindow();
    await expect(restarted.getByTestId("composer")).toBeVisible();
    await send(restarted, "run resume");
    const resumed = await result(restarted, "resume");
    for (const marker of ["EDITED_REMOTE", "TOOL_WRITE", "PERSISTED", "STOPPED", "TERMINAL_REMOTE"])
      expect(resumed).toContain(marker);
    const running = await Sandbox.get({ ...credentials, name });
    expect(running.currentSession().sessionId).not.toBe(stopped.currentSession().sessionId);
    await restarted.screenshot({ path: testInfo.outputPath("remote-resumed.png") });
    const sourceSessionId = (await getDesktopState(restarted)).selectedSessionId;
    await waitForTimelineLayout(restarted);
    const forkAnswer = restarted
      .locator(".timeline-item--assistant")
      .filter({ hasText: "DONE resume" })
      .last();
    await forkAnswer.hover();
    await forkAnswer.getByTestId("fork-from-message").click();
    await restarted.getByTestId("fork-modal-confirm").click();
    await expect(restarted.getByTestId("fork-modal")).toHaveCount(0, { timeout: 90_000 });
    expect((await getDesktopState(restarted)).selectedSessionId).not.toBe(sourceSessionId);
    await send(restarted, "run fork");
    const forked = await result(restarted, "fork");
    expect(forked).toContain("isError=false");
    expect(forked).toContain("EDITED_REMOTE");
    await selectSidePanel(restarted, "Files");
    await expect(
      restarted.getByTestId("file-explorer").locator('[data-file-path="fork.txt"]'),
    ).toBeVisible();
    await restarted.screenshot({ path: testInfo.outputPath("remote-fork.png") });
    const state = await getDesktopState(restarted);
    const sourceTitle = state.workspaces
      .find((entry) => entry.id === workspace.id)!
      .sessions.find((entry) => entry.id === sourceSessionId)!.title;
    await selectSession(restarted, sourceTitle);
    await send(restarted, "run source");
    const unchanged = await result(restarted, "source");
    expect(unchanged).toContain("EDITED_REMOTE");
    expect(unchanged).toContain("ISOLATED_SOURCE");
    await selectSidePanel(restarted, "Files");
    await expect(
      restarted.getByTestId("file-explorer").locator('[data-file-path="notes.txt"]'),
    ).toBeVisible();
    await expect(
      restarted.getByTestId("file-explorer").locator('[data-file-path="fork.txt"]'),
    ).toHaveCount(0);
    await writeFile(
      testInfo.outputPath("proof.json"),
      JSON.stringify(
        {
          profile,
          metadataPath: workspace.path,
          repository,
          sandboxName: name,
          stoppedSessionId: stopped.currentSession().sessionId,
          resumedSessionId: running.currentSession().sessionId,
          evidence: "Scripted provider, real Vercel Sandbox, visible Electron",
          passed: [
            "URL-onboarding",
            "bash",
            "write",
            "edit",
            "Files",
            "Review",
            "last-turn",
            "staging",
            "PTY",
            "Stop-descendants",
            "restart-resume",
            "fork-snapshot-and-isolation",
            "no-local-checkout",
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    await app?.close();
  }
});

test("real model edits a cloud repository through visible Electron without a local checkout", async ({}, testInfo) => {
  test.skip(process.env.PI_APP_REAL_AUTH !== "1", "Explicit real-provider opt-in is required.");
  test.setTimeout(240_000);
  const source = process.env.PI_APP_REAL_AUTH_SOURCE_DIR;
  if (!source) throw new Error("PI_APP_REAL_AUTH_SOURCE_DIR is required.");
  const provider = process.env.PI_GUI_PROVIDER ?? "vercel-ai-gateway";
  const model = process.env.PI_GUI_MODEL ?? "anthropic/claude-haiku-4.5";
  const profile = await makeUserDataDir("pi-gui-remote-model-");
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
  const app = await launchDesktop(profile, {
    agentDir,
    scrubProviderEnv: true,
    envOverrides: { PI_APP_TEST_MODE: undefined },
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
      appPath: path.resolve("apps/desktop"),
      userData: profile,
      visible: true,
      focused: true,
      testMode: null,
      hooks: false,
    });
    await writeFile(testInfo.outputPath("doctor.json"), JSON.stringify(identity, null, 2));
    const workspace = await openRepository(page);
    await startThreadFromSurface(page, {
      prompt:
        "Use bash to run uname -s, then use write to create live-proof.txt containing exactly REMOTE_PROVIDER_FILE followed by a newline, then read live-proof.txt with read. Finish with exactly LIVE_REMOTE_CONFIRMED. Do not use other tools.",
    });
    const answer = page.locator(".timeline-item--assistant .message__content").last();
    const error = page.getByTestId("composer-error-banner");
    await expect(answer.or(error)).toBeVisible({ timeout: 180_000 });
    await expect(error).toHaveCount(0);
    await expect(page.getByTestId("send")).not.toHaveAttribute("aria-label", "Stop run", {
      timeout: 180_000,
    });
    await expect(answer).toContainText("LIVE_REMOTE_CONFIRMED");
    const name = await sandboxName(profile);
    const remote = await Sandbox.get({ ...(await vercelSandboxCredentials()), name });
    expect(
      await (await remote.runCommand("cat", ["/vercel/sandbox/live-proof.txt"])).stdout(),
    ).toBe("REMOTE_PROVIDER_FILE\n");
    await expect(readFile(path.join(workspace.path, "live-proof.txt"))).rejects.toThrow();
    await waitForTimelineLayout(page);
    const bash = page
      .locator(".timeline-tool")
      .filter({ has: page.locator(".timeline-tool__header").filter({ hasText: /\bbash\b/i }) })
      .first();
    await bash.locator(".timeline-tool__header").click();
    await expect(bash.locator(".timeline-tool__pre")).toContainText("Linux");
    await selectSidePanel(page, "Review");
    await chooseReviewScope(page, "Last Turn");
    await expect(page.locator('.diff-panel__file[data-file-path="live-proof.txt"]')).toBeVisible();
    await expect(page.getByRole("region", { name: "Diff", exact: true })).toContainText(
      "REMOTE_PROVIDER_FILE",
    );
    await page.screenshot({ path: testInfo.outputPath("remote-real-model.png") });
    await writeFile(
      testInfo.outputPath("model-proof.json"),
      JSON.stringify(
        {
          provider,
          model,
          repository,
          sandboxName: name,
          metadataPath: workspace.path,
          evidence: "Real provider, real Vercel Sandbox, visible Electron, test hooks absent",
          passed: [
            "URL-onboarding",
            "bash",
            "write",
            "read",
            "remote-file-side-effect",
            "no-local-file",
            "last-turn-review",
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    await app.close();
  }
});
