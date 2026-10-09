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

/**
 * What the integrated terminal says in a sandboxed thread: it is a shell on the host, not in the
 * thread's sandbox. Undefined when the thread is not sandboxed, since there is nothing to contrast.
 */
export function terminalSandboxNotice(
  sandboxed: boolean,
  platform: string,
): { readonly label: string; readonly detail: string } | undefined {
  if (!sandboxed) return undefined;
  const machine = platform === "darwin" ? "this Mac" : "this computer";
  return {
    label: `Runs on ${machine}, outside the sandbox`,
    detail: `This terminal is not sandboxed. It runs on ${machine}, outside the thread's sandbox.`,
  };
}

/**
 * Names that reach this Mac from inside a sandbox. Sandboxes reach every other host unless it is
 * blocked; these stay denied unless the person allows that exact name for a repository.
 */
export const SANDBOX_HOST_ONLY_NAMES: readonly string[] = ["host.docker.internal", "localhost"];

export function isSandboxHostOnlyName(host: string): boolean {
  return SANDBOX_HOST_ONLY_NAMES.includes(host);
}

export type SandboxHostRule = "allow" | "block";
/** Docker Sandboxes (sbx): installed, signed in and its daemon answering. */
export type SandboxBackendState = "missing" | "signed-out" | "unavailable" | "ready";
export type SandboxSessionState = "starting" | "ready" | "idle" | "failed";

/** One outbound host a repository's sandboxes contacted. Host names only, never URLs. */
export interface SandboxHostLogEntry {
  readonly host: string;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly allowedCount: number;
  readonly blockedCount: number;
  /** Thread that most recently contacted the host. */
  readonly lastWorkspaceId?: string;
  readonly lastSessionId?: string;
}

export interface SandboxRepoNetworkRecord {
  /** Main checkout of the repository; its worktrees share these rules. */
  readonly repoPath: string;
  /** Services on this Mac (SANDBOX_HOST_ONLY_NAMES) the person allowed; nothing else is listed. */
  readonly allowedHosts: readonly string[];
  readonly blockedHosts: readonly string[];
  readonly hosts: readonly SandboxHostLogEntry[];
}

export interface SandboxSessionRecord {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly state: SandboxSessionState;
  readonly message?: string;
}

export interface SandboxSnapshot {
  /** False on platforms Docker Sandboxes cannot run on (Windows). */
  readonly supported: boolean;
  readonly enabled: boolean;
  readonly backend: {
    readonly state: SandboxBackendState;
    readonly message?: string;
    readonly installHint: string;
  };
  /** Sandboxes pi-gui created; unused ones belong to no open thread. */
  readonly sandboxes: { readonly total: number; readonly running: number; readonly unused: number };
  readonly repos: readonly SandboxRepoNetworkRecord[];
  readonly sessions: readonly SandboxSessionRecord[];
}

export type SandboxSettingsUpdate =
  | { readonly kind: "enabled"; readonly enabled: boolean }
  | { readonly kind: "remove-unused-sandboxes" }
  | {
      /** "allow" applies only to SANDBOX_HOST_ONLY_NAMES; every other host is allowed unless blocked. */
      readonly kind: "host-rule";
      readonly repoPath: string;
      readonly host: string;
      readonly rule: SandboxHostRule | null;
    };

/** Lowercased host name, or undefined when the value cannot be one. `*` wildcards are allowed. */
export function normalizeSandboxHost(value: string): string | undefined {
  const host = value.trim().toLowerCase().replace(/\.$/, "");
  return /^[a-z0-9*]([a-z0-9*.-]{0,251}[a-z0-9*])?$/.test(host) && !host.includes("..")
    ? host
    : undefined;
}
