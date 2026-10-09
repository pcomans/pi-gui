import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

/** pnpm switches to a repository's pinned `packageManager` version on its own. */
const PNPM_VERSION = "12.10.1";
const PACKAGE_NAME = /^[a-z0-9][a-z0-9+._-]*$/;

/** `.pi/sandbox.json`: what a project adds to the sandbox image. */
export interface ProjectSandboxConfig {
  /** Ubuntu packages, e.g. `build-essential`. */
  readonly packages: readonly string[];
  /** Shell commands run once as root when the thread's sandbox is created. */
  readonly setup?: string;
}

export function parseProjectSandboxConfig(source: string): ProjectSandboxConfig {
  const value: unknown = JSON.parse(source);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(".pi/sandbox.json must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "packages" && key !== "setup" && key !== "$schema") {
      throw new Error(`.pi/sandbox.json: unsupported field "${key}"`);
    }
  }
  const packages = record.packages ?? [];
  if (
    !Array.isArray(packages) ||
    !packages.every((name) => typeof name === "string" && PACKAGE_NAME.test(name))
  ) {
    throw new Error(".pi/sandbox.json: packages must be a list of Ubuntu package names");
  }
  const setup = record.setup;
  const setupScript = Array.isArray(setup)
    ? setup.every((line) => typeof line === "string")
      ? setup.join("\n")
      : undefined
    : setup;
  if (setupScript !== undefined && typeof setupScript !== "string") {
    throw new Error(".pi/sandbox.json: setup must be a string or a list of strings");
  }
  return { packages, ...(setupScript?.trim() ? { setup: setupScript } : {}) };
}

export async function readProjectSandboxConfig(
  workspacePath: string,
): Promise<ProjectSandboxConfig | undefined> {
  let source: string;
  try {
    source = await readFile(path.join(workspacePath, ".pi", "sandbox.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return parseProjectSandboxConfig(source);
}

/**
 * Root script that prepares a new sandbox: pnpm, git settings, then the project's packages and
 * setup. A marker per script makes it run once per sandbox, even if the thread reconnects.
 */
export function sandboxSetupScript(config: ProjectSandboxConfig | undefined): string {
  const body = [
    `npm install --global --prefix /usr/local --silent pnpm@${PNPM_VERSION}`,
    // The checkout is the person's; git in the sandbox must not refuse it as foreign.
    "git config --system --add safe.directory '*'",
    // Other worktrees' checkouts are not mounted; never prune them as missing.
    "git config --system gc.worktreePruneExpire never",
    ...(config && config.packages.length > 0
      ? [
          "export DEBIAN_FRONTEND=noninteractive",
          "apt-get update -qq",
          `apt-get install -y -qq ${config.packages.join(" ")}`,
        ]
      : []),
    ...(config?.setup ? [config.setup] : []),
  ].join("\n");
  const marker = `/var/lib/pi-gui/setup-${createHash("sha256").update(body).digest("hex").slice(0, 16)}`;
  return [
    "set -eu",
    `[ -f ${marker} ] && exit 0`,
    body,
    `mkdir -p /var/lib/pi-gui`,
    `touch ${marker}`,
  ].join("\n");
}
