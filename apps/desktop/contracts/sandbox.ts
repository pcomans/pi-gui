/** Whether a sandboxed thread may reach any host, or only hosts the person allowed. */
export type SandboxNetworkMode = "allow-all" | "allowlist";
export type SandboxHostRule = "allow" | "block";
export type SandboxImageState = "missing" | "building" | "ready" | "failed";
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
  /** QEMU binary the sandbox needs, or how to install it. */
  readonly qemu: { readonly found: boolean; readonly installHint: string };
  readonly baseImage: { readonly state: SandboxImageState; readonly error?: string };
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

/** `*` matches any run of characters, as in Gondolin's host patterns. */
export function sandboxHostMatches(host: string, pattern: string): boolean {
  if (pattern === "*") return true;
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`, "i").test(host);
}
