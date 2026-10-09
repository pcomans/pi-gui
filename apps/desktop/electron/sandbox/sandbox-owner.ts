import path from "node:path";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { WorkspaceRef } from "@pi-gui/session-driver";
import type {
  SandboxSessionState,
  SandboxSettingsUpdate,
  SandboxSnapshot,
} from "../../contracts/sandbox";
import { createSandboxExtension } from "./sandbox-extension";
import {
  addNetworkRule,
  globalPolicyAllowsAll,
  listSandboxes,
  policyLog,
  removeNetworkRule,
  removeSandbox,
  sandboxNetworkRules,
  sandboxPlatformSupported,
  sbxInstallHint,
  sbxStatus,
  stopSandbox,
  threadPrefix,
  type SbxStatus,
} from "./sandbox-sbx";
import { SandboxSession, type SandboxSessionRef } from "./sandbox-session";
import { SandboxSettingsStore } from "./sandbox-settings-store";

export interface SandboxOwnerOptions {
  readonly userDataDir: string;
  /** Used until the person turns the sandbox on or off in Settings. */
  readonly enabledByDefault: boolean;
}

/** sbx's own policy log is polled this often while sandboxes are open, for the host list. */
const LOG_POLL_MS = 5_000;
const STATUS_CACHE_MS = 30_000;

/**
 * Owns pi-gui's tool sandbox: preferences and the network log, and the Docker sandbox (sbx)
 * behind each open session. Sessions get it through a hidden extension that users cannot
 * switch off; turning the sandbox off happens here, in Settings.
 */
export class SandboxOwner {
  private readonly store: SandboxSettingsStore;
  private readonly sessions = new Set<SandboxSession>();
  private readonly knownRepos = new Set<string>();
  /** Sandbox name → the repository and thread it serves, for attributing sbx's log. */
  private readonly sandboxThreads = new Map<
    string,
    { readonly repoPath: string; readonly ref: SandboxSessionRef }
  >();
  /** Last cumulative count sbx reported per sandbox, host and verdict. */
  private readonly loggedCounts = new Map<string, number>();
  private readonly baselined = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private status: { readonly value: SbxStatus; readonly at: number } | undefined;
  private logTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly options: SandboxOwnerOptions) {
    this.store = new SandboxSettingsStore(path.join(options.userDataDir, "sandbox"));
  }

  async initialize(): Promise<void> {
    await this.store.load();
    if (this.enabled()) {
      // No thread uses a sandbox yet, so running pi-gui sandboxes were left by a crash.
      this.stopLeftoverSandboxes().catch((error: unknown) =>
        console.error("[sandbox] stop leftovers", error),
      );
    }
  }

  enabled(): boolean {
    return sandboxPlatformSupported() && this.store.enabled(this.options.enabledByDefault);
  }

  sessionExtensions(workspace: WorkspaceRef): InlineExtension[] {
    return [
      {
        name: "pi-gui-sandbox",
        hidden: true,
        factory: createSandboxExtension(workspace, {
          enabled: () => this.enabled(),
          openSession: (ref, checkoutPath, onStatus) =>
            this.openSession(ref, checkoutPath, onStatus),
          closeSession: (session) => {
            this.sessions.delete(session);
            session.close(true).catch((error: unknown) => console.error("[sandbox] close", error));
            this.changed();
          },
        }),
      },
    ];
  }

  async snapshot(): Promise<SandboxSnapshot> {
    const status = await this.sbxStatus(true);
    const ready = status.state === "ready" ? status.binary : undefined;
    const [listed, globalAllowsAll] = ready
      ? await Promise.all([
          listSandboxes(ready).catch(() => []),
          globalPolicyAllowsAll(ready).catch(() => false),
          this.pollLog(ready),
        ])
      : [[], false];
    const owned = this.store.ownedSandboxes();
    const sandboxes = listed.filter((sandbox) => owned.has(sandbox.name));
    return {
      supported: sandboxPlatformSupported(),
      enabled: this.enabled(),
      backend: {
        state: status.state,
        ...("message" in status ? { message: status.message } : {}),
        installHint: sbxInstallHint(),
      },
      globalAllowsAll,
      sandboxes: {
        total: sandboxes.length,
        running: sandboxes.filter((sandbox) => sandbox.status === "running").length,
        unused: sandboxes.filter((sandbox) => !this.inUse(sandbox.name)).length,
      },
      defaultNetworkMode: this.store.defaultNetworkMode,
      repos: this.store.repoRecords([...this.knownRepos]),
      sessions: [...this.sessions].map((session) => ({
        ...session.ref,
        state: session.state,
        ...(session.message ? { message: session.message } : {}),
      })),
    };
  }

  /** Whether an open thread owns the sandbox, even if it has not used it since launch. */
  private inUse(name: string): boolean {
    return [...this.sessions].some((session) =>
      name.startsWith(threadPrefix(`${session.ref.workspaceId}\0${session.ref.sessionId}`)),
    );
  }

  async update(update: SandboxSettingsUpdate): Promise<SandboxSnapshot> {
    if (update.kind === "remove-unused-sandboxes") {
      await this.removeUnusedSandboxes();
    } else {
      await this.store.update(update);
      await this.reapplyNetworkRules(
        update.kind === "host-rule" || update.kind === "repo-network-mode"
          ? update.repoPath
          : undefined,
      );
    }
    this.changed();
    return this.snapshot();
  }

  /** Check sbx again (Settings' Check again button). */
  async prepare(): Promise<SandboxSnapshot> {
    this.status = undefined;
    return this.snapshot();
  }

  /** Stop the sandboxes of archived threads; a restored thread starts its own on its next call. */
  stopArchived(isArchived: (ref: SandboxSessionRef) => boolean): void {
    for (const session of this.sessions) {
      if (session.state !== "idle" && isArchived(session.ref)) {
        session.stop().catch((error: unknown) => console.error("[sandbox] stop", error));
      }
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async closeAll(): Promise<void> {
    if (this.logTimer) clearInterval(this.logTimer);
    this.logTimer = undefined;
    const sessions = [...this.sessions];
    this.sessions.clear();
    await Promise.all(sessions.map((session) => session.close(true)));
    await this.store.flush().catch((error: unknown) => console.error("[sandbox] flush", error));
  }

  private openSession(
    ref: SandboxSessionRef,
    checkoutPath: string,
    onStatus: (state: SandboxSessionState, message?: string) => void,
  ): SandboxSession {
    const session = new SandboxSession(
      ref,
      checkoutPath,
      {
        sbx: async () => {
          const status = await this.sbxStatus(false);
          if (status.state === "ready") return status.binary;
          this.status = undefined;
          throw new Error(
            status.state === "missing"
              ? `Docker Sandboxes (sbx) is not installed. Install it: ${sbxInstallHint()}. Or turn the sandbox off in Settings > Sandbox.`
              : `${status.message} Or turn the sandbox off in Settings > Sandbox.`,
          );
        },
        applyNetworkRules: (sbx, sandbox, repoPath) =>
          this.applyNetworkRules(sbx, sandbox, repoPath),
        noteSandbox: (sandbox, repoPath, sessionRef) => {
          // A thread whose mounts changed moved to a new sandbox; its old one is gone.
          for (const [name, thread] of this.sandboxThreads) {
            if (
              thread.ref.workspaceId === sessionRef.workspaceId &&
              thread.ref.sessionId === sessionRef.sessionId
            ) {
              this.sandboxThreads.delete(name);
            }
          }
          this.sandboxThreads.set(sandbox, { repoPath, ref: sessionRef });
          this.store
            .setOwned(sandbox, true)
            .catch((error: unknown) => console.error("[sandbox] record sandbox", error));
          this.knownRepos.add(repoPath);
          this.startLogPolling();
        },
        changed: () => this.changed(),
      },
      onStatus,
    );
    this.sessions.add(session);
    this.changed();
    // Say so before the first tool call when sbx cannot run sandboxes at all.
    this.sbxStatus(false)
      .then((status) => {
        if (status.state === "missing") {
          session.unavailable(
            `Docker Sandboxes (sbx) is not installed. Install it: ${sbxInstallHint()}.`,
          );
        } else if (status.state !== "ready") {
          session.unavailable(status.message);
        }
      })
      .catch(() => undefined);
    return session;
  }

  private async sbxStatus(fresh: boolean): Promise<SbxStatus> {
    if (!fresh && this.status?.value.state === "ready") return this.status.value;
    if (this.status && Date.now() - this.status.at < STATUS_CACHE_MS && !fresh) {
      return this.status.value;
    }
    this.status = { value: await sbxStatus(), at: Date.now() };
    return this.status.value;
  }

  /**
   * Make a sandbox's own rules match its repository: allow everything or the allowlist, and deny
   * blocked hosts (sbx lets a deny win over any allow).
   */
  private async applyNetworkRules(sbx: string, sandbox: string, repoPath: string): Promise<void> {
    const rules = this.store.rulesFor(repoPath);
    // Services on this Mac stay out of reach unless the person allowed one by name.
    const hostOnly = HOST_ONLY_NAMES.filter((name) => !rules.allowedHosts.includes(name));
    const wanted = [
      ...(rules.mode === "allow-all"
        ? [{ decision: "allow" as const, resource: "**" }]
        : rules.allowedHosts.map((host) => ({ decision: "allow" as const, resource: host }))),
      ...[...new Set([...rules.blockedHosts, ...hostOnly])].map((host) => ({
        decision: "deny" as const,
        resource: host,
      })),
    ];
    await this.baselineLog(sbx, sandbox);
    const current = await sandboxNetworkRules(sbx, sandbox);
    const key = (decision: string, resource: string) => `${decision} ${resource}`;
    const wantedKeys = new Set(wanted.map((rule) => key(rule.decision, rule.resource)));
    const currentKeys = new Set<string>();
    for (const rule of current) {
      const ruleKey = key(rule.decision, rule.resources.join(","));
      if (wantedKeys.has(ruleKey) && !currentKeys.has(ruleKey)) currentKeys.add(ruleKey);
      else await removeNetworkRule(sbx, sandbox, rule.id);
    }
    for (const rule of wanted) {
      if (!currentKeys.has(key(rule.decision, rule.resource))) {
        await addNetworkRule(sbx, sandbox, rule.decision, rule.resource);
      }
    }
  }

  private async reapplyNetworkRules(repoPath: string | undefined): Promise<void> {
    const status = await this.sbxStatus(false);
    if (status.state !== "ready") return;
    for (const [sandbox, thread] of this.sandboxThreads) {
      if (repoPath === undefined || thread.repoPath === repoPath) {
        await this.applyNetworkRules(status.binary, sandbox, thread.repoPath).catch(
          (error: unknown) => console.error("[sandbox] network rules", error),
        );
      }
    }
  }

  private startLogPolling(): void {
    this.logTimer ??= setInterval(() => {
      if (this.sessions.size === 0) return;
      const status = this.status?.value;
      if (status?.state !== "ready") return;
      this.pollLog(status.binary).catch((error: unknown) =>
        console.error("[sandbox] policy log", error),
      );
    }, LOG_POLL_MS);
    this.logTimer.unref?.();
  }

  /**
   * sbx keeps a sandbox's counts across restarts and app launches; counting starts from what it
   * reports when this run first uses the sandbox, so earlier traffic is not counted again.
   */
  private async baselineLog(sbx: string, sandbox: string): Promise<void> {
    if (this.baselined.has(sandbox)) return;
    this.baselined.add(sandbox);
    for (const entry of await policyLog(sbx).catch(() => [])) {
      if (entry.sandbox === sandbox) {
        this.loggedCounts.set(`${entry.sandbox}\0${entry.host}\0${entry.allowed}`, entry.count);
      }
    }
  }

  /** Fold sbx's cumulative per-sandbox counts into the per-repository host log. */
  private async pollLog(sbx: string): Promise<void> {
    let changed = false;
    for (const entry of await policyLog(sbx).catch(() => [])) {
      const thread = this.sandboxThreads.get(entry.sandbox);
      if (!thread) continue;
      const countKey = `${entry.sandbox}\0${entry.host}\0${entry.allowed}`;
      const previous = this.loggedCounts.get(countKey) ?? 0;
      // A restarted sandbox counts from zero again.
      const added = entry.count >= previous ? entry.count - previous : entry.count;
      this.loggedCounts.set(countKey, entry.count);
      if (added > 0) {
        this.store.record(
          thread.repoPath,
          entry.host,
          entry.allowed,
          thread.ref,
          added,
          entry.lastSeenAt,
        );
        changed = true;
      }
    }
    if (changed) this.changed();
  }

  private async stopLeftoverSandboxes(): Promise<void> {
    const status = await this.sbxStatus(true);
    if (status.state !== "ready") return;
    const owned = this.store.ownedSandboxes();
    for (const sandbox of await listSandboxes(status.binary).catch(() => [])) {
      if (owned.has(sandbox.name) && sandbox.status === "running") {
        await stopSandbox(status.binary, sandbox.name).catch(() => undefined);
      }
    }
  }

  private async removeUnusedSandboxes(): Promise<void> {
    const status = await this.sbxStatus(true);
    if (status.state !== "ready") return;
    const owned = this.store.ownedSandboxes();
    const existing = new Set((await listSandboxes(status.binary)).map((sandbox) => sandbox.name));
    for (const name of [...owned]) {
      if (this.inUse(name)) continue;
      if (existing.has(name)) await removeSandbox(status.binary, name);
      this.sandboxThreads.delete(name);
      await this.store.setOwned(name, false);
    }
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }
}

/** Names that reach this Mac from inside a sandbox. */
const HOST_ONLY_NAMES = ["host.docker.internal", "localhost"];
