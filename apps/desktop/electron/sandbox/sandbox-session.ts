import type { SandboxSessionState } from "../../contracts/sandbox";
import type { SandboxWorker } from "./sandbox-worker";

export interface SandboxSessionRef {
  readonly workspaceId: string;
  readonly sessionId: string;
}

/** What a tool call gets: the worker, and environment its commands need. */
export interface SandboxConnection {
  readonly worker: SandboxWorker;
  readonly env: Readonly<Record<string, string>>;
}

export interface ToolSandboxSession {
  readonly ref: SandboxSessionRef;
  readonly checkoutPath: string;
  readonly state: SandboxSessionState;
  readonly message: string | undefined;
  readonly sandbox: string | undefined;
  use<T>(work: (connection: SandboxConnection) => Promise<T>): Promise<T>;
  stop(): Promise<void>;
  close(stopSandboxToo: boolean): Promise<void>;
}
