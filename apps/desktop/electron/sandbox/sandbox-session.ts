import { existsSync } from "node:fs";
import path from "node:path";
import type { SandboxSessionState } from "../../contracts/sandbox";
import {
  createSandbox,
  gitIdentityEnv,
  listSandboxes,
  removeSandbox,
  repositoryIdentity,
  runAsRoot,
  sandboxName,
  stopSandbox,
  threadPrefix,
} from "./sandbox-sbx";
import { readProjectSandboxConfig, sandboxSetupScript } from "./sandbox-setup";
import { SandboxWorker } from "./sandbox-worker";

/** A sandbox nobody used for this long is stopped; the next tool call starts it again. */
const IDLE_STOP_MS = 10 * 60_000;

export interface SandboxSessionRef {
  readonly workspaceId: string;
  readonly sessionId: string;
}

/** What a session needs from the app: the sbx CLI, network rules and status reporting. */
export interface SandboxSessionHost {
  /** Path of a ready sbx CLI; throws with what the person must do otherwise. */
  sbx(): Promise<string>;
  /** Make the sandbox's network rules match its repository's settings. */
  applyNetworkRules(sbx: string, sandbox: string, repoPath: string): Promise<void>;
  /** Remember which thread and repository a sandbox serves, for the host log. */
  noteSandbox(sandbox: string, repoPath: string, ref: SandboxSessionRef): void;
  changed(): void;
}

/** What a tool call gets: the worker, and environment its commands need. */
export interface SandboxConnection {
  readonly worker: SandboxWorker;
  readonly env: Readonly<Record<string, string>>;
}

/**
 * The Docker sandbox behind one pi session. It mounts the session's checkout at the same path it
 * has on the host (plus a linked worktree's shared git directory, and read-only other worktrees'
 * metadata and skill folders), so paths and git metadata need no translation. sbx keeps
 * credentials on the host and fills them in at its proxy.
 */
export class SandboxSession {
  state: SandboxSessionState = "idle";
  message: string | undefined;
  /** The sbx sandbox this thread uses now, once known. */
  sandbox: string | undefined;
  private connection: SandboxConnection | undefined;
  private starting: Promise<SandboxConnection> | undefined;
  private readonlyMounts: readonly string[] = [];
  private activeCalls = 0;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(
    readonly ref: SandboxSessionRef,
    readonly checkoutPath: string,
    private readonly host: SandboxSessionHost,
    private readonly onStatus: (state: SandboxSessionState, message?: string) => void,
  ) {}

  /** Skill folders to expose read-only; a change gives the thread a new sandbox. */
  setReadonlyMounts(paths: readonly string[]): void {
    this.readonlyMounts = [...new Set(paths)].filter(
      (entry) => path.isAbsolute(entry) && existsSync(entry) && !isWithin(this.checkoutPath, entry),
    );
  }

  /**
   * Run `work` with a connected sandbox. Throws instead of falling back to the host. If the
   * connection ends during the call, the call fails (it may have partly run and is never
   * repeated) and the next call reconnects.
   */
  async use<T>(work: (connection: SandboxConnection) => Promise<T>): Promise<T> {
    if (this.closed) throw new Error("This thread's sandbox was closed. Send the message again.");
    this.activeCalls += 1;
    this.clearIdleTimer();
    try {
      const connection = await this.acquire();
      try {
        return await work(connection);
      } catch (error) {
        if (connection.worker.isClosed) {
          throw new Error(
            `The sandbox connection ended while this ran, so it may have partly run: ${errorMessage(error)} ` +
              "The next tool call reconnects.",
          );
        }
        throw error;
      }
    } finally {
      this.activeCalls -= 1;
      this.scheduleIdleStop();
    }
  }

  /** Disconnect and stop the sandbox; the next call starts it again. */
  async stop(): Promise<void> {
    const sandbox = this.sandbox;
    await this.disconnect();
    if (sandbox) {
      const sbx = await this.host.sbx().catch(() => undefined);
      if (sbx) await stopSandbox(sbx, sandbox).catch(() => undefined);
    }
    this.setStatus("idle", undefined);
  }

  /** The thread closed (or the app quits): disconnect, and stop the sandbox if asked. */
  async close(stopSandboxToo: boolean): Promise<void> {
    this.closed = true;
    this.clearIdleTimer();
    if (stopSandboxToo) await this.stop();
    else await this.disconnect();
  }

  private async acquire(): Promise<SandboxConnection> {
    if (this.connection && !this.connection.worker.isClosed) return this.connection;
    this.starting ??= this.start().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async start(): Promise<SandboxConnection> {
    this.setStatus("starting", "Starting the sandbox…");
    try {
      const sbx = await this.host.sbx();
      // Read fresh each start: worktrees added since need protecting too.
      const identity = await repositoryIdentity(this.checkoutPath);
      const config = await readProjectSandboxConfig(this.checkoutPath);
      const mounts = [
        this.checkoutPath,
        ...(identity.externalGitDir ? [identity.externalGitDir] : []),
        ...identity.otherWorktreeAdminDirs.map((dir) => `${dir}:ro`),
        ...this.readonlyMounts.map((dir) => `${dir}:ro`),
      ];
      const threadKey = `${this.ref.workspaceId}\0${this.ref.sessionId}`;
      const name = sandboxName(threadKey, mounts);
      const existing = await listSandboxes(sbx);
      // A thread whose mounts changed gets a new sandbox; its old one goes.
      for (const stale of existing) {
        if (stale.name.startsWith(threadPrefix(threadKey)) && stale.name !== name) {
          await removeSandbox(sbx, stale.name).catch(() => undefined);
        }
      }
      if (!existing.some((sandbox) => sandbox.name === name)) {
        this.setStatus(
          "starting",
          existing.length === 0
            ? "Creating the sandbox (the first one downloads Docker's image, a minute or two)…"
            : "Creating the sandbox…",
        );
        await createSandbox(sbx, name, mounts);
      }
      this.sandbox = name;
      this.host.noteSandbox(name, identity.repoPath, this.ref);
      // Rules first, so nothing the project's setup or the agent runs escapes them.
      await this.host.applyNetworkRules(sbx, name, identity.repoPath);
      this.setStatus("starting", "Preparing the sandbox…");
      await runAsRoot(sbx, name, sandboxSetupScript(config));
      const worker = await SandboxWorker.start(sbx, name, this.checkoutPath);
      if (this.closed) {
        worker.close();
        throw new Error("This thread's sandbox was closed.");
      }
      const connection = { worker, env: await gitIdentityEnv(this.checkoutPath) };
      this.connection = connection;
      worker.closed
        .then((error) => {
          if (this.connection !== connection) return;
          this.connection = undefined;
          if (!this.closed) {
            this.setStatus("failed", `${error.message} The next tool call reconnects.`);
          }
        })
        .catch(() => undefined);
      this.setStatus("ready", undefined);
      return connection;
    } catch (error) {
      const message = errorMessage(error);
      this.setStatus("failed", message);
      throw new Error(
        `The sandbox could not start, so the tool did not run (tools never fall back to the host): ${message}`,
      );
    }
  }

  private async disconnect(): Promise<void> {
    const connection =
      this.connection ?? (this.starting ? await this.starting.catch(() => undefined) : undefined);
    this.connection = undefined;
    connection?.worker.close();
  }

  private scheduleIdleStop(): void {
    if (this.activeCalls > 0 || this.closed) return;
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.activeCalls > 0) return;
      this.stop().catch((error: unknown) => console.error("[sandbox] idle stop", error));
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
