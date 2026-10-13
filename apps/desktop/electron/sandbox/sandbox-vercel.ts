import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { APIError, Sandbox } from "@vercel/sandbox";
import type { SandboxSessionState } from "../../contracts/sandbox";
import type { SandboxConnection, SandboxSessionRef, ToolSandboxSession } from "./sandbox-session";
import { gitIdentityEnv, repositoryIdentity } from "./sandbox-sbx";
import { readProjectSandboxConfig, sandboxSetupScript } from "./sandbox-setup";
import { localInventory, SandboxCheckoutSync } from "./sandbox-sync";
import { SandboxWorker, WORKER_SOURCE } from "./sandbox-worker";

export const VERCEL_SANDBOX_PROMPT = `Tool sandbox: read, write, edit, bash and ! commands run in this thread's persistent Vercel Sandbox (Ubuntu Linux). Pi, model connections, MCP and extension tools stay on the user's computer. The checkout is copied to the same absolute path; source changes synchronize before tool results return. Ignored files (including node_modules), host credentials and host services are unavailable. Install Linux dependencies in the sandbox. This POC has an independent Git repository initialized from the starting checkout: commits, branches and staging do not synchronize; the user commits locally. Skills outside the checkout are unavailable. Use rg, find and ls through bash. Stop kills command process groups. On an interrupted connection, report the uncertain outcome and never automatically repeat the command.`;

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

async function remoteWorker(sandbox: Sandbox, cwd: string): Promise<SandboxWorker> {
  const stdout = new PassThrough();
  const command = await sandbox.runCommand({
    cmd: "node",
    args: ["-e", WORKER_SOURCE],
    cwd,
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

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export class VercelSandboxSession implements ToolSandboxSession {
  state: SandboxSessionState = "idle";
  message: string | undefined;
  sandbox: string | undefined;
  private remote: Sandbox | undefined;
  private connection: SandboxConnection | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private activeCalls = 0;

  constructor(
    readonly ref: SandboxSessionRef,
    readonly checkoutPath: string,
    private readonly userDataDir: string,
    private readonly assertNetworkRules: (repoPath: string) => void,
    private readonly onStatus: (state: SandboxSessionState, message?: string) => void,
  ) {}

  // The POC deliberately does not upload the user's global skill directories.
  setReadonlyMounts(_paths: readonly string[]): void {}

  use<T>(work: (connection: SandboxConnection) => Promise<T>): Promise<T> {
    clearTimeout(this.idleTimer);
    this.activeCalls += 1;
    const operation = this.queue.then(async () => {
      if (this.closed) throw new Error("This thread's sandbox was closed.");
      const credentials = await vercelSandboxCredentials();
      const identity = await repositoryIdentity(this.checkoutPath);
      this.assertNetworkRules(identity.repoPath);
      const hash = createHash("sha256")
        .update(
          [
            this.userDataDir,
            this.checkoutPath,
            credentials.projectId,
            this.ref.workspaceId,
            this.ref.sessionId,
          ].join("\0"),
        )
        .digest("hex")
        .slice(0, 24);
      this.sandbox = `pi-gui-poc-${hash}`;
      const sync = new SandboxCheckoutSync(
        this.checkoutPath,
        path.join(this.userDataDir, "sandbox", "vercel", hash),
      );
      const restored = await sync.load();
      // Recycle between calls; never move or replay a running tool command.
      if (this.remote?.expiresAt && this.remote.expiresAt.getTime() - Date.now() < 120_000)
        await this.disconnect();
      if (!this.connection || this.connection.worker.isClosed) {
        this.setStatus("starting", "Starting Vercel Sandbox…");
        // Validate upload coverage before provisioning anything remotely.
        await localInventory(this.checkoutPath);
        const config = await readProjectSandboxConfig(this.checkoutPath);
        try {
          this.remote = await Sandbox.get({ ...credentials, name: this.sandbox, resume: true });
        } catch (error) {
          if (!(error instanceof APIError) || error.response.status !== 404) throw error;
          if (restored)
            throw new Error(
              "The persistent sandbox is missing. Local baseline was retained; recover the remote workspace before continuing.",
            );
          this.remote = await Sandbox.create({
            ...credentials,
            name: this.sandbox,
            image: "vercel/sandbox/universal",
            persistent: true,
            timeout: 30 * 60_000,
            snapshotExpiration: 0,
            networkPolicy: "allow-all",
          });
        }
        const remote = this.remote;
        if (!restored) {
          const identity = await remote.runCommand({
            cmd: "node",
            args: ["-e", "console.log(process.getuid() + ':' + process.getgid())"],
          });
          const owner = (await identity.stdout()).trim();
          if (identity.exitCode !== 0 || !/^\d+:\d+$/.test(owner))
            throw new Error("Could not identify the sandbox's default user.");
          const prepare = await remote.runCommand({
            cmd: "bash",
            args: [
              "-c",
              `mkdir -p ${quote(this.checkoutPath)} && chown ${owner} ${quote(this.checkoutPath)}`,
            ],
            sudo: true,
          });
          if (prepare.exitCode !== 0) throw new Error(await prepare.stderr());
          const init = await remote.runCommand({
            cmd: "git",
            args: ["init", "-q", this.checkoutPath],
          });
          if (init.exitCode !== 0) throw new Error(await init.stderr());
        }
        const worker = await remoteWorker(this.remote, this.checkoutPath);
        this.connection = { worker, env: await gitIdentityEnv(this.checkoutPath) };
        if (!restored) {
          await sync.seed(worker);
          const result = await worker.exec(
            [
              "bash",
              "-c",
              "git add -A && git -c user.name=pi-gui -c user.email=pi-gui@localhost commit -qm 'POC starting checkout' --allow-empty",
            ],
            { cwd: this.checkoutPath },
          );
          if (result.exitCode !== 0)
            throw new Error("Could not initialize the remote checkout baseline.");
        }
        const setup = await this.remote.runCommand({
          cmd: "bash",
          // The managed image already provides pnpm, which honors the repo's packageManager.
          args: ["-c", sandboxSetupScript(config, false)],
          cwd: this.checkoutPath,
          sudo: true,
        });
        if (setup.exitCode !== 0)
          throw new Error(`Vercel Sandbox setup failed: ${(await setup.stderr()).slice(-2000)}`);
      }
      await sync.reconcile(this.connection.worker);
      this.setStatus("ready", undefined);
      try {
        return await work(this.connection);
      } finally {
        // Includes bash writes and partial changes from a stopped command. Awaited before Pi settles.
        if (!this.connection.worker.isClosed) await sync.reconcile(this.connection.worker);
      }
    });
    this.queue = operation.catch((error: unknown) => {
      this.setStatus("failed", String(error));
    });
    this.queue
      .then(() => {
        this.activeCalls -= 1;
        if (this.activeCalls > 0 || this.closed) return;
        clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => {
          this.stop().catch((error: unknown) => console.error("[vercel sandbox] idle stop", error));
        }, 10 * 60_000);
        this.idleTimer.unref?.();
      })
      .catch(() => undefined);
    return operation;
  }

  async stop(): Promise<void> {
    clearTimeout(this.idleTimer);
    // Closing the worker kills active process groups before the queue drains.
    this.connection?.worker.close();
    // Setup can run outside the worker. Stop the VM to unblock it before draining.
    if (this.state === "starting" && this.remote) await this.remote.stop();
    await this.queue;
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

  private setStatus(state: SandboxSessionState, message: string | undefined): void {
    this.state = state;
    this.message = message;
    this.onStatus(state, message);
  }
}
