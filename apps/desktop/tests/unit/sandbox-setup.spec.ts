import { expect, test } from "@playwright/test";
import {
  parseProjectSandboxConfig,
  sandboxSetupScript,
} from "../../electron/sandbox/sandbox-setup";

test("remote setup uses managed pnpm and runs project packages and commands once", () => {
  const script = sandboxSetupScript(
    parseProjectSandboxConfig(
      JSON.stringify({
        packages: ["build-essential"],
        setup: ["test -f README.md", "echo PROJECT_SETUP"],
      }),
    ),
  );
  expect(script).not.toContain("npm install --global");
  expect(script).toContain("install -y -qq build-essential");
  expect(script).toContain("test -f README.md\necho PROJECT_SETUP");
  expect(script).toContain("&& exit 0");
});

test("setup rejects package names that could inject shell commands", () => {
  for (const name of ["foo; touch bad", "$(whoami)", "-y", "foo bar"])
    expect(() => parseProjectSandboxConfig(JSON.stringify({ packages: [name] }))).toThrow();
});
