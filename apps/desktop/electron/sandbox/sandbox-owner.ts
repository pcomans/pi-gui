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
  findQemu,
  loadGondolin,
  qemuInstallHint,
  sandboxPlatformSupported,
} from "./sandbox-gondolin";
import { SandboxImages } from "./sandbox-images";
import { SandboxSession, type SandboxSessionRef } from "./sandbox-session";
import { SandboxSettingsStore } from "./sandbox-settings-store";

export interface SandboxOwnerOptions {
  readonly userDataDir: string;
  /** Used until the person turns the sandbox on or off in Settings. */
  readonly enabledByDefault: boolean;
}

/**
 * Owns pi-gui's tool sandbox: preferences and the network log, VM images, and the VM behind
 * each open session. Sessions get it through a hidden extension that users cannot switch off;
 * turning the sandbox off happens here, in Settings.
 */
export class SandboxOwner {
  private readonly store: SandboxSettingsStore;
  private readonly images: SandboxImages;
  private readonly sessions = new Set<SandboxSession>();
  private readonly knownRepos = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private qemuFound: boolean | undefined;

  constructor(private readonly options: SandboxOwnerOptions) {
    const directory = path.join(options.userDataDir, "sandbox");
    this.store = new SandboxSettingsStore(directory);
    this.images = new SandboxImages(path.join(directory, "images"), loadGondolin, () =>
      this.changed(),
    );
  }

  async initialize(): Promise<void> {
    await this.store.load();
    this.qemuFound = await findQemu();
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
            session.close().catch((error: unknown) => console.error("[sandbox] close", error));
            this.changed();
          },
        }),
      },
    ];
  }

  async snapshot(): Promise<SandboxSnapshot> {
    this.qemuFound = await findQemu();
    return {
      supported: sandboxPlatformSupported(),
      enabled: this.enabled(),
      qemu: { found: this.qemuFound, installHint: qemuInstallHint() },
      baseImage: this.images.baseState(),
      defaultNetworkMode: this.store.defaultNetworkMode,
      repos: this.store.repoRecords([...this.knownRepos]),
      sessions: [...this.sessions].map((session) => ({
        ...session.ref,
        state: session.state,
        ...(session.message ? { message: session.message } : {}),
      })),
    };
  }

  async update(update: SandboxSettingsUpdate): Promise<SandboxSnapshot> {
    await this.store.update(update);
    this.changed();
    return this.snapshot();
  }

  /** Build the base image now (Settings' Prepare/Retry), instead of on the first tool call. */
  async prepare(): Promise<SandboxSnapshot> {
    this.images.retry();
    this.qemuFound = await findQemu();
    if (this.qemuFound) {
      void this.images.imageFor(undefined).catch(() => undefined);
    }
    return this.snapshot();
  }

  /** Stop the VMs of archived threads; a restored thread starts a new one on its next call. */
  stopArchived(isArchived: (ref: SandboxSessionRef) => boolean): void {
    for (const session of this.sessions) {
      if (session.state !== "idle" && isArchived(session.ref)) {
        session.restart().catch((error: unknown) => console.error("[sandbox] stop", error));
      }
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async closeAll(): Promise<void> {
    const sessions = [...this.sessions];
    this.sessions.clear();
    await Promise.all(sessions.map((session) => session.close()));
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
        imageFor: async (config) => {
          if (!this.qemuFound && !(this.qemuFound = await findQemu())) {
            throw new Error(
              `QEMU is not installed. Install it with \`${qemuInstallHint()}\`, or turn the sandbox off in Settings > Sandbox.`,
            );
          }
          return this.images.imageFor(config);
        },
        decide: (repoPath, host, sessionRef) => this.store.decide(repoPath, host, sessionRef),
        noteRepository: (repoPath) => {
          if (this.knownRepos.has(repoPath)) return;
          this.knownRepos.add(repoPath);
          this.changed();
        },
        changed: () => this.changed(),
      },
      onStatus,
    );
    this.sessions.add(session);
    void session.repository().catch(() => undefined);
    this.changed();
    return session;
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }
}
