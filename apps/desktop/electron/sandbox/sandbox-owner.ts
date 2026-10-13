import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { WorkspaceRef, SessionRef, TurnCaptureBoundary } from "@pi-gui/session-driver";
import type { SandboxSessionState, SandboxSnapshot } from "../../contracts/sandbox";
import { createSandboxExtension } from "./sandbox-extension";
import type { SandboxSessionRef, ToolSandboxSession } from "./sandbox-session";
import {
  VercelSandboxSession,
  vercelSandboxCredentials,
  VERCEL_SANDBOX_PROMPT,
  REMOTE_CWD,
} from "./sandbox-vercel";
import type { RemoteWorkbenchCalls } from "./remote-workbench";
import type { ReviewRequestsOwner } from "../ipc/review-requests";

export interface SandboxOwnerOptions {
  readonly userDataDir: string;
}

/** Owns remote execution. A missing connection fails closed; no tool ever runs on the host. */
export class SandboxOwner {
  private readonly sessions = new Map<string, VercelSandboxSession>();
  private readonly listeners = new Set<() => void>();
  private readonly statusListeners = new Map<
    string,
    Set<(state: SandboxSessionState, message?: string) => void>
  >();

  constructor(private readonly options: SandboxOwnerOptions) {}

  session(workspace: WorkspaceRef, ref: SessionRef): VercelSandboxSession {
    if (workspace.workspaceId !== ref.workspaceId)
      throw new Error("The workspace does not own this thread.");
    const key = `${ref.workspaceId}\0${ref.sessionId}`;
    let session = this.sessions.get(key);
    if (!session) {
      session = new VercelSandboxSession(
        ref,
        workspace,
        this.options.userDataDir,
        (state, message) => {
          for (const listener of this.statusListeners.get(key) ?? []) listener(state, message);
          this.changed();
        },
      );
      this.sessions.set(key, session);
    }
    return session;
  }

  sessionExtensions(workspace: WorkspaceRef): InlineExtension[] {
    return [
      {
        name: "pi-gui-sandbox",
        hidden: true,
        factory: createSandboxExtension(workspace, {
          prompt: VERCEL_SANDBOX_PROMPT,
          cwd: REMOTE_CWD,
          instructions: (session) => (session as VercelSandboxSession).call("instructions", null),
          openSession: (ref, _path, onStatus) => {
            const key = `${ref.workspaceId}\0${ref.sessionId}`;
            const listeners = this.statusListeners.get(key) ?? new Set();
            listeners.add(onStatus);
            this.statusListeners.set(key, listeners);
            return this.session(workspace, ref);
          },
          closeSession: (session: ToolSandboxSession) => {
            this.statusListeners.delete(`${session.ref.workspaceId}\0${session.ref.sessionId}`);
            session
              .stop()
              .catch((error: unknown) => console.error("[remote workspace] stop", error));
          },
        }),
      },
    ];
  }

  async capture(boundary: TurnCaptureBoundary, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error("Checkpoint capture was interrupted.");
    await this.session(boundary.workspace, boundary.sessionRef).call("capture", boundary, signal);
    if (signal.aborted) throw new Error("Checkpoint capture was interrupted.");
  }

  async fork(workspace: WorkspaceRef, source: SessionRef, target: SessionRef): Promise<void> {
    await this.session(workspace, target).forkFrom(this.session(workspace, source));
  }

  workbench(resolve: (target: SessionRef) => WorkspaceRef | undefined): ReviewRequestsOwner {
    const reviewTargets = new Map<string, SessionRef>();
    const call = <K extends keyof ReviewRequestsOwner>(
      action: K,
      input: RemoteWorkbenchCalls[K]["input"],
    ) => {
      const target = "target" in input ? input.target : reviewTargets.get(input.reviewId);
      if (!target) throw new Error("This comparison expired. Refresh Review.");
      const workspace = resolve(target);
      if (!workspace) throw new Error("This task is unavailable.");
      return this.session(workspace, target).call(action, input);
    };
    return {
      getReview: async (input) => {
        const result = await call("getReview", input);
        if (result.state === "available") {
          reviewTargets.set(result.reviewId, input.target);
          while (reviewTargets.size > 256) reviewTargets.delete(reviewTargets.keys().next().value!);
        }
        return result;
      },
      getTurnChanges: (input) => call("getTurnChanges", input),
      getReviewFile: (input) => call("getReviewFile", input),
      setReviewFileReviewed: (input) => call("setReviewFileReviewed", input),
      changeReviewFileStage: (input) => call("changeReviewFileStage", input),
    };
  }

  async snapshot(): Promise<SandboxSnapshot> {
    const error = await vercelSandboxCredentials().then(
      () => undefined,
      (error: unknown) => String(error),
    );
    const sessions = [...this.sessions.values()];
    return {
      supported: true,
      enabled: true,
      backend: {
        provider: "vercel",
        state: error ? "unavailable" : "ready",
        ...(error ? { message: error } : {}),
        installHint: "vercel login",
      },
      sandboxes: {
        total: sessions.filter((s) => s.sandbox).length,
        running: sessions.filter((s) => s.state === "ready").length,
      },
      sessions: sessions.map((session) => ({
        ...session.ref,
        state: session.state,
        ...(session.message ? { message: session.message } : {}),
      })),
    };
  }
  stopArchived(isArchived: (ref: SandboxSessionRef) => boolean): void {
    for (const session of this.sessions.values())
      if (session.state !== "idle" && isArchived(session.ref))
        session.stop().catch((error: unknown) => console.error("[remote workspace] stop", error));
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((session) => session.close(true)));
  }
  private changed(): void {
    for (const listener of this.listeners) listener();
  }
}
