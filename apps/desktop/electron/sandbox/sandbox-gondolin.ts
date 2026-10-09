import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

export type GondolinModule = typeof import("@earendil-works/gondolin");
export type GondolinVm = InstanceType<GondolinModule["VM"]>;

let gondolin: Promise<GondolinModule> | undefined;

/** Loaded on first use, so platforms without sandbox support never load it. */
export function loadGondolin(): Promise<GondolinModule> {
  gondolin ??= import("@earendil-works/gondolin");
  return gondolin;
}

const execFileAsync = promisify(execFile);

async function run(file: string, args: readonly string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync(file, args, {
    timeout: 5_000,
    ...(cwd ? { cwd } : {}),
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout.trim();
}

export function sandboxPlatformSupported(): boolean {
  return process.platform === "darwin" || process.platform === "linux";
}

export function qemuBinaryName(): string {
  return process.arch === "arm64" ? "qemu-system-aarch64" : "qemu-system-x86_64";
}

export function qemuInstallHint(): string {
  return process.platform === "darwin"
    ? "brew install qemu"
    : process.arch === "arm64"
      ? "sudo apt install qemu-system-arm"
      : "sudo apt install qemu-system-x86";
}

export async function findQemu(): Promise<boolean> {
  try {
    await run("/bin/sh", ["-c", `command -v ${qemuBinaryName()}`]);
    return true;
  } catch {
    return false;
  }
}

/** The repository a checkout belongs to: its main checkout, and the git directory to mount. */
export interface RepositoryIdentity {
  /** Main checkout (or the folder itself outside git); worktrees share it. */
  readonly repoPath: string;
  /** Shared git directory when it lies outside the checkout, as for linked worktrees. */
  readonly externalGitDir?: string;
}

export async function repositoryIdentity(checkoutPath: string): Promise<RepositoryIdentity> {
  const checkout = await realpath(checkoutPath);
  let commonDir: string;
  try {
    commonDir = await realpath(
      await run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], checkout),
    );
  } catch {
    return { repoPath: checkout };
  }
  const repoPath = path.basename(commonDir) === ".git" ? path.dirname(commonDir) : commonDir;
  const insideCheckout = !path.relative(checkout, commonDir).startsWith("..");
  return { repoPath, ...(insideCheckout ? {} : { externalGitDir: commonDir }) };
}

/** The person's git name and email, so commits made in the sandbox are theirs. */
export async function gitIdentityEnv(checkoutPath: string): Promise<Record<string, string>> {
  const read = (key: string) => run("git", ["config", "--get", key], checkoutPath).catch(() => "");
  const [name, email] = await Promise.all([read("user.name"), read("user.email")]);
  return {
    ...(name ? { GIT_AUTHOR_NAME: name, GIT_COMMITTER_NAME: name } : {}),
    ...(email ? { GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_EMAIL: email } : {}),
  };
}

let cachedGithubToken: { readonly value: string | undefined; readonly at: number } | undefined;
const TOKEN_CACHE_MS = 5 * 60_000;

/** The host's `gh` token, or undefined when gh is missing or signed out. Never logged. */
export async function hostGithubToken(): Promise<string | undefined> {
  if (cachedGithubToken && Date.now() - cachedGithubToken.at < TOKEN_CACHE_MS) {
    return cachedGithubToken.value;
  }
  const value = await run("gh", ["auth", "token", "--hostname", "github.com"]).catch(
    () => undefined,
  );
  cachedGithubToken = { value: value || undefined, at: Date.now() };
  return cachedGithubToken.value;
}
