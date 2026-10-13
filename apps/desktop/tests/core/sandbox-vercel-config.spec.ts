import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { scriptedProviderExtension } from "../helpers/sandbox-scripted-provider";
import {
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  seedAgentDir,
  startThreadFromSurface,
  waitForTimelineLayout,
} from "../helpers/electron-app";

test("repository URL onboarding creates metadata only and missing cloud configuration never runs bash locally", async ({}, testInfo) => {
  const profile = await makeUserDataDir("pi-gui-remote-config-");
  const agentDir = path.join(profile, "agent");
  await seedAgentDir(agentDir, { withOpenAiAuth: false, withDefaultModel: false });
  await writeFile(
    path.join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: "sandbox-e2e",
      defaultModel: "scripted",
      enabledModels: ["sandbox-e2e/scripted"],
      packages: [],
    }),
  );
  await mkdir(path.join(agentDir, "extensions"));
  await writeFile(
    path.join(agentDir, "extensions", "sandbox-e2e.ts"),
    scriptedProviderExtension({
      attempt: { name: "bash", arguments: { command: "printf HOST_FALLBACK > forbidden.txt" } },
    }),
  );
  const app = await launchDesktop(profile, {
    agentDir,
    scrubProviderEnv: true,
    envOverrides: {
      VERCEL_TEAM_ID: undefined,
      VERCEL_PROJECT_ID: undefined,
      VERCEL_TOKEN: undefined,
    },
  });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Open repository", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Open repository" });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Repository URL").fill("https://token@github.com/octocat/Hello-World");
    await dialog.getByRole("button", { name: "Open repository", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("without credentials");
    await dialog.getByLabel("Repository URL").fill("https://github.com/octocat/Hello-World");
    await dialog.getByRole("button", { name: "Open repository", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId("new-thread-composer")).toBeVisible();
    await expect(page.getByRole("button", { name: "Local", exact: true })).toHaveCount(0);
    const workspace = (await getDesktopState(page)).workspaces[0]!;
    expect(workspace.repositoryUrl).toBe("https://github.com/octocat/Hello-World");
    await expect(readFile(path.join(workspace.path, "README"))).rejects.toThrow();
    await startThreadFromSurface(page, { prompt: "run attempt" });
    const reply = page.locator(".timeline-item--assistant .message__content").last();
    await expect(reply).toContainText("DONE attempt isError=true");
    await expect(reply).toContainText("Set VERCEL_TEAM_ID and VERCEL_PROJECT_ID");
    await expect(readFile(path.join(workspace.path, "forbidden.txt"))).rejects.toThrow();
    const originalSessionId = (await getDesktopState(page)).selectedSessionId;
    await waitForTimelineLayout(page);
    const answer = page
      .locator(".timeline-item--assistant")
      .filter({ hasText: "DONE attempt" })
      .last();
    await answer.hover();
    await answer.getByTestId("fork-from-message").click();
    await page.getByTestId("fork-modal-confirm").click();
    await expect(page.getByTestId("fork-modal-error")).toContainText("Set VERCEL_TEAM_ID");
    expect((await getDesktopState(page)).selectedSessionId).toBe(originalSessionId);
    await page.getByRole("button", { name: "Close fork modal", exact: true }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.getByTestId("settings-surface");
    await settings
      .getByRole("navigation", { name: "Settings sections" })
      .getByRole("button", { name: "Sandbox", exact: true })
      .click();
    await expect(settings).toContainText("Setup required");
    await expect(settings.getByRole("switch", { name: "Run tools in a sandbox" })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("remote-configuration.png") });
  } finally {
    await app.close();
  }
});
