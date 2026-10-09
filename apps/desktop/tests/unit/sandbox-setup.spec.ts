import { expect, test } from "@playwright/test";
import { nodeModulesDirs, nodeModulesMountScript } from "../../electron/sandbox/sandbox-setup";

const checkout = "/Users/me/Library/Application Support/pi/worktrees/repo";

test("the sandbox keeps the checkout's node_modules and one per tracked package", () => {
  expect(
    nodeModulesDirs(checkout, [
      "package.json",
      "packages/b/package.json",
      "apps/my app/package.json",
      "apps/my app/package.json",
      "vendor/node_modules/dep/package.json",
      "docs/example-package.json",
    ]),
  ).toEqual([
    `${checkout}/node_modules`,
    `${checkout}/apps/my app/node_modules`,
    `${checkout}/packages/b/node_modules`,
  ]);
});

test("a checkout without tracked packages still keeps its own node_modules", () => {
  expect(nodeModulesDirs(checkout, [])).toEqual([`${checkout}/node_modules`]);
});

test("the mount script quotes paths and skips folders already mounted", () => {
  const dir = `${checkout}/it's/node_modules`;
  const script = nodeModulesMountScript([dir]);
  const quoted = `'${checkout}/it'\\''s/node_modules'`;
  expect(script.startsWith("set -eu\n")).toBe(true);
  expect(script).toMatch(
    new RegExp(
      `^mountpoint -q ${escape(quoted)} \\|\\| \\{ mkdir -p (/var/lib/pi-gui/node_modules/[0-9a-f]{16}) && chown agent:agent \\1 && mount --bind \\1 ${escape(quoted)}; \\}$`,
      "m",
    ),
  );
  // One sandbox folder per path, the same on every start.
  expect(nodeModulesMountScript([dir])).toBe(script);
  const own = (source: string) => source.match(/\/var\/lib\/pi-gui\/node_modules\/\w+/)?.[0];
  expect(own(nodeModulesMountScript([`${checkout}/node_modules`]))).not.toBe(own(script));
});

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
