import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
/** Every sandbox pi-gui creates is named with this prefix; pi-gui never touches others. */
export const SANDBOX_NAME_PREFIX = "pi-gui-";

async function run(
  file: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly timeoutMs?: number; readonly input?: string } = {},
): Promise<string> {
  const child = execFileAsync(file, args, {
    timeout: options.timeoutMs ?? 30_000,
    maxBuffer: 16 * 1024 * 1024,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (options.input !== undefined) {
    child.child.stdin?.end(options.input);
  }
  const { stdout } = await child;
  return stdout.trim();
}

export function sandboxPlatformSupported(): boolean {
  return process.platform === "darwin" || process.platform === "linux";
}

export function sbxInstallHint(): string {
  return process.platform === "darwin"
    ? "brew install --cask docker/tap/sbx, then sbx login"
    : "install Docker Sandboxes (https://docs.docker.com/ai/sandboxes/), then sbx login";
}

/** Absolute path of the `sbx` CLI, or undefined when it is not installed. */
export async function findSbx(): Promise<string | undefined> {
  return (await run("/bin/sh", ["-c", "command -v sbx"]).catch(() => "")) || undefined;
}

export type SbxStatus =
  | { readonly state: "missing" }
  | { readonly state: "signed-out"; readonly message: string }
  | { readonly state: "unavailable"; readonly message: string }
  | { readonly state: "ready"; readonly binary: string };

export interface SbxSandbox {
  readonly name: string;
  readonly status: string;
  readonly workspaces: readonly string[];
}

/** Whether sbx is installed, signed in and its daemon answers. */
export async function sbxStatus(): Promise<SbxStatus> {
  const binary = await findSbx();
  if (!binary) return { state: "missing" };
  try {
    await run(binary, ["ls", "--json"], { timeoutMs: 60_000 });
    return { state: "ready", binary };
  } catch (error) {
    const message = errorText(error);
    return /authenticat|sbx login/i.test(message)
      ? { state: "signed-out", message: "Docker Sandboxes is not signed in. Run: sbx login" }
      : { state: "unavailable", message };
  }
}

export async function listSandboxes(sbx: string): Promise<SbxSandbox[]> {
  const parsed = JSON.parse(await run(sbx, ["ls", "--json"], { timeoutMs: 60_000 })) as {
    sandboxes?: { name: string; status: string; workspaces?: string[] }[];
  };
  return (parsed.sandboxes ?? []).map(({ name, status, workspaces }) => ({
    name,
    status,
    workspaces: workspaces ?? [],
  }));
}

/** `paths` are mount arguments: absolute paths, `:ro` for read-only ones. */
export async function createSandbox(
  sbx: string,
  name: string,
  paths: readonly string[],
): Promise<void> {
  await run(sbx, ["create", "--name", name, "--quiet", "shell", ...paths], {
    timeoutMs: 15 * 60_000,
  });
}

export async function stopSandbox(sbx: string, name: string): Promise<void> {
  await run(sbx, ["stop", name], { timeoutMs: 120_000 });
}

/** Only for sandboxes named with {@link SANDBOX_NAME_PREFIX}. */
export async function removeSandbox(sbx: string, name: string): Promise<void> {
  if (!name.startsWith(SANDBOX_NAME_PREFIX)) throw new Error(`Not a pi-gui sandbox: ${name}`);
  await run(sbx, ["rm", "--force", name], { timeoutMs: 180_000 });
}

/** Run a setup script as root, outside the worker (before it starts). */
export async function runAsRoot(sbx: string, name: string, script: string): Promise<string> {
  try {
    return await run(sbx, ["exec", "-u", "root", name, "bash", "-c", script], {
      timeoutMs: 20 * 60_000,
    });
  } catch (error) {
    // execFile's message repeats the whole script; the output's end says what went wrong.
    const record = error as { stdout?: string; stderr?: string };
    const output = `${record.stdout ?? ""}\n${record.stderr ?? ""}`.trim().split("\n").slice(-8);
    throw new Error(`Sandbox setup failed:\n${output.join("\n") || errorText(error)}`);
  }
}

export interface SandboxNetworkRule {
  readonly id: string;
  readonly decision: "allow" | "deny";
  readonly resources: readonly string[];
}

interface PolicyRuleJson {
  readonly id: string;
  readonly applies_to?: string;
  readonly resource_type?: string;
  readonly decision?: string;
  readonly resources?: readonly string[];
}

async function policyRules(sbx: string): Promise<PolicyRuleJson[]> {
  const parsed = JSON.parse(await run(sbx, ["policy", "ls", "--json"])) as {
    rules?: PolicyRuleJson[];
  };
  return parsed.rules ?? [];
}

/** Network rules scoped to one sandbox. */
export async function sandboxNetworkRules(
  sbx: string,
  name: string,
): Promise<SandboxNetworkRule[]> {
  return (await policyRules(sbx))
    .filter(
      (rule) =>
        rule.applies_to === `sandbox:${name}` &&
        rule.resource_type === "network" &&
        (rule.decision === "allow" || rule.decision === "deny"),
    )
    .map((rule) => ({
      id: rule.id,
      decision: rule.decision as "allow" | "deny",
      resources: rule.resources ?? [],
    }));
}

export async function addNetworkRule(
  sbx: string,
  name: string,
  decision: "allow" | "deny",
  resource: string,
): Promise<void> {
  await run(sbx, ["policy", decision, "network", "--sandbox", name, resource]);
}

export async function removeNetworkRule(sbx: string, name: string, id: string): Promise<void> {
  await run(sbx, ["policy", "rm", "network", "--force", "--sandbox", name, "--id", id]);
}

export interface SandboxPolicyLogEntry {
  readonly sandbox: string;
  readonly host: string;
  readonly allowed: boolean;
  readonly count: number;
  readonly lastSeenAt: string;
}

interface PolicyLogHostJson {
  readonly host: string;
  readonly vm_name?: string;
  readonly last_seen?: string;
  readonly count_since?: number;
}

/** Hosts sbx's proxy allowed or blocked, per sandbox, with cumulative counts. */
export async function policyLog(sbx: string): Promise<SandboxPolicyLogEntry[]> {
  const parsed = JSON.parse(await run(sbx, ["policy", "log", "--json"])) as {
    allowed_hosts?: PolicyLogHostJson[] | null;
    blocked_hosts?: PolicyLogHostJson[] | null;
  };
  const entries = (rows: PolicyLogHostJson[] | null | undefined, allowed: boolean) =>
    (rows ?? [])
      .filter((row) => row.vm_name?.startsWith(SANDBOX_NAME_PREFIX))
      .map((row) => ({
        sandbox: row.vm_name!,
        // sbx reports host:port; the rules and the log are by host name.
        host: row.host
          .replace(/:\d+$/, "")
          .replace(/^\[(.*)\]$/, "$1")
          .toLowerCase(),
        allowed,
        count: row.count_since ?? 1,
        lastSeenAt: row.last_seen
          ? new Date(row.last_seen).toISOString()
          : new Date().toISOString(),
      }));
  return [...entries(parsed.allowed_hosts, true), ...entries(parsed.blocked_hosts, false)];
}

/** Sandbox name for a thread and the mounts it was created with. */
export function sandboxName(threadKey: string, mounts: readonly string[]): string {
  const hash = (value: string, length: number) =>
    createHash("sha256").update(value).digest("hex").slice(0, length);
  return `${SANDBOX_NAME_PREFIX}${hash(threadKey, 12)}-${hash(mounts.join("\0"), 6)}`;
}

export function threadPrefix(threadKey: string): string {
  return sandboxName(threadKey, []).replace(/-[0-9a-f]{6}$/, "-");
}

/** The repository a checkout belongs to: its main checkout, and the git directory to mount. */
export interface RepositoryIdentity {
  /** Main checkout (or the folder itself outside git); worktrees share it. */
  readonly repoPath: string;
  /** Shared git directory when it lies outside the checkout, as for linked worktrees. */
  readonly externalGitDir?: string;
  /**
   * `<git dir>/worktrees`, mounted read-only: the sandbox cannot see other worktrees' checkouts,
   * so git there would think them gone and `git worktree prune` would delete their metadata.
   */
  readonly worktreesDir?: string;
  /** This linked worktree's own admin folder inside it, which stays writable. */
  readonly ownAdminDir?: string;
}

export async function repositoryIdentity(checkoutPath: string): Promise<RepositoryIdentity> {
  const checkout = await realpath(checkoutPath);
  let commonDir: string;
  let gitDir: string;
  try {
    const [common, own] = (
      await run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir", "--git-dir"], {
        cwd: checkout,
      })
    ).split("\n");
    commonDir = await realpath(common!);
    gitDir = await realpath(own!);
  } catch {
    return { repoPath: checkout };
  }
  const repoPath = path.basename(commonDir) === ".git" ? path.dirname(commonDir) : commonDir;
  const insideCheckout = !path.relative(checkout, commonDir).startsWith("..");
  // Created up front (git would create it anyway) so the mount list, and with it the
  // thread's sandbox, stays the same as worktrees come and go.
  const worktreesDir = path.join(commonDir, "worktrees");
  await mkdir(worktreesDir, { recursive: true });
  return {
    repoPath,
    ...(insideCheckout ? {} : { externalGitDir: commonDir }),
    worktreesDir,
    ...(gitDir !== commonDir ? { ownAdminDir: gitDir } : {}),
  };
}

/** `package.json` files git tracks in a checkout, relative to it; none outside git. */
export async function trackedPackageFiles(checkoutPath: string): Promise<string[]> {
  const output = await run("git", ["ls-files", "-z", "--", "*package.json"], {
    cwd: checkoutPath,
  }).catch(() => "");
  return output.split("\0").filter(Boolean);
}

/** The person's git name and email, so commits made in the sandbox are theirs. */
export async function gitIdentityEnv(checkoutPath: string): Promise<Record<string, string>> {
  const read = (key: string) =>
    run("git", ["config", "--get", key], { cwd: checkoutPath }).catch(() => "");
  const [name, email] = await Promise.all([read("user.name"), read("user.email")]);
  return {
    ...(name ? { GIT_AUTHOR_NAME: name, GIT_COMMITTER_NAME: name } : {}),
    ...(email ? { GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_EMAIL: email } : {}),
  };
}

function errorText(error: unknown): string {
  const record = error as { stderr?: string; message?: string };
  return (record.stderr?.trim() || record.message || String(error)).slice(0, 500);
}
