import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";

/**
 * Runs inside the sandbox (`node -e`), started once per thread with `sbx exec -i`. It answers
 * JSON lines on stdin, so file operations and commands do not pay for a new `sbx exec` each.
 * Commands get their own process group, so a cancel kills everything they started.
 */
const WORKER_SOURCE = String.raw`
"use strict";
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const readline = require("node:readline");
const running = new Map();
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const failure = (id, error) => send({ id, error: { code: error.code || "", message: String(error.message || error) } });
readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  const { id, op } = request;
  try {
    if (op === "exec") {
      const child = spawn(request.argv[0], request.argv.slice(1), {
        cwd: request.cwd, env: { ...process.env, ...request.env }, detached: true, stdio: ["ignore", "pipe", "pipe"],
      });
      running.set(id, child);
      child.stdout.on("data", (data) => send({ id, out: data.toString("base64") }));
      child.stderr.on("data", (data) => send({ id, err: data.toString("base64") }));
      child.on("error", (error) => { running.delete(id); failure(id, error); });
      child.on("close", (code, signal) => { running.delete(id); send({ id, done: true, code, signal }); });
    } else if (op === "kill") {
      const child = running.get(request.target);
      if (child) { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
      send({ id, done: true });
    } else if (op === "read") {
      send({ id, done: true, data: (await fs.readFile(request.path)).toString("base64") });
    } else if (op === "write") {
      await fs.writeFile(request.path, Buffer.from(request.data, "base64"));
      send({ id, done: true });
    } else if (op === "mkdir") {
      await fs.mkdir(request.path, { recursive: true });
      send({ id, done: true });
    } else if (op === "access") {
      await fs.access(request.path, request.mode);
      send({ id, done: true });
    } else {
      failure(id, new Error("unknown op " + op));
    }
  } catch (error) {
    failure(id, error);
  }
});
process.stdin.on("end", () => {
  for (const child of running.values()) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
  process.exit(0);
});
send({ ready: true });
`;

interface WorkerReply {
  readonly id?: string;
  readonly ready?: boolean;
  readonly out?: string;
  readonly err?: string;
  readonly done?: boolean;
  readonly code?: number | null;
  readonly signal?: string | null;
  readonly data?: string;
  readonly error?: { readonly code: string; readonly message: string };
}

interface Pending {
  readonly onReply: (reply: WorkerReply) => void;
  readonly onClosed: (error: Error) => void;
}

export interface WorkerExecOptions {
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly onData?: (data: Buffer) => void;
  readonly signal?: AbortSignal;
}

/** An error the worker reported for a file operation, with the guest's errno code. */
export class SandboxFileError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

/** The host side of one worker connection; `closed` settles when it ends for any reason. */
export class SandboxWorker {
  readonly closed: Promise<Error>;
  private readonly ready: Promise<void>;
  private readonly pending = new Map<string, Pending>();
  private ended: Error | undefined;

  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.closed = new Promise((resolve) => {
      const end = (error: Error) => {
        if (this.ended) return;
        this.ended = error;
        for (const pending of this.pending.values()) pending.onClosed(error);
        this.pending.clear();
        resolve(error);
      };
      child.on("error", (error) => end(error));
      child.on("close", (code, signal) =>
        end(new Error(`The sandbox connection ended (${signal ?? `exit ${code}`}).`)),
      );
    });
    let markReady: () => void = () => undefined;
    this.ready = new Promise((resolve) => (markReady = resolve));
    createInterface({ input: child.stdout }).on("line", (line) => {
      let reply: WorkerReply;
      try {
        reply = JSON.parse(line) as WorkerReply;
      } catch {
        return;
      }
      if (reply.ready) markReady();
      if (reply.id) this.pending.get(reply.id)?.onReply(reply);
    });
  }

  /** Start a worker in `sandbox`; resolves once it reports ready. */
  static async start(
    sbx: string,
    sandbox: string,
    cwd: string,
    timeoutMs = 60_000,
  ): Promise<SandboxWorker> {
    const child = spawn(
      sbx,
      ["exec", "-i", "--workdir", cwd, sandbox, "node", "-e", WORKER_SOURCE],
      {
        // The worker must not hold the project directory open on the host.
        cwd: tmpdir(),
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const worker = new SandboxWorker(child);
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2_000);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      worker.ready.then(() => undefined),
      worker.closed.then((error) => new Error(`${error.message} ${stderr.trim()}`.trim())),
      new Promise<Error>((resolve) => {
        timer = setTimeout(
          () => resolve(new Error("The sandbox did not start in time.")),
          timeoutMs,
        );
      }),
    ]);
    clearTimeout(timer);
    if (outcome) {
      worker.close();
      throw outcome;
    }
    return worker;
  }

  get isClosed(): boolean {
    return this.ended !== undefined;
  }

  close(): void {
    this.child.stdin.end();
    this.child.kill();
  }

  async exec(
    argv: readonly string[],
    options: WorkerExecOptions,
  ): Promise<{ readonly exitCode: number | null }> {
    const id = randomUUID();
    const result = new Promise<{ readonly exitCode: number | null }>((resolve, reject) => {
      this.pending.set(id, {
        onClosed: reject,
        onReply: (reply) => {
          if (reply.out) options.onData?.(Buffer.from(reply.out, "base64"));
          if (reply.err) options.onData?.(Buffer.from(reply.err, "base64"));
          if (reply.error) {
            this.pending.delete(id);
            reject(new Error(reply.error.message));
          } else if (reply.done) {
            this.pending.delete(id);
            resolve({
              exitCode: reply.signal ? 128 + signalNumber(reply.signal) : (reply.code ?? null),
            });
          }
        },
      });
    });
    const abort = () => {
      void this.request({ op: "kill", target: id }).catch(() => undefined);
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    this.send({ id, op: "exec", argv, cwd: options.cwd, env: options.env ?? {} });
    try {
      return await result;
    } finally {
      options.signal?.removeEventListener("abort", abort);
    }
  }

  async readFile(path: string): Promise<Buffer> {
    const reply = await this.request({ op: "read", path });
    return Buffer.from(reply.data ?? "", "base64");
  }

  async writeFile(path: string, content: string | Buffer): Promise<void> {
    await this.request({ op: "write", path, data: Buffer.from(content).toString("base64") });
  }

  async mkdir(path: string): Promise<void> {
    await this.request({ op: "mkdir", path });
  }

  async access(path: string, mode?: number): Promise<void> {
    await this.request({ op: "access", path, ...(mode === undefined ? {} : { mode }) });
  }

  private request(message: Record<string, unknown>): Promise<WorkerReply> {
    const id = randomUUID();
    const reply = new Promise<WorkerReply>((resolve, reject) => {
      this.pending.set(id, {
        onClosed: reject,
        onReply: (next) => {
          this.pending.delete(id);
          if (next.error) reject(new SandboxFileError(next.error.message, next.error.code));
          else resolve(next);
        },
      });
    });
    this.send({ id, ...message });
    return reply;
  }

  private send(message: Record<string, unknown>): void {
    if (this.ended) {
      this.pending.get(String(message.id))?.onClosed(this.ended);
      return;
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
}

const SIGNALS: Readonly<Record<string, number>> = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 };

function signalNumber(signal: string): number {
  return SIGNALS[signal] ?? 1;
}
