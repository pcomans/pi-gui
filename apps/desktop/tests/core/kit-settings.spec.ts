import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { kitCallback, kitIssuer } from "../helpers/kit-issuer";
import { launchDesktop, makeUserDataDir, seedAgentDir } from "../helpers/electron-app";

test("Kit Settings requires secure storage, signs in, lists services and disconnects after restart", async ({}, testInfo) => {
  const issuer = await kitIssuer();
  const profile = await makeUserDataDir("pi-gui-kit-settings-");
  const agentDir = path.join(profile, "agent");
  await seedAgentDir(agentDir, { withOpenAiAuth: false, withDefaultModel: false });
  const launch = () =>
    launchDesktop(profile, {
      agentDir,
      scrubProviderEnv: true,
      envOverrides: { PI_GUI_KIT_URL: issuer.baseUrl },
    });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Kit", exact: true }).click();
    await expect(page.getByTestId("settings-surface")).toContainText("Missing in this POC");
    await expect(page.getByTestId("settings-surface")).toContainText(
      "Pi still runs on this computer",
    );
    await page.getByRole("button", { name: "Connect Kit", exact: true }).click();
    const secureStorage = await app.electronApp.evaluate(
      ({ safeStorage }) =>
        safeStorage.isEncryptionAvailable() &&
        (process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text"),
    );
    if (!secureStorage) {
      await expect(page.getByTestId("settings-surface")).toContainText(
        "Kit requires OS secure credential storage",
      );
      expect(issuer.requests).toHaveLength(0);
      return;
    }
    const authorization = await page
      .getByRole("link", { name: "Continue in browser" })
      .getAttribute("href");
    expect((await fetch(kitCallback(authorization!, "invalid-state"))).status).toBe(400);
    expect((await fetch(kitCallback(authorization!))).status).toBe(200);
    await expect(page.getByTestId("settings-surface")).toContainText("kit-fixture@example.test");
    await page.getByRole("button", { name: "Refresh Kit", exact: true }).click();
    await expect(page.getByTestId("settings-surface")).toContainText("GitHub");
    await page.screenshot({ path: testInfo.outputPath("kit-settings.png") });
    expect((await readFile(path.join(profile, "kit", "account.enc"))).toString()).not.toContain(
      "fixture-access-token",
    );
    expect(await readFile(path.join(agentDir, "auth.json"), "utf8")).toBe("{}\n");
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await expect(page.getByTestId("settings-surface")).toBeVisible();
    await page.getByRole("button", { name: "Kit", exact: true }).click();
    await page.getByRole("button", { name: "Refresh Kit", exact: true }).click();
    await expect(page.getByTestId("settings-surface")).toContainText("kit-fixture@example.test");
    await page.getByRole("button", { name: "Disconnect locally", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Disconnect locally", exact: true }),
    ).toBeDisabled();
    await expect(page.getByTestId("settings-surface")).not.toContainText(
      "kit-fixture@example.test",
    );
  } finally {
    await app.close();
    await issuer.close();
  }
});
