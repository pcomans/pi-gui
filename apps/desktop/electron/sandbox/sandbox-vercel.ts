import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import type { WorkspaceRef } from "@pi-gui/session-driver";
import type { RemoteWorkbenchCalls } from "./remote-workbench";
import { homedir } from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { APIError, Sandbox } from "@vercel/sandbox";
import type { SandboxSessionState } from "../../contracts/sandbox";
import type { SandboxConnection, SandboxSessionRef, ToolSandboxSession } from "./sandbox-session";
import { SandboxWorker, WORKER_SOURCE } from "./sandbox-worker";

declare const __PI_GUI_REMOTE_WORKBENCH__: string;
export const REMOTE_CWD = "/vercel/sandbox";
export const VERCEL_SANDBOX_PROMPT = `Workspace: this thread owns a persistent Vercel Sandbox running Ubuntu Linux. The repository, Git history, dependencies, read/write/edit/bash tools and ! commands live exclusively in the sandbox at /vercel/sandbox. There is no local checkout and no file synchronization. The app's Files, Review and terminal use this same repository. Pi, conversation history, model connections, MCP and extension tools stay on the user's computer; their host paths are not repository paths. Host credentials and services are unavailable. Use rg, find and ls through bash. Git commits and branches stay in the sandbox; push or export deliberately. Stop kills command process groups. On an interrupted connection, report the uncertain outcome and never automatically repeat a command.`;

export async function vercelSandboxCredentials(): Promise<{
  token: string;
  teamId: string;
  projectId: string;
}> {
  const teamId = process.env.VERCEL_TEAM_ID;
  const projectId = process.env.VERCEL_PROJECT_ID;
  if (!teamId || !projectId)
    throw new Error(
      "Set VERCEL_TEAM_ID and VERCEL_PROJECT_ID before launching the Vercel Sandbox POC.",
    );
  let token = process.env.VERCEL_TOKEN;
  if (!token) {
    const config =
      process.platform === "darwin"
        ? path.join(homedir(), "Library", "Application Support", "com.vercel.cli", "auth.json")
        : path.join(
            process.env.XDG_DATA_HOME ?? path.join(homedir(), ".local", "share"),
            "com.vercel.cli",
            "auth.json",
          );
    const auth = JSON.parse(await readFile(config, "utf8").catch(() => "{}")) as {
      token?: unknown;
    };
    if (typeof auth.token === "string") token = auth.token;
  }
  if (!token)
    throw new Error(
      "Sign in with vercel login, or provide VERCEL_TOKEN through your secret manager, then relaunch.",
    );
  return { token, teamId, projectId };
}

async function remoteWorker(sandbox: Sandbox, ref: SandboxSessionRef): Promise<SandboxWorker> {
  const bundlePath = "/tmp/pi-gui-workbench.cjs";
  await sandbox.writeFiles([
    { path: bundlePath, content: Buffer.from(__PI_GUI_REMOTE_WORKBENCH__) },
  ]);
  const stdout = new PassThrough();
  const command = await sandbox.runCommand({
    cmd: "node",
    args: ["-r", bundlePath, "-e", WORKER_SOURCE],
    cwd: REMOTE_CWD,
    env: { PI_GUI_WORKSPACE_ID: ref.workspaceId, PI_GUI_SESSION_ID: ref.sessionId },
    stdin: true,
    detached: true,
    stdout,
  });
  const stdin = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      command.writeStdin(chunk).then(
        () => callback(),
        (error: unknown) => callback(new Error(String(error))),
      );
    },
    writev(chunks: { chunk: Buffer }[], callback) {
      command.writeStdin(Buffer.concat(chunks.map(({ chunk }) => chunk))).then(
        () => callback(),
        (error: unknown) => callback(new Error(String(error))),
      );
    },
    final(callback) {
      command.closeStdin().then(
        () => callback(),
        (error: unknown) => callback(new Error(String(error))),
      );
    },
  });
  let failed: (error: Error) => void = () => undefined;
  const streamFailure = new Promise<Error>((resolve) => {
    failed = resolve;
  });
  stdin.on("error", failed);
  stdout.on("error", failed);
  const closed = Promise.race([
    command.wait().then(
      (result) =>
        new Error(`Vercel worker ended (exit ${result.exitCode}); a tool may have partly run.`),
      (error: unknown) =>
        new Error(`Vercel connection ended; a tool may have partly run: ${String(error)}`),
    ),
    streamFailure,
  ]);
  return SandboxWorker.connect({
    stdin,
    stdout,
    closed,
    close: () => {
      stdin.end();
      command.kill("SIGTERM").catch((error: unknown) => failed(new Error(String(error))));
    },
  });
}

export class VercelSandboxSession implements ToolSandboxSession {
  readonly checkoutPath = REMOTE_CWD;
  state: SandboxSessionState = "idle";
  message: string | undefined;
  sandbox: string | undefined;
  private remote: Sandbox | undefined;
  private connection: SandboxConnection | undefined;
  private starting: Promise<SandboxConnection> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private activeCalls = 0;
  private terminalCount = 0;
  private stopping: Promise<void> | undefined;

  constructor(
    readonly ref: SandboxSessionRef,
    readonly workspace: WorkspaceRef,
    private readonly userDataDir: string,
    private readonly onStatus: (state: SandboxSessionState, message?: string) => void,
  ) {}

  async use<T>(work: (connection: SandboxConnection) => Promise<T>): Promise<T> {
    if (this.closed) throw new Error("This thread's sandbox was closed.");
    clearTimeout(this.idleTimer);
    this.activeCalls += 1;
    try {
      if (this.stopping) await this.stopping;
      if (
        this.remote?.expiresAt &&
        this.remote.expiresAt.getTime() - Date.now() < 120_000 &&
        this.activeCalls === 1 &&
        !this.terminalCount
      )
        await this.disconnect();
      if (!this.connection || this.connection.worker.isClosed) {
        this.starting ??= this.start().finally(() => {
          this.starting = undefined;
        });
        this.connection = await this.starting;
      }
      return await work(this.connection);
    } catch (error) {
      if (!this.connection || this.connection.worker.isClosed)
        this.setStatus("failed", String(error));
      throw error;
    } finally {
      this.activeCalls -= 1;
      this.scheduleIdleStop();
    }
  }

  retainTerminal(closed: Promise<unknown>): void {
    this.terminalCount += 1;
    clearTimeout(this.idleTimer);
    const release = () => {
      this.terminalCount -= 1;
      this.scheduleIdleStop();
    };
    void closed.then(release, release);
  }

  async call<K extends keyof RemoteWorkbenchCalls>(
    action: K,
    input: RemoteWorkbenchCalls[K]["input"],
    signal?: AbortSignal,
  ): Promise<RemoteWorkbenchCalls[K]["output"]> {
    // The peer is our bundled workbench. Inputs are validated at IPC and again at the guest owner.
    return (await this.use(({ worker }) =>
      worker.service(action, input, signal),
    )) as RemoteWorkbenchCalls[K]["output"];
  }

  private async identity() {
    const credentials = await vercelSandboxCredentials();
    const hash = createHash("sha256")
      .update(
        [this.userDataDir, credentials.projectId, this.ref.workspaceId, this.ref.sessionId].join(
          "\0",
        ),
      )
      .digest("hex")
      .slice(0, 24);
    const name = `pi-gui-remote-${hash}`;
    const stateDir = path.join(this.userDataDir, "sandbox", "vercel", hash);
    return { credentials, name, stateDir, marker: path.join(stateDir, "created.json") };
  }

  async forkFrom(source: VercelSandboxSession): Promise<void> {
    try {
      if (source.activeCalls)
        throw new Error("Wait for the source thread’s current operation before forking its files.");
      await source.use(async () => undefined);
      const previousSnapshot = source.remote?.currentSnapshotId;
      const sourceName = source.sandbox!;
      await source.stop();
      const identity = await this.identity();
      this.setStatus("starting", "Copying the source thread’s remote workspace…");
      await mkdir(identity.stateDir, { recursive: true });
      await writeFile(
        identity.marker,
        JSON.stringify({
          name: identity.name,
          repositoryUrl: this.workspace.repositoryUrl,
          sourceSandbox: sourceName,
        }),
      );
      const deadline = Date.now() + 60_000;
      while (true) {
        const saved = await Sandbox.get({ ...identity.credentials, name: sourceName });
        if (
          saved.status === "stopped" &&
          saved.currentSnapshotId &&
          saved.currentSnapshotId !== previousSnapshot
        )
          break;
        if (Date.now() >= deadline)
          throw new Error(
            "The source workspace snapshot is still pending. The source was retained; try forking again after it finishes.",
          );
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      this.remote = await Sandbox.fork({
        ...identity.credentials,
        name: identity.name,
        sourceSandbox: sourceName,
        persistent: true,
        timeout: 30 * 60_000,
        snapshotExpiration: 0,
      });
      this.sandbox = identity.name;
      this.setStatus("idle", undefined);
    } catch (error) {
      this.setStatus("failed", String(error));
      throw error;
    }
  }

  private async start(): Promise<SandboxConnection> {
    if (!this.workspace.repositoryUrl)
      throw new Error(
        "This is a saved local workspace. Its history is retained; open a repository URL to run tools remotely.",
      );
    const { credentials, name, stateDir, marker } = await this.identity();
    this.sandbox = name;
    const wasCreated = await readFile(marker, "utf8").then(
      () => true,
      (error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      },
    );
    this.setStatus("starting", "Starting remote workspace…");
    let worker: SandboxWorker | undefined;
    try {
      try {
        this.remote = await Sandbox.get({ ...credentials, name: this.sandbox, resume: true });
      } catch (error) {
        if (!(error instanceof APIError) || error.response.status !== 404) throw error;
        if (wasCreated)
          throw new Error(
            "The persistent sandbox is missing. Its metadata was retained; restore the remote workspace before continuing.",
          );
        this.remote = await Sandbox.create({
          ...credentials,
          name: this.sandbox,
          image: "vercel/sandbox/universal",
          source: { type: "git", url: this.workspace.repositoryUrl },
          persistent: true,
          timeout: 30 * 60_000,
          snapshotExpiration: 0,
          networkPolicy: "allow-all",
        });
        await mkdir(stateDir, { recursive: true });
        await writeFile(
          marker,
          JSON.stringify({ name: this.sandbox, repositoryUrl: this.workspace.repositoryUrl }),
        );
      }
      // Managed images choose their own initial cwd and clone into a repo-named child.
      // Move that remote checkout once into our stable tool cwd; no host files are involved.
      const prepare = await this.remote.runCommand({
        cmd: "node",
        args: ["-e", PREPARE_CHECKOUT, REMOTE_CWD],
      });
      if (prepare.exitCode !== 0)
        throw new Error(`Remote checkout could not open: ${(await prepare.stderr()).slice(-2000)}`);
      worker = await remoteWorker(this.remote, this.ref);
      const setupScript = await worker.service("setup", null);
      if (typeof setupScript !== "string") throw new Error("Invalid sandbox setup response.");
      const setup = await this.remote.runCommand({
        cmd: "bash",
        args: ["-c", setupScript],
        cwd: REMOTE_CWD,
        sudo: true,
      });
      if (setup.exitCode !== 0) {
        worker.close();
        throw new Error(`Remote workspace setup failed: ${(await setup.stderr()).slice(-2000)}`);
      }
      if (this.closed) {
        worker.close();
        throw new Error("This thread's sandbox was closed.");
      }
      this.setStatus("ready", undefined);
      return {
        worker,
        env: {
          GIT_AUTHOR_NAME: "pi-gui",
          GIT_AUTHOR_EMAIL: "pi-gui@localhost",
          GIT_COMMITTER_NAME: "pi-gui",
          GIT_COMMITTER_EMAIL: "pi-gui@localhost",
        },
      };
    } catch (error) {
      worker?.close();
      this.setStatus("failed", String(error));
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = this.stopNow().finally(() => {
      this.stopping = undefined;
    });
    return this.stopping;
  }

  private async stopNow(): Promise<void> {
    clearTimeout(this.idleTimer);
    this.connection?.worker.close();
    if (this.state === "starting" && this.remote) await this.remote.stop();
    if (this.starting) await this.starting.catch(() => undefined);
    await this.disconnect();
    this.setStatus("idle", undefined);
  }

  async close(stopSandboxToo: boolean): Promise<void> {
    this.closed = true;
    clearTimeout(this.idleTimer);
    if (stopSandboxToo) await this.stop();
    else this.connection?.worker.close();
  }

  private async disconnect(): Promise<void> {
    this.connection?.worker.close();
    this.connection = undefined;
    if (this.remote) await this.remote.stop();
    this.remote = undefined;
  }

  private scheduleIdleStop(): void {
    if (this.activeCalls || this.terminalCount || this.closed) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.stop().catch((error: unknown) => console.error("[remote workspace] idle stop", error));
    }, 10 * 60_000);
    this.idleTimer.unref?.();
  }

  private setStatus(state: SandboxSessionState, message: string | undefined): void {
    this.state = state;
    this.message = message;
    this.onStatus(state, message);
  }
}

const PREPARE_CHECKOUT = String.raw`
const fs = require("node:fs/promises");
const path = require("node:path");
(async () => {
  const destination = process.argv[1];
  if (await fs.access(path.join(destination, ".git")).then(() => true, () => false)) return;
  const root = process.cwd();
  const entries = await fs.readdir(root, { withFileTypes: true });
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const directory = path.join(root, entry.name);
    if (await fs.access(path.join(directory, ".git")).then(() => true, () => false)) candidates.push(directory);
  }
  if (candidates.length !== 1) throw new Error("Expected one cloned repository; existing files were retained.");
  await fs.rename(candidates[0], destination);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
`;
