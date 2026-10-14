import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { KIT_PROVIDER_ID } from "../../contracts/kit";
import {
  chooseReviewScope,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  seedAgentDir,
  selectSidePanel,
  startThreadFromSurface,
  waitForTimelineLayout,
} from "../helpers/electron-app";

test.skip(
  process.env.PI_APP_KIT_E2E !== "1",
  "Opt in to real Kit sign-in, model usage and Vercel compute with PI_APP_KIT_E2E=1.",
);

test("Kit browser sign-in, service tool and real model edit in a cloud workspace", async ({}, testInfo) => {
  test.setTimeout(600_000);
  const profile = process.env.PI_APP_KIT_PROFILE ?? (await makeUserDataDir("pi-gui-kit-proof-"));
  await chmod(profile, 0o700);
  const agentDir = path.join(profile, "agent");
  if (!process.env.PI_APP_KIT_PROFILE)
    await seedAgentDir(agentDir, { withOpenAiAuth: false, withDefaultModel: false });
  await writeFile(
    path.join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: KIT_PROVIDER_ID,
      defaultModel: "anthropic/claude-haiku-4.5",
      defaultThinkingLevel: "off",
      enabledModels: [`${KIT_PROVIDER_ID}/anthropic/claude-haiku-4.5`],
      packages: [],
      compaction: { enabled: false },
    }),
  );
  // This profile contains encrypted real credentials. Retain it outside shared evidence.
  const app = await launchDesktop(profile, {
    agentDir,
    scrubProviderEnv: true,
    envOverrides: { PI_APP_TEST_MODE: undefined },
  });
  try {
    await app.focusWindow();
    const page = await app.firstWindow();
    const identity = await app.electronApp.evaluate(({ app, BrowserWindow }) => ({
      pid: process.pid,
      appPath: app.getAppPath(),
      userData: app.getPath("userData"),
      visible: BrowserWindow.getAllWindows()[0]?.isVisible(),
      hooks: "__PI_APP_TEST_HOOKS" in globalThis,
      testMode: process.env.PI_APP_TEST_MODE ?? null,
    }));
    expect(identity).toMatchObject({ visible: true, hooks: false, testMode: null });
    const settingsButton = page.getByRole("button", { name: "Settings", exact: true });
    await expect(page.getByTestId("settings-surface").or(settingsButton)).toBeVisible();
    if (!(await page.getByTestId("settings-surface").isVisible())) await settingsButton.click();
    await page
      .getByRole("navigation", { name: "Settings sections" })
      .getByRole("button", { name: "Kit", exact: true })
      .click();
    await expect(page.getByTestId("settings-surface")).toContainText("Missing in this POC");
    const restored =
      (await page.evaluate(() => window.piApp!.getKitSnapshot())).state === "connected";
    if (!restored) {
      await page.getByRole("button", { name: "Connect Kit", exact: true }).click();
      const authorization = await page
        .getByRole("link", { name: "Continue in browser" })
        .getAttribute("href");
      expect(authorization).toBeTruthy();
      // Open this URL in a signed-in browser and authorize pi-gui. No cookies are read or copied.
      const authorizationFile = process.env.PI_APP_KIT_AUTHORIZATION_FILE;
      if (authorizationFile) {
        await mkdir(path.dirname(authorizationFile), { recursive: true });
        await writeFile(authorizationFile, authorization!, { mode: 0o600 });
      } else {
        await page.getByRole("link", { name: "Continue in browser" }).click();
      }
    }
    await expect(page.getByTestId("settings-surface")).toContainText(
      "Connected to Kit's cloud service.",
      { timeout: 300_000 },
    );
    await page.getByRole("button", { name: "Refresh Kit", exact: true }).click();
    await page.getByRole("button", { name: "Back to app", exact: true }).click();
    await page.getByRole("button", { name: "Open repository", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Open repository" });
    await dialog.getByLabel("Repository URL").fill("https://github.com/octocat/Hello-World");
    await dialog.getByRole("button", { name: "Open repository", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const workspace = (await getDesktopState(page)).workspaces[0]!;
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Models", exact: true }).click();
    await page.getByLabel("Search models").fill(KIT_PROVIDER_ID);
    await expect(
      page.getByRole("switch", {
        name: `Enable ${KIT_PROVIDER_ID}/anthropic/claude-haiku-4.5`,
        exact: true,
      }),
    ).toBeChecked();
    await page.getByRole("button", { name: "Back to app", exact: true }).click();
    await startThreadFromSurface(page, {
      prompt:
        "Call kit_load_kit once to verify Kit access. Do not include account details in your reply. Then use write to create kit-proof.txt containing exactly KIT_REMOTE_CONFIRMED followed by a newline. Read it with read. Finish with exactly KIT_MODEL_AND_TOOLS_CONFIRMED. Do not call any other Kit tools.",
    });
    const answer = page.locator(".timeline-item--assistant .message__content").last();
    const error = page.getByTestId("composer-error-banner");
    await expect(answer.or(error)).toBeVisible({ timeout: 180_000 });
    await expect(page.getByTestId("send")).not.toHaveAttribute("aria-label", "Stop run", {
      timeout: 180_000,
    });
    await expect(error).toHaveCount(0);
    await expect(answer).toContainText("KIT_MODEL_AND_TOOLS_CONFIRMED");
    await expect(
      page
        .locator(".timeline-tool__header")
        .filter({ hasText: /Kit: load kit|kit_load_kit/ })
        .first(),
    ).toBeVisible();
    await expect(readFile(path.join(workspace.path, "kit-proof.txt"))).rejects.toThrow();
    await selectSidePanel(page, "Files");
    await page.getByTestId("file-explorer").locator('[data-file-path="kit-proof.txt"]').click();
    await expect(page.getByTestId("file-editor")).toContainText("KIT_REMOTE_CONFIRMED");
    await selectSidePanel(page, "Review");
    await chooseReviewScope(page, "Last Turn");
    await expect(page.locator('.diff-panel__file[data-file-path="kit-proof.txt"]')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("kit-model-remote.png") });
    await page
      .getByTestId("composer")
      .fill(
        "Use kit_search_tools, kit_describe_tools and kit_call as needed to read the authenticated GitHub user profile. Read only; do not change anything or request broad permissions. If a connection or approval is required, stop, show the approval URL and finish with KIT_SERVICE_AUTH_REQUIRED. Do not include account details in your reply. Finish with exactly KIT_GITHUB_READ_CONFIRMED only if the authenticated GitHub call succeeded.",
      );
    await page.getByTestId("composer").press("Enter");
    await expect(answer).toContainText(/KIT_GITHUB_READ_CONFIRMED|KIT_SERVICE_AUTH_REQUIRED/, {
      timeout: 180_000,
    });
    await expect(page.getByTestId("send")).not.toHaveAttribute("aria-label", "Stop run", {
      timeout: 180_000,
    });
    const githubConnected = (await answer.innerText()).includes("KIT_GITHUB_READ_CONFIRMED");
    if (githubConnected) {
      await waitForTimelineLayout(page);
      const githubCall = page
        .locator(".timeline-tool")
        .filter({ has: page.locator(".timeline-tool__header").filter({ hasText: /Kit: call/ }) })
        .last();
      await githubCall.locator(".timeline-tool__header").click();
      await expect(githubCall.locator(".timeline-tool__pre")).toContainText('"login"');
      await githubCall.locator(".timeline-tool__header").click();
    } else {
      await expect(
        answer.getByRole("link", { name: /https:\/\/kit\.vercel\.sh\/approve/ }),
      ).toHaveAttribute("href", /^https:\/\/kit\.vercel\.sh\/approve/);
      await page.screenshot({ path: testInfo.outputPath("kit-service-connection-required.png") });
    }
    expect(await readFile(path.join(agentDir, "auth.json"), "utf8")).toBe("{}\n");
    await writeFile(
      testInfo.outputPath("proof.json"),
      JSON.stringify(
        {
          identity,
          provider: KIT_PROVIDER_ID,
          model: "anthropic/claude-haiku-4.5",
          passed: [
            restored ? "saved-Kit-reconnect" : "native-OAuth-PKCE",
            "Kit-service-tool",
            githubConnected
              ? "Kit-authenticated-GitHub-read"
              : "Kit-service-connection-required-link",
            "Kit-model",
            "remote-write-read",
            "Files",
            "Review",
            "no-local-checkout",
            "no-Pi-auth-credentials",
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
