import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import {
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  startThreadFromSurface,
  waitForWorkspaceByPath,
  writeProjectExtension,
} from "../helpers/electron-app";
import { scriptedProviderExtension } from "../helpers/sandbox-scripted-provider";

const execFileAsync = promisify(execFile);

for (const blocked of [false, true]) {
  test(`Vercel sandbox fails closed with ${blocked ? "saved blocked hosts" : "missing project configuration"}`, async ({}, testInfo) => {
    const profile = await makeUserDataDir("pi-gui-vercel-config-");
    const agentDir = path.join(profile, "agent");
    const workspace = await makeWorkspace("vercel-config");
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
    await writeProjectExtension(
      workspace,
      "sandbox-e2e.ts",
      scriptedProviderExtension({
        attempt: { name: "bash", arguments: { command: "printf HOST_FALLBACK > forbidden.txt" } },
      }),
    );
    await execFileAsync("git", ["init", "-q", workspace]);
    if (blocked) {
      await mkdir(path.join(profile, "sandbox"));
      await writeFile(
        path.join(profile, "sandbox", "sandbox-settings.json"),
        JSON.stringify({
          version: 1,
          enabled: true,
          repos: {
            [await realpath(workspace)]: { allowedHosts: [], blockedHosts: ["example.com"] },
          },
        }),
      );
    }
    const app = await launchDesktop(profile, {
      agentDir,
      initialWorkspaces: [workspace],
      scrubProviderEnv: true,
      envOverrides: {
        PI_APP_SANDBOX: "1",
        PI_APP_SANDBOX_BACKEND: "vercel",
        VERCEL_TEAM_ID: blocked ? "team_fake" : undefined,
        VERCEL_PROJECT_ID: blocked ? "prj_fake" : undefined,
        // The blocked-host guard must reject before making any cloud request.
        VERCEL_TOKEN: "LOCAL_TEST_CANARY",
      },
    });
    try {
      const page = await app.firstWindow();
      await waitForWorkspaceByPath(page, workspace);
      await startThreadFromSurface(page, { prompt: "run attempt" });
      const reply = page.locator(".timeline-item--assistant .message__content").last();
      await expect(reply).toContainText("DONE attempt isError=true");
      await expect(reply).toContainText(
        blocked ? "cannot enforce these rules" : "Set VERCEL_TEAM_ID and VERCEL_PROJECT_ID",
      );
      await expect(readFile(path.join(workspace, "forbidden.txt"))).rejects.toThrow();
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      const settings = page.getByTestId("settings-surface");
      await settings
        .getByRole("navigation", { name: "Settings sections" })
        .getByRole("button", { name: "Sandbox", exact: true })
        .click();
      await expect(settings).toContainText("Vercel Sandbox (POC)");
      await expect(settings.getByRole("switch", { name: "Run tools in a sandbox" })).toBeChecked();
      await expect(settings.getByRole("button", { name: /Remove .* unused/ })).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath("vercel-settings.png") });
    } finally {
      await app.close();
    }
  });
}
