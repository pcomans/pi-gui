/** Extension status key the sandbox reports under; the composer shows it instead of the dock. */
export const SANDBOX_STATUS_KEY = "pi-gui-sandbox";

/** Pi's tools the sandbox extension (electron/sandbox/sandbox-extension.ts) runs in the sandbox. */
const SANDBOXED_TOOL_NAMES: ReadonlySet<string> = new Set(["read", "write", "edit", "bash"]);

export type ToolRunLocation = "sandbox" | "host";

/** Whether a thread's sandbox status (under SANDBOX_STATUS_KEY) says its tools are sandboxed. */
export function isSandboxedStatus(status: string | undefined): boolean {
  return Boolean(status) && status !== "Sandbox: off";
}

/**
 * Where a tool call ran: in a sandboxed thread, pi's read, write, edit and bash run in the
 * sandbox and every other tool (MCP servers, extensions) on the host. Undefined when the thread
 * is not sandboxed, since everything then runs on the host and a label would only add noise.
 */
export function toolRunLocation(toolName: string, sandboxed: boolean): ToolRunLocation | undefined {
  if (!sandboxed) return undefined;
  return SANDBOXED_TOOL_NAMES.has(toolName) ? "sandbox" : "host";
}

/** The integrated terminal shares the selected thread's remote workspace. */
export function terminalSandboxNotice(
  sandboxed: boolean,
): { readonly label: string; readonly detail: string } | undefined {
  if (!sandboxed) return undefined;
  return {
    label: "Runs in this thread’s Vercel Sandbox",
    detail: "This terminal shares the remote repository with Pi’s tools and Review.",
  };
}

/** Vercel credentials and API availability. */
export type SandboxBackendState = "unavailable" | "ready";
export type SandboxSessionState = "starting" | "ready" | "idle" | "failed";

export interface SandboxSessionRecord {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly state: SandboxSessionState;
  readonly message?: string;
}

export interface SandboxSnapshot {
  /** Whether remote execution is supported on this platform. */
  readonly supported: boolean;
  readonly enabled: boolean;
  readonly backend: {
    readonly provider?: "vercel";
    readonly state: SandboxBackendState;
    readonly message?: string;
    readonly installHint: string;
  };
  /** Sandboxes used in this app process. */
  readonly sandboxes: { readonly total: number; readonly running: number };
  readonly sessions: readonly SandboxSessionRecord[];
}
