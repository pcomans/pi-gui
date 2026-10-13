import type { WebContents } from "electron";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { SessionRef } from "@pi-gui/session-driver";
import {
  desktopIpc,
  type TerminalPanelSnapshot,
  type TerminalSessionSnapshot,
  type TerminalSize,
} from "../../contracts/ipc";
import { appendTerminalReplay } from "../../contracts/terminal-model";
import type { VercelSandboxSession } from "./sandbox-vercel";
import { REMOTE_CWD } from "./sandbox-vercel";
import type { SandboxWorker } from "./sandbox-worker";

type TerminalHandle = ReturnType<SandboxWorker["openTerminal"]>;
interface OwnedTerminal {
  readonly owner: WebContents;
  readonly target: SessionRef;
  readonly rootKey: string;
  snapshot: TerminalSessionSnapshot;
  handle?: TerminalHandle;
  size: TerminalSize;
}
interface TerminalRoot {
  readonly target: SessionRef;
  readonly key: string;
  ids: string[];
  active: string;
}

/** Window-owned xterm sessions connected to the selected thread's remote PTY. */
export class RemoteTerminalService {
  private readonly roots = new Map<string, TerminalRoot>();
  private readonly terminals = new Map<string, OwnedTerminal>();
  private readonly creating = new Map<string, Promise<void>>();
  constructor(private readonly resolve: (target: SessionRef) => VercelSandboxSession) {}

  async ensurePanel(
    owner: WebContents,
    workspaceId: string,
    sessionId: string,
    size?: Partial<TerminalSize>,
  ): Promise<TerminalPanelSnapshot> {
    const root = this.root(owner, workspaceId, sessionId);
    if (!root.ids.length) {
      let pending = this.creating.get(root.key);
      if (!pending) {
        pending = this.create(owner, root, size).finally(() => this.creating.delete(root.key));
        this.creating.set(root.key, pending);
      }
      await pending;
    }
    return this.snapshot(root);
  }
  async createSession(
    owner: WebContents,
    workspaceId: string,
    sessionId: string,
    size?: Partial<TerminalSize>,
  ): Promise<TerminalPanelSnapshot> {
    const root = this.root(owner, workspaceId, sessionId);
    if (root.ids.length >= 8) throw new Error("A thread can have up to eight terminal tabs.");
    await this.create(owner, root, size);
    return this.snapshot(root);
  }
  setActiveSession(
    owner: WebContents,
    workspaceId: string,
    sessionId: string,
    id: string,
  ): TerminalPanelSnapshot {
    const terminal = this.owned(owner, id);
    if (terminal.target.workspaceId !== workspaceId || terminal.target.sessionId !== sessionId)
      throw new Error("This terminal belongs to another thread.");
    const root = this.roots.get(terminal.rootKey)!;
    root.active = id;
    return this.snapshot(root);
  }
  async write(owner: WebContents, id: string, data: string): Promise<void> {
    const terminal = this.owned(owner, id);
    for (let offset = 0; offset < data.length;) {
      let end = Math.min(offset + 128 * 1024, data.length);
      const code = data.charCodeAt(end - 1);
      if (end < data.length && code >= 0xd800 && code <= 0xdbff) end -= 1;
      await terminal.handle?.write(data.slice(offset, end));
      offset = end;
    }
  }
  async resize(owner: WebContents, id: string, size: TerminalSize): Promise<void> {
    const terminal = this.owned(owner, id);
    terminal.size = normalizeSize(size);
    await terminal.handle?.resize(terminal.size.cols, terminal.size.rows);
  }
  async restart(
    owner: WebContents,
    id: string,
    size?: Partial<TerminalSize>,
  ): Promise<TerminalPanelSnapshot> {
    const terminal = this.owned(owner, id);
    await terminal.handle?.close();
    terminal.handle = undefined;
    terminal.size = normalizeSize(size ?? terminal.size);
    terminal.snapshot = {
      ...terminal.snapshot,
      status: "running",
      replay: "",
      truncated: false,
      exitCode: undefined,
    };
    await this.start(terminal);
    return this.snapshot(this.roots.get(terminal.rootKey)!);
  }
  async close(owner: WebContents, id: string): Promise<TerminalPanelSnapshot | null> {
    const terminal = this.owned(owner, id);
    this.terminals.delete(id);
    await terminal.handle?.close().catch(() => undefined);
    const root = this.roots.get(terminal.rootKey)!;
    root.ids = root.ids.filter((value) => value !== id);
    if (!root.ids.length) {
      this.roots.delete(root.key);
      return null;
    }
    if (root.active === id) root.active = root.ids[0]!;
    return this.snapshot(root);
  }
  setTitle(owner: WebContents, id: string, title: string): void {
    const terminal = this.owned(owner, id);
    terminal.snapshot = { ...terminal.snapshot, title: title.trim().slice(0, 80) || "Terminal" };
  }
  disposeWebContents(id: number): void {
    for (const terminal of [...this.terminals.values()])
      if (terminal.owner.id === id)
        this.close(terminal.owner, terminal.snapshot.id).catch((error: unknown) =>
          console.error("[remote terminal] close", error),
        );
  }
  dispose(): void {
    for (const ownerId of new Set(
      [...this.terminals.values()].map((terminal) => terminal.owner.id),
    ))
      this.disposeWebContents(ownerId);
  }

  private root(owner: WebContents, workspaceId: string, sessionId: string): TerminalRoot {
    const target = { workspaceId, sessionId };
    this.resolve(target); // Validate ownership before registering a terminal root.
    const key = `${owner.id}\0${workspaceId}\0${sessionId}`;
    let root = this.roots.get(key);
    if (!root) {
      root = { target, key, ids: [], active: "" };
      this.roots.set(key, root);
    }
    return root;
  }
  private async create(
    owner: WebContents,
    root: TerminalRoot,
    size?: Partial<TerminalSize>,
  ): Promise<void> {
    const id = randomUUID();
    const terminal: OwnedTerminal = {
      owner,
      target: root.target,
      rootKey: root.key,
      size: normalizeSize(size),
      snapshot: {
        id,
        workspaceId: root.target.workspaceId,
        cwd: REMOTE_CWD,
        shell: "/bin/bash",
        title: `Terminal ${root.ids.length + 1}`,
        status: "running",
        replay: "",
        truncated: false,
        exitCode: undefined,
        signal: undefined,
      },
    };
    this.terminals.set(id, terminal);
    root.ids.push(id);
    root.active = id;
    await this.start(terminal);
  }
  private async start(terminal: OwnedTerminal): Promise<void> {
    try {
      const session = this.resolve(terminal.target);
      const connection = await session.use(async (connection) => connection);
      if (terminal.owner.isDestroyed() || !this.terminals.has(terminal.snapshot.id)) return;
      const decoder = new StringDecoder("utf8");
      const handle = connection.worker.openTerminal({
        cwd: REMOTE_CWD,
        env: connection.env,
        ...terminal.size,
        onData: (buffer) => {
          if (terminal.handle !== handle) return;
          const data = decoder.write(buffer);
          const replay = appendTerminalReplay(
            terminal.snapshot.replay,
            data,
            terminal.snapshot.truncated,
          );
          terminal.snapshot = { ...terminal.snapshot, ...replay };
          this.send(terminal, desktopIpc.terminalData, { terminalId: terminal.snapshot.id, data });
        },
      });
      terminal.handle = handle;
      session.retainTerminal(handle.closed);
      handle.closed.then(
        (exitCode) => {
          if (terminal.handle !== handle) return;
          terminal.handle = undefined;
          terminal.snapshot = { ...terminal.snapshot, status: "exited", exitCode: exitCode ?? 0 };
          this.send(terminal, desktopIpc.terminalExit, {
            terminalId: terminal.snapshot.id,
            exitCode: exitCode ?? 0,
          });
        },
        (error: unknown) => {
          if (terminal.handle === handle) {
            terminal.handle = undefined;
            this.fail(terminal, error);
          }
        },
      );
    } catch (error) {
      this.fail(terminal, error);
    }
  }
  private fail(terminal: OwnedTerminal, error: unknown): void {
    const message = String(error);
    terminal.snapshot = {
      ...terminal.snapshot,
      status: "error",
      replay: terminal.snapshot.replay + message + "\r\n",
    };
    this.send(terminal, desktopIpc.terminalError, { terminalId: terminal.snapshot.id, message });
  }
  private owned(owner: WebContents, id: string): OwnedTerminal {
    const terminal = this.terminals.get(id);
    if (!terminal || terminal.owner.id !== owner.id) throw new Error("Unknown terminal session.");
    return terminal;
  }
  private snapshot(root: TerminalRoot): TerminalPanelSnapshot {
    return {
      workspaceId: root.target.workspaceId,
      rootKey: root.key,
      activeSessionId: root.active,
      sessions: root.ids.map((id) => this.terminals.get(id)!.snapshot),
    };
  }
  private send(terminal: OwnedTerminal, channel: string, payload: unknown): void {
    if (!terminal.owner.isDestroyed()) terminal.owner.send(channel, payload);
  }
}
function normalizeSize(size?: Partial<TerminalSize>): TerminalSize {
  return {
    cols: Math.max(10, Math.min(500, Math.trunc(size?.cols ?? 80))),
    rows: Math.max(4, Math.min(200, Math.trunc(size?.rows ?? 24))),
  };
}
