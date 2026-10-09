import { existsSync } from "node:fs";
import { isIP } from "node:net";
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
} from "./sandbox-gondolin";
import { readProjectSandboxConfig, type ProjectSandboxConfig } from "./sandbox-images";

/** A VM nobody used for this long is stopped; the next tool call starts a fresh one. */
const IDLE_STOP_MS = 10 * 60_000;
const LIVENESS_CHECK_MS = 2_000;
const GITHUB_HOSTS = ["github.com", "api.github.com", "uploads.github.com", "codeload.github.com"];
/** Errors after which the VM cannot run anything more; the next call starts a new one. */
const BROKEN_VM_ERROR =
  /sandbox_stopped|sandbox exited|sandbox_resume_failed|queue_full|virtio bridge|vm is closed|disconnected/i;

export interface SandboxSessionRef {
  readonly workspaceId: string;
  readonly sessionId: string;
}

/** What a session needs from the app: images, network decisions and status reporting. */
export interface SandboxSessionHost {
  imageFor(config: ProjectSandboxConfig | undefined): Promise<string>;
  /** Whether the image for `config` still has to be built, which takes a while. */
  imageNeedsBuild(config: ProjectSandboxConfig | undefined): boolean;
  network: {
    check(repoPath: string, host: string): NetworkVerdict;
    explicitlyAllowed(repoPath: string, host: string): boolean;
    record(repoPath: string, host: string, allowed: boolean, ref: SandboxSessionRef): void;
  };
  /** Remember the repository so Settings can list its rules before any traffic. */
  noteRepository(repoPath: string): void;
  /** Track QEMU processes so a crash cannot leave them running forever. */
  vmStarted(pid: number): void;
  vmStopped(pid: number): void;
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
  private vmPid: number | undefined;
  private starting: Promise<GondolinVm> | undefined;
  private runningVmKey = "";
  private readonlyMounts: readonly string[] = [];
  private activeCalls = 0;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private repoPath: Promise<string> | undefined;

  constructor(
    readonly ref: SandboxSessionRef,
    readonly checkoutPath: string,
    private readonly host: SandboxSessionHost,
    private readonly onStatus: (state: SandboxSessionState, message?: string) => void,
  ) {}

  /** The main checkout whose network rules apply to this thread. */
  repository(): Promise<string> {
    this.repoPath ??= repositoryIdentity(this.checkoutPath).then(({ repoPath }) => {
      this.host.noteRepository(repoPath);
      return repoPath;
    });
    return this.repoPath;
  }

  /** Skill folders to expose read-only; a change restarts the VM before its next call. */
  setReadonlyMounts(paths: readonly string[]): void {
    this.readonlyMounts = [...new Set(paths)].filter(
      (entry) => path.isAbsolute(entry) && existsSync(entry) && !isWithin(this.checkoutPath, entry),
    );
  }

  /**
   * Run `work` with a ready VM. Throws instead of falling back to the host. A VM that dies or
   * breaks during the call is discarded; the call fails (it may have partly run and is never
   * repeated) and the next call starts a new VM.
   */
  async use<T>(work: (vm: GondolinVm) => Promise<T>): Promise<T> {
    if (this.closed) throw new Error("This thread's sandbox was closed. Send the message again.");
    this.activeCalls += 1;
    this.clearIdleTimer();
    try {
      const vm = await this.acquire();
      try {
        return await this.whileAlive(vm, work(vm));
      } catch (error) {
        if (vm === this.vm && (!this.isAlive(vm) || BROKEN_VM_ERROR.test(errorMessage(error)))) {
          await this.discard(vm, errorMessage(error));
          throw new Error(
            `The sandbox VM stopped while this ran, so it may have partly run: ${errorMessage(error)}. ` +
              "The next tool call starts a new sandbox.",
          );
        }
        throw error;
      }
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
    if (this.vm && !this.isAlive(this.vm)) {
      await this.discard(this.vm, "The sandbox VM exited.");
    }
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
    this.setStatus("starting", "Starting the sandbox…");
    try {
      // Read fresh each start: worktrees added since the last VM need protecting too.
      const identity = await repositoryIdentity(this.checkoutPath);
      const repoPath = await this.repository();
      const config = await readProjectSandboxConfig(this.checkoutPath);
      if (this.host.imageNeedsBuild(config)) {
        this.setStatus("starting", "Preparing the sandbox's Linux image (once, about a minute)…");
      }
      const image = await this.host.imageFor(config);
      const { VmCheckpoint, RealFSProvider, ReadonlyProvider, createHttpHooks } =
        await loadGondolin();
      const token = await hostGithubToken();
      const secretHosts = { hosts: GITHUB_HOSTS };
      const network = this.host.network;
      const { httpHooks, env } = createHttpHooks({
        ...(token
          ? {
              secrets: {
                GITHUB_TOKEN: { ...secretHosts, value: token },
                GH_TOKEN: { ...secretHosts, value: token },
              },
            }
          : {}),
        // pi-gui decides private addresses itself, so a host the person allowed can reach one.
        blockInternalRanges: false,
        isIpAllowed: ({ hostname, ip }) => {
          if (!isPrivateAddress(ip) || network.explicitlyAllowed(repoPath, hostname)) return true;
          network.record(repoPath, hostname, false, this.ref);
          this.host.changed();
          return false;
        },
        onRequest: (request) => {
          const hostname = new URL(request.url).hostname;
          const verdict = network.check(repoPath, hostname);
          if (verdict.allowed) return undefined;
          network.record(repoPath, hostname, false, this.ref);
          this.host.changed();
          return new Response(
            `Blocked by the pi-gui sandbox network policy: ${verdict.reason}. ` +
              "The user can allow it in Settings > Sandbox.\n",
            { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } },
          );
        },
        onResponse: (_response, request) => {
          network.record(repoPath, new URL(request.url).hostname, true, this.ref);
          this.host.changed();
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
      for (const adminDir of identity.otherWorktreeAdminDirs) {
        mounts[adminDir] = new ReadonlyProvider(new RealFSProvider(adminDir));
      }
      for (const mount of this.readonlyMounts) {
        mounts[mount] = new ReadonlyProvider(new RealFSProvider(mount));
      }
      const vm: GondolinVm = await VmCheckpoint.load(image).resume({
        sessionLabel: `pi-gui ${path.basename(this.checkoutPath)}`,
        // Gondolin pauses idle VMs on macOS after 30 s, and resuming them fails its clock
        // sync (0.13.0); this VM's own idle stop takes over instead.
        sandbox: { qemuIdlePauseMs: 0 },
        httpHooks,
        env: {
          ...env,
          ...(await gitIdentityEnv(this.checkoutPath)),
          HOME: "/root",
          // Gondolin's default PATH leaves out /usr/local/bin, where pnpm is installed.
          PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
          // git in the VM cannot see other worktrees' checkouts; never prune them as gone.
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "gc.worktreePruneExpire",
          GIT_CONFIG_VALUE_0: "never",
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
      const message = errorMessage(error);
      this.setStatus("failed", message);
      throw new Error(
        `The sandbox could not start, so the tool did not run (tools never fall back to the host): ${message}`,
      );
    }
  }

  private async discard(vm: GondolinVm, reason: string): Promise<void> {
    if (this.vm !== vm) return;
    this.vm = undefined;
    this.forgetPid();
    this.runningVmKey = "";
    this.setStatus(
      "failed",
      `${reason.replace(/\.?\s*$/, ".")} The next tool call starts a new sandbox.`,
    );
    await vm.close().catch(() => undefined);
  }

  private async stopVm(): Promise<void> {
    const starting = this.starting;
    const vm = this.vm ?? (starting ? await starting.catch(() => undefined) : undefined);
    this.vm = undefined;
    this.runningVmKey = "";
    await vm?.close().catch((error: unknown) => console.error("[sandbox] close", error));
    this.forgetPid();
  }

  /**
   * Gondolin spawns QEMU on a VM's first command. Once its process has existed, its absence
   * means the VM died; the pid is also recorded so a crashed app's VMs can be stopped later.
   */
  private isAlive(vm: GondolinVm): boolean {
    const pid = vm.getHostPid();
    if (pid === null) return this.vmPid === undefined;
    if (vm === this.vm && pid !== this.vmPid) {
      this.forgetPid();
      this.vmPid = pid;
      this.host.vmStarted(pid);
    }
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /** Gondolin's calls can hang when the VM process dies, so watch it while one runs. */
  private whileAlive<T>(vm: GondolinVm, work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setInterval> | undefined;
    const died = new Promise<never>((_resolve, reject) => {
      timer = setInterval(() => {
        if (!this.isAlive(vm)) reject(new Error("The sandbox VM exited."));
      }, LIVENESS_CHECK_MS);
    });
    return Promise.race([work, died]).finally(() => {
      clearInterval(timer);
      this.isAlive(vm);
    });
  }

  private forgetPid(): void {
    if (this.vmPid) this.host.vmStopped(this.vmPid);
    this.vmPid = undefined;
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

/** Loopback, private, link-local and carrier-grade NAT addresses, IPv4 or IPv6. */
export function isPrivateAddress(ip: string): boolean {
  const mapped = ip.toLowerCase().replace(/^::ffff:/, "");
  if (isIP(mapped) === 4) {
    const [a = 0, b = 0] = mapped.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  return mapped === "::1" || mapped === "::" || /^f[cd]/.test(mapped) || /^fe[89ab]/.test(mapped);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
