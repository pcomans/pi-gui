import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { SandboxImageState } from "../../contracts/sandbox";
import type { GondolinModule, GondolinVm } from "./sandbox-gondolin";

/** pnpm switches to a repository's pinned `packageManager` version on its own. */
const PNPM_VERSION = "12.10.1";

/**
 * Commands that turn Gondolin's minimal Alpine image into the base toolchain every sandbox
 * starts from. Changing them changes the image hash, so the next sandbox rebuilds it.
 */
export const BASE_IMAGE_SETUP = [
  "set -eu",
  "apk add --no-cache bash coreutils curl file findutils git github-cli grep gzip less openssh-client procps ripgrep sed tar xz",
  `npm install -g pnpm@${PNPM_VERSION}`,
  "git config --system safe.directory '*'",
  "git config --system init.defaultBranch main",
  // HTTPS git to GitHub authenticates with the placeholder the host swaps for the real token.
  `git config --system credential.https://github.com.helper '!f() { test "$1" = get && printf "username=x-access-token\\npassword=%s\\n" "$GITHUB_TOKEN"; }; f'`,
].join("\n");

/** Root disk size; the image file grows only as it is used. */
const ROOT_DISK_SIZE = "16G";
const BUILD_TIMEOUT_MS = 15 * 60_000;
const PACKAGE_NAME = /^[a-z0-9][a-z0-9+._-]*$/;

/** `.pi/sandbox.json`: what a project adds to the base toolchain. */
export interface ProjectSandboxConfig {
  /** Alpine packages, e.g. `python3`. */
  readonly packages: readonly string[];
  /** Shell commands run once as root while the image is built, without the project mounted. */
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
    throw new Error(".pi/sandbox.json: packages must be a list of Alpine package names");
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

function projectSetupScript(config: ProjectSandboxConfig): string {
  return [
    "set -eu",
    ...(config.packages.length > 0 ? [`apk add --no-cache ${config.packages.join(" ")}`] : []),
    ...(config.setup ? [config.setup] : []),
  ].join("\n");
}

function hashOf(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 16);
}

interface ImageBuild {
  readonly promise: Promise<string>;
  state: SandboxImageState;
  error?: string;
}

/**
 * Builds and caches VM checkpoints: the base toolchain, and one image per distinct
 * `.pi/sandbox.json`. Builds run once per recipe; sandboxes resume from the result in
 * milliseconds.
 */
export class SandboxImages {
  private readonly builds = new Map<string, ImageBuild>();
  private readonly baseName = `base-${hashOf(BASE_IMAGE_SETUP, ROOT_DISK_SIZE)}`;

  constructor(
    private readonly directory: string,
    private readonly gondolin: () => Promise<GondolinModule>,
    private readonly onChange: () => void,
  ) {}

  baseState(): { readonly state: SandboxImageState; readonly error?: string } {
    const build = this.builds.get(this.baseName);
    if (build) return { state: build.state, ...(build.error ? { error: build.error } : {}) };
    return { state: existsSync(this.imagePath(this.baseName)) ? "ready" : "missing" };
  }

  /** Path of the checkpoint a workspace's sandbox resumes from, building it if needed. */
  async imageFor(config: ProjectSandboxConfig | undefined): Promise<string> {
    const base = await this.ensure(this.baseName, undefined, BASE_IMAGE_SETUP);
    if (!config) return base;
    const script = projectSetupScript(config);
    return this.ensure(this.projectName(script), base, script);
  }

  /** Whether `imageFor(config)` will have to build an image first. */
  needsBuild(config: ProjectSandboxConfig | undefined): boolean {
    const names = [
      this.baseName,
      ...(config ? [this.projectName(projectSetupScript(config))] : []),
    ];
    return names.some(
      (name) => this.builds.get(name)?.state !== "ready" && !existsSync(this.imagePath(name)),
    );
  }

  private projectName(script: string): string {
    return `project-${hashOf(this.baseName, script)}`;
  }

  /** Forget a failed build so the next request tries again. */
  retry(): void {
    for (const [name, build] of this.builds) {
      if (build.state === "failed") this.builds.delete(name);
    }
    this.onChange();
  }

  private imagePath(name: string): string {
    return path.join(this.directory, `${name}.qcow2`);
  }

  private ensure(name: string, from: string | undefined, script: string): Promise<string> {
    const existing = this.builds.get(name);
    if (existing) return existing.promise;
    const target = this.imagePath(name);
    if (existsSync(target)) {
      const ready: ImageBuild = { promise: Promise.resolve(target), state: "ready" };
      this.builds.set(name, ready);
      return ready.promise;
    }
    const build: ImageBuild = {
      state: "building",
      promise: this.build(target, from, script).then(
        (result) => {
          build.state = "ready";
          this.onChange();
          return result;
        },
        (error: unknown) => {
          build.state = "failed";
          build.error = error instanceof Error ? error.message : String(error);
          this.onChange();
          throw error;
        },
      ),
    };
    this.builds.set(name, build);
    this.onChange();
    return build.promise;
  }

  private async build(target: string, from: string | undefined, script: string): Promise<string> {
    const { VM, VmCheckpoint } = await this.gondolin();
    await mkdir(this.directory, { recursive: true });
    const options = {
      sessionLabel: "pi-gui sandbox image build",
      rootfs: { mode: "cow" as const, size: ROOT_DISK_SIZE },
      // See SandboxSession: resuming from Gondolin's idle pause fails on macOS.
      sandbox: { qemuIdlePauseMs: 0 },
    };
    const vm: GondolinVm = from
      ? await VmCheckpoint.load(from).resume<GondolinVm>(options)
      : await VM.create(options);
    // A checkpoint records its file name, so it is written under the final name and moved in.
    const partialDir = path.join(
      this.directory,
      `.building-${process.pid}-${path.basename(target)}`,
    );
    const partial = path.join(partialDir, path.basename(target));
    await mkdir(partialDir, { recursive: true });
    try {
      const result = await vm.exec(["/bin/sh", "-c", script], {
        signal: AbortSignal.timeout(BUILD_TIMEOUT_MS),
      });
      if (result.exitCode !== 0) {
        const output = `${result.stdout}\n${result.stderr}`
          .trim()
          .split("\n")
          .slice(-12)
          .join("\n");
        throw new Error(`Sandbox image setup failed (exit ${result.exitCode}):\n${output}`);
      }
      await vm.checkpoint(partial);
    } catch (error) {
      await vm.close().catch(() => undefined);
      await rm(partialDir, { recursive: true, force: true });
      throw error;
    }
    await rename(partial, target);
    await rm(partialDir, { recursive: true, force: true });
    return target;
  }
}
