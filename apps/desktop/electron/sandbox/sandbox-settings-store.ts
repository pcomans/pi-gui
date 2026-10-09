import path from "node:path";
import {
  normalizeSandboxHost,
  type SandboxHostLogEntry,
  type SandboxNetworkMode,
  type SandboxRepoNetworkRecord,
  type SandboxSettingsUpdate,
} from "../../contracts/sandbox";
import { readJsonWithBackup, writeFileAtomicQueued } from "../persistence/atomic-file-write";

const SETTINGS_VERSION = 1;
const LOG_VERSION = 1;
/** Hosts kept per repository; the least recently seen go first. */
const MAX_LOGGED_HOSTS = 500;
const LOG_SAVE_DELAY_MS = 2_000;

interface RepoRules {
  readonly mode?: SandboxNetworkMode;
  readonly allowedHosts: readonly string[];
  readonly blockedHosts: readonly string[];
}

interface SettingsFile {
  readonly version: typeof SETTINGS_VERSION;
  readonly enabled?: boolean;
  readonly defaultNetworkMode: SandboxNetworkMode;
  readonly repos: Readonly<Record<string, RepoRules>>;
}

interface LogFile {
  readonly version: typeof LOG_VERSION;
  readonly repos: Readonly<Record<string, readonly SandboxHostLogEntry[]>>;
}

const EMPTY_SETTINGS: SettingsFile = {
  version: SETTINGS_VERSION,
  defaultNetworkMode: "allow-all",
  repos: {},
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function fail(file: string, field: string): never {
  throw new Error(`Invalid sandbox ${file} field ${field}; original data was retained.`);
}

function decodeMode(value: unknown, field: string): SandboxNetworkMode {
  if (value !== "allow-all" && value !== "allowlist") fail("settings", field);
  return value;
}

function decodeHosts(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) fail("settings", field);
  return value.map((host, index) => {
    const normalized = typeof host === "string" ? normalizeSandboxHost(host) : undefined;
    if (!normalized) fail("settings", `${field}[${index}]`);
    return normalized;
  });
}

export function decodeSandboxSettings(value: unknown): SettingsFile {
  if (!isRecord(value) || value.version !== SETTINGS_VERSION) fail("settings", "version");
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    fail("settings", "enabled");
  }
  if (!isRecord(value.repos)) fail("settings", "repos");
  const repos: Record<string, RepoRules> = {};
  for (const [repoPath, rules] of Object.entries(value.repos)) {
    if (!path.isAbsolute(repoPath) || !isRecord(rules)) fail("settings", `repos.${repoPath}`);
    repos[repoPath] = {
      ...(rules.mode === undefined
        ? {}
        : { mode: decodeMode(rules.mode, `repos.${repoPath}.mode`) }),
      allowedHosts: decodeHosts(rules.allowedHosts, `repos.${repoPath}.allowedHosts`),
      blockedHosts: decodeHosts(rules.blockedHosts, `repos.${repoPath}.blockedHosts`),
    };
  }
  return {
    version: SETTINGS_VERSION,
    ...(value.enabled === undefined ? {} : { enabled: value.enabled }),
    defaultNetworkMode: decodeMode(value.defaultNetworkMode, "defaultNetworkMode"),
    repos,
  };
}

function decodeCount(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) fail("log", field);
  return value;
}

function decodeLogString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) fail("log", field);
  return value;
}

export function decodeSandboxNetworkLog(value: unknown): LogFile {
  if (!isRecord(value) || value.version !== LOG_VERSION) fail("log", "version");
  if (!isRecord(value.repos)) fail("log", "repos");
  const repos: Record<string, SandboxHostLogEntry[]> = {};
  for (const [repoPath, entries] of Object.entries(value.repos)) {
    if (!path.isAbsolute(repoPath) || !Array.isArray(entries)) fail("log", `repos.${repoPath}`);
    repos[repoPath] = entries.map((entry: unknown, index) => {
      const field = `repos.${repoPath}[${index}]`;
      if (!isRecord(entry)) fail("log", field);
      return {
        host: decodeLogString(entry.host, `${field}.host`),
        firstSeenAt: decodeLogString(entry.firstSeenAt, `${field}.firstSeenAt`),
        lastSeenAt: decodeLogString(entry.lastSeenAt, `${field}.lastSeenAt`),
        allowedCount: decodeCount(entry.allowedCount, `${field}.allowedCount`),
        blockedCount: decodeCount(entry.blockedCount, `${field}.blockedCount`),
        ...(entry.lastWorkspaceId === undefined
          ? {}
          : {
              lastWorkspaceId: decodeLogString(entry.lastWorkspaceId, `${field}.lastWorkspaceId`),
            }),
        ...(entry.lastSessionId === undefined
          ? {}
          : { lastSessionId: decodeLogString(entry.lastSessionId, `${field}.lastSessionId`) }),
      };
    });
  }
  return { version: LOG_VERSION, repos };
}

/**
 * Sandbox preferences and the outbound host log. Rules belong to a repository's main checkout, so
 * its worktrees share them. The log keeps host names and counts only, never URLs or contents.
 */
export class SandboxSettingsStore {
  private settings: SettingsFile = EMPTY_SETTINGS;
  private log = new Map<string, Map<string, SandboxHostLogEntry>>();
  private logSaveTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly settingsPath: string;
  private readonly logPath: string;

  constructor(directory: string) {
    this.settingsPath = path.join(directory, "sandbox-settings.json");
    this.logPath = path.join(directory, "network-log.json");
  }

  async load(): Promise<void> {
    const settings = await readJsonWithBackup(this.settingsPath);
    if (settings.value !== undefined) this.settings = decodeSandboxSettings(settings.value);
    const log = await readJsonWithBackup(this.logPath);
    if (log.value !== undefined) {
      for (const [repoPath, entries] of Object.entries(decodeSandboxNetworkLog(log.value).repos)) {
        this.log.set(repoPath, new Map(entries.map((entry) => [entry.host, entry])));
      }
    }
  }

  enabled(fallback: boolean): boolean {
    return this.settings.enabled ?? fallback;
  }

  get defaultNetworkMode(): SandboxNetworkMode {
    return this.settings.defaultNetworkMode;
  }

  async update(update: SandboxSettingsUpdate): Promise<void> {
    this.settings = applyUpdate(this.settings, update);
    await writeFileAtomicQueued(
      this.settingsPath,
      `${JSON.stringify(this.settings, null, 2)}\n`,
      decodeSandboxSettings,
    );
  }

  /** The rules a repository's sandboxes enforce. */
  rulesFor(repoPath: string): {
    readonly mode: SandboxNetworkMode;
    readonly allowedHosts: readonly string[];
    readonly blockedHosts: readonly string[];
  } {
    const rules = this.settings.repos[repoPath];
    return {
      mode: rules?.mode ?? this.settings.defaultNetworkMode,
      allowedHosts: rules?.allowedHosts ?? [],
      blockedHosts: rules?.blockedHosts ?? [],
    };
  }

  repoRecords(extraRepoPaths: readonly string[]): SandboxRepoNetworkRecord[] {
    const repoPaths = new Set([
      ...Object.keys(this.settings.repos),
      ...this.log.keys(),
      ...extraRepoPaths,
    ]);
    return [...repoPaths].sort().map((repoPath) => {
      const rules = this.settings.repos[repoPath];
      return {
        repoPath,
        ...(rules?.mode ? { mode: rules.mode } : {}),
        effectiveMode: rules?.mode ?? this.settings.defaultNetworkMode,
        allowedHosts: rules?.allowedHosts ?? [],
        blockedHosts: rules?.blockedHosts ?? [],
        hosts: [...(this.log.get(repoPath)?.values() ?? [])].sort((a, b) =>
          b.lastSeenAt.localeCompare(a.lastSeenAt),
        ),
      };
    });
  }

  async flush(): Promise<void> {
    if (this.logSaveTimer) clearTimeout(this.logSaveTimer);
    this.logSaveTimer = undefined;
    const repos = Object.fromEntries(
      [...this.log].map(([repoPath, entries]) => [repoPath, [...entries.values()]]),
    );
    await writeFileAtomicQueued(
      this.logPath,
      `${JSON.stringify({ version: LOG_VERSION, repos }, null, 2)}\n`,
      decodeSandboxNetworkLog,
    );
  }

  record(
    repoPath: string,
    host: string,
    allowed: boolean,
    thread: { readonly workspaceId: string; readonly sessionId: string },
    count = 1,
    seenAt = new Date().toISOString(),
  ): void {
    const entries = this.log.get(repoPath) ?? new Map<string, SandboxHostLogEntry>();
    this.log.set(repoPath, entries);
    host = host.toLowerCase();
    const now = seenAt;
    const previous = entries.get(host);
    entries.delete(host);
    entries.set(host, {
      host,
      firstSeenAt: previous?.firstSeenAt ?? now,
      lastSeenAt: now,
      allowedCount: (previous?.allowedCount ?? 0) + (allowed ? count : 0),
      blockedCount: (previous?.blockedCount ?? 0) + (allowed ? 0 : count),
      lastWorkspaceId: thread.workspaceId,
      lastSessionId: thread.sessionId,
    });
    // Map order is insertion order, so the first key is the least recently seen host.
    while (entries.size > MAX_LOGGED_HOSTS) {
      entries.delete(entries.keys().next().value!);
    }
    this.logSaveTimer ??= setTimeout(() => {
      this.logSaveTimer = undefined;
      this.flush().catch((error: unknown) => console.error("[sandbox] network log save", error));
    }, LOG_SAVE_DELAY_MS);
  }
}

function applyUpdate(settings: SettingsFile, update: SandboxSettingsUpdate): SettingsFile {
  switch (update.kind) {
    case "remove-unused-sandboxes":
      return settings;
    case "enabled":
      return { ...settings, enabled: update.enabled };
    case "default-network-mode":
      return { ...settings, defaultNetworkMode: update.mode };
    case "repo-network-mode": {
      const rules = repoRules(settings, update.repoPath);
      const { mode: _previous, ...rest } = rules;
      return withRepo(
        settings,
        update.repoPath,
        update.mode ? { ...rest, mode: update.mode } : rest,
      );
    }
    case "host-rule": {
      const host = normalizeSandboxHost(update.host);
      if (!host) throw new Error(`Not a host name: ${update.host}`);
      const rules = repoRules(settings, update.repoPath);
      const allowedHosts = rules.allowedHosts.filter((entry) => entry !== host);
      const blockedHosts = rules.blockedHosts.filter((entry) => entry !== host);
      if (update.rule === "allow") allowedHosts.push(host);
      if (update.rule === "block") blockedHosts.push(host);
      return withRepo(settings, update.repoPath, { ...rules, allowedHosts, blockedHosts });
    }
  }
}

function repoRules(settings: SettingsFile, repoPath: string): RepoRules {
  if (!path.isAbsolute(repoPath)) throw new Error(`Not an absolute repository path: ${repoPath}`);
  return settings.repos[repoPath] ?? { allowedHosts: [], blockedHosts: [] };
}

function withRepo(settings: SettingsFile, repoPath: string, rules: RepoRules): SettingsFile {
  return { ...settings, repos: { ...settings.repos, [repoPath]: rules } };
}
