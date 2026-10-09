import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SandboxSessionState } from "../../contracts/sandbox";
import type { NetworkVerdict } from "./sandbox-settings-store";
import {
  gitIdentityEnv,
  hostGithubToken,
  loadGondolin,
  repositoryIdentity,
  type GondolinVm,
  type RepositoryIdentity,
} from "./sandbox-gondolin";
import { readProjectSandboxConfig, type ProjectSandboxConfig } from "./sandbox-images";

/** A VM nobody used for this long is stopped; the next tool call starts a fresh one. */
const IDLE_STOP_MS = 10 * 60_000;
const GITHUB_HOSTS = ["github.com", "api.github.com", "uploads.github.com", "codeload.github.com"];

export interface SandboxSessionRef {
  readonly workspaceId: string;
  readonly sessionId: string;
}

/** What a session needs from the app: images, network decisions and status reporting. */
export interface SandboxSessionHost {
  imageFor(config: ProjectSandboxConfig | undefined): Promise<string>;
  decide(repoPath: string, host: string, ref: SandboxSessionRef): NetworkVerdict;
  /** Remember the repository so Settings can list its rules before any traffic. */
  noteRepository(repoPath: string): void;
  changed(): void;
}

/**
 * The VM behind one pi session. It mounts the session's checkout at the same path it has on the
 * host (plus a linked worktree's shared git directory and read-only skill folders), so paths
 * and git metadata need no translation. Credentials stay on the host: the VM only sees
 * placeholders that Gondolin swaps in for allowed hosts.
 */
export class SandboxSession {
  state: SandboxSessionState = "idle";
  message: string | undefined;
  private vm: GondolinVm | undefined;
  private starting: Promise<GondolinVm> | undefined;
  private runningVmKey = "";
  private readonlyMounts: readonly string[] = [];
  private activeCalls = 0;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private identity: Promise<RepositoryIdentity> | undefined;

  constructor(
    readonly ref: SandboxSessionRef,
    readonly checkoutPath: string,
    private readonly host: SandboxSessionHost,
    private readonly onStatus: (state: SandboxSessionState, message?: string) => void,
  ) {}

  repository(): Promise<RepositoryIdentity> {
    this.identity ??= repositoryIdentity(this.checkoutPath).then((identity) => {
      this.host.noteRepository(identity.repoPath);
      return identity;
    });
    return this.identity;
  }

  /** Skill folders to expose read-only; a change restarts the VM before its next call. */
  setReadonlyMounts(paths: readonly string[]): void {
    this.readonlyMounts = [...new Set(paths)].filter(
      (entry) => path.isAbsolute(entry) && existsSync(entry) && !isWithin(this.checkoutPath, entry),
    );
  }

  /** Run `work` with a ready VM. Throws instead of falling back to the host. */
  async use<T>(work: (vm: GondolinVm) => Promise<T>): Promise<T> {
    if (this.closed) throw new Error("This thread's sandbox was closed. Send the message again.");
    this.activeCalls += 1;
    this.clearIdleTimer();
    try {
      return await work(await this.acquire());
    } finally {
      this.activeCalls -= 1;
      this.scheduleIdleStop();
    }
  }

  async restart(): Promise<void> {
    await this.stopVm();
    this.setStatus("idle", undefined);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.clearIdleTimer();
    await this.stopVm();
  }

  private async acquire(): Promise<GondolinVm> {
    const key = this.readonlyMounts.join("\0");
    if (this.vm && key !== this.runningVmKey && this.activeCalls === 1) {
      await this.stopVm();
    }
    if (this.vm) return this.vm;
    this.starting ??= this.start(key).finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async start(key: string): Promise<GondolinVm> {
    this.setStatus("starting", "Starting sandbox…");
    try {
      const identity = await this.repository();
      const config = await readProjectSandboxConfig(this.checkoutPath);
      const image = await this.host.imageFor(config);
      const { VmCheckpoint, RealFSProvider, ReadonlyProvider, createHttpHooks } =
        await loadGondolin();
      const token = await hostGithubToken();
      const secretHosts = { hosts: GITHUB_HOSTS };
      const { httpHooks, env } = createHttpHooks({
        ...(token
          ? {
              secrets: {
                GITHUB_TOKEN: { ...secretHosts, value: token },
                GH_TOKEN: { ...secretHosts, value: token },
              },
            }
          : {}),
        onRequest: (request) => {
          const hostname = new URL(request.url).hostname;
          const verdict = this.host.decide(identity.repoPath, hostname, this.ref);
          this.host.changed();
          if (verdict.allowed) return undefined;
          return new Response(
            `Blocked by the pi-gui sandbox network policy: ${verdict.reason}. ` +
              "The user can allow it in Settings > Sandbox.\n",
            { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } },
          );
        },
      });
      const mounts: Record<
        string,
        InstanceType<typeof RealFSProvider | typeof ReadonlyProvider>
      > = {
        [this.checkoutPath]: new RealFSProvider(this.checkoutPath),
      };
      if (identity.externalGitDir) {
        mounts[identity.externalGitDir] = new RealFSProvider(identity.externalGitDir);
      }
      for (const mount of this.readonlyMounts) {
        mounts[mount] = new ReadonlyProvider(new RealFSProvider(mount));
      }
      const vm: GondolinVm = await VmCheckpoint.load(image).resume({
        sessionLabel: `pi-gui ${path.basename(this.checkoutPath)}`,
        httpHooks,
        env: {
          ...env,
          ...(await gitIdentityEnv(this.checkoutPath)),
          HOME: "/root",
          // Gondolin's default PATH leaves out /usr/local/bin, where pnpm is installed.
          PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        },
        memory: "2G",
        cpus: Math.max(1, Math.min(4, Math.floor(os.cpus().length / 2))),
        vfs: { mounts },
      });
      if (this.closed) {
        await vm.close();
        throw new Error("This thread's sandbox was closed.");
      }
      this.vm = vm;
      this.runningVmKey = key;
      this.setStatus("ready", undefined);
      return vm;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus("failed", message);
      throw new Error(
        `The sandbox could not start, so the tool did not run (tools never fall back to the host): ${message}`,
      );
    }
  }

  private async stopVm(): Promise<void> {
    const starting = this.starting;
    const vm = this.vm ?? (starting ? await starting.catch(() => undefined) : undefined);
    this.vm = undefined;
    this.runningVmKey = "";
    await vm?.close().catch((error: unknown) => console.error("[sandbox] close", error));
  }

  private scheduleIdleStop(): void {
    if (this.activeCalls > 0 || this.closed) return;
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.activeCalls > 0) return;
      this.stopVm()
        .then(() => this.setStatus("idle", undefined))
        .catch((error: unknown) => console.error("[sandbox] idle stop", error));
    }, IDLE_STOP_MS);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private setStatus(state: SandboxSessionState, message: string | undefined): void {
    this.state = state;
    this.message = message;
    this.onStatus(state, message);
    this.host.changed();
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
