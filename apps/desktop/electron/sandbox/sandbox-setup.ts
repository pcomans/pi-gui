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
          // The image's own apt jobs can hold the lock right after the sandbox starts.
          "apt-get -o DPkg::Lock::Timeout=300 update -qq",
          `apt-get -o DPkg::Lock::Timeout=300 install -y -qq ${config.packages.join(" ")}`,
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

/**
 * `node_modules` folders the sandbox keeps to itself: the checkout's own and one beside every
 * git-tracked `package.json`, so Linux installs never replace the host's native builds.
 * `trackedFiles` are paths relative to the checkout, as `git ls-files` prints them.
 */
export function nodeModulesDirs(checkoutPath: string, trackedFiles: readonly string[]): string[] {
  const dirs = trackedFiles
    .filter((file) => path.posix.basename(file) === "package.json")
    .map((file) => path.posix.dirname(file))
    .filter((dir) => !dir.split("/").includes("node_modules"));
  return [...new Set(["", ...dirs.filter((dir) => dir !== ".")])]
    .sort()
    .map((dir) => path.join(checkoutPath, dir, "node_modules"));
}

/**
 * Root script that bind-mounts a sandbox-local folder over each of `dirs` (which must exist).
 * Mounts end when the sandbox stops, so this runs on every start; mounted folders are skipped.
 */
export function nodeModulesMountScript(dirs: readonly string[]): string {
  return [
    "set -eu",
    ...dirs.map((dir) => {
      const own = `/var/lib/pi-gui/node_modules/${createHash("sha256").update(dir).digest("hex").slice(0, 16)}`;
      const target = shellQuote(dir);
      return `mountpoint -q ${target} || { mkdir -p ${own} && chown agent:agent ${own} && mount --bind ${own} ${target}; }`;
    }),
  ].join("\n");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
