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

/** Whether a sandboxed thread may reach any host, or only hosts the person allowed. */
export type SandboxNetworkMode = "allow-all" | "allowlist";
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
  /** Set only when the repository overrides the default mode. */
  readonly mode?: SandboxNetworkMode;
  readonly effectiveMode: SandboxNetworkMode;
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
  /** False on platforms Gondolin cannot run on (Windows). */
  readonly supported: boolean;
  readonly enabled: boolean;
  readonly backend: {
    readonly state: SandboxBackendState;
    readonly message?: string;
    readonly installHint: string;
  };
  /**
   * sbx's global policy lets every sandbox reach any host. Its rules win over per-sandbox
   * allows, so an allowlist cannot narrow it; only blocks apply.
   */
  readonly globalAllowsAll: boolean;
  /** Sandboxes pi-gui created; unused ones belong to no open thread. */
  readonly sandboxes: { readonly total: number; readonly running: number; readonly unused: number };
  readonly defaultNetworkMode: SandboxNetworkMode;
  readonly repos: readonly SandboxRepoNetworkRecord[];
  readonly sessions: readonly SandboxSessionRecord[];
}

export type SandboxSettingsUpdate =
  | { readonly kind: "enabled"; readonly enabled: boolean }
  | { readonly kind: "default-network-mode"; readonly mode: SandboxNetworkMode }
  | {
      readonly kind: "repo-network-mode";
      readonly repoPath: string;
      readonly mode: SandboxNetworkMode | null;
    }
  | { readonly kind: "remove-unused-sandboxes" }
  | {
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
