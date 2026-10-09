import path from "node:path";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@pi-gui/pi-sdk-driver";
import type {
  BashOperations,
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import type { WorkspaceRef } from "@pi-gui/session-driver";
import { SANDBOX_STATUS_KEY, type SandboxSessionState } from "../../contracts/sandbox";
import type { GondolinVm } from "./sandbox-gondolin";
import type { SandboxSession, SandboxSessionRef } from "./sandbox-session";

export interface SandboxExtensionHost {
  enabled(): boolean;
  openSession(
    ref: SandboxSessionRef,
    checkoutPath: string,
    onStatus: (state: SandboxSessionState, message?: string) => void,
  ): SandboxSession;
  closeSession(session: SandboxSession): void;
}

const STATUS_TEXT: Record<SandboxSessionState, string> = {
  starting: "Sandbox: starting",
  ready: "Sandbox: on",
  idle: "Sandbox: on",
  failed: "Sandbox: failed",
};

/**
 * Routes pi's built-in read, write, edit and bash tools, and `!` commands, into the session's VM.
 * Pi itself, model calls, MCP servers and other extensions stay on the host.
 */
export function createSandboxExtension(
  workspace: WorkspaceRef,
  host: SandboxExtensionHost,
): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    if (!host.enabled()) {
      pi.on("session_start", (_event, ctx) => ctx.ui.setStatus(SANDBOX_STATUS_KEY, "Sandbox: off"));
      return;
    }
    const cwd = workspace.path;
    let session: SandboxSession | undefined;
    let context: ExtensionContext | undefined;

    const use = <T>(work: (vm: GondolinVm) => Promise<T>): Promise<T> => {
      if (!session) {
        return Promise.reject(new Error("The sandbox is not attached to this thread yet."));
      }
      return session.use(work);
    };

    const fileOps = {
      readFile: (file: string) => use((vm) => vm.fs.readFile(file)),
      writeFile: (file: string, content: string) =>
        use((vm) => vm.fs.writeFile(file, content, { encoding: "utf8" })),
      access: (file: string) => use((vm) => vm.fs.access(file)),
      mkdir: (dir: string) => use((vm) => vm.fs.mkdir(dir, { recursive: true })),
    };
    const bashOps: BashOperations = {
      exec: (command, commandCwd, { onData, signal, timeout }) =>
        use(async (vm) => {
          if (signal?.aborted) throw new Error("aborted");
          const controller = new AbortController();
          const abort = () => controller.abort();
          signal?.addEventListener("abort", abort, { once: true });
          let timedOut = false;
          const timer =
            timeout && timeout > 0
              ? setTimeout(() => {
                  timedOut = true;
                  controller.abort();
                }, timeout * 1000)
              : undefined;
          try {
            const proc = vm.exec(["/bin/bash", "-c", command], {
              cwd: commandCwd,
              signal: controller.signal,
              stdout: "pipe",
              stderr: "pipe",
            });
            for await (const chunk of proc.output()) onData(chunk.data);
            return { exitCode: (await proc).exitCode };
          } catch (error) {
            if (signal?.aborted) throw new Error("aborted");
            if (timedOut) throw new Error(`timeout:${timeout}`);
            throw error;
          } finally {
            if (timer) clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
          }
        }),
    };

    pi.registerTool(createReadToolDefinition(cwd, { operations: fileOps }));
    pi.registerTool(createWriteToolDefinition(cwd, { operations: fileOps }));
    pi.registerTool(createEditToolDefinition(cwd, { operations: fileOps }));
    pi.registerTool(createBashToolDefinition(cwd, { operations: bashOps }));
    // Pi's grep and find launch rg/fd on the host even with custom file operations, and ls offers
    // nothing bash does not, so sandboxed sessions withdraw them; rg, find and ls run in bash.
    pi.registerTool({ ...createGrepToolDefinition(cwd), exposure: "hidden" });
    pi.registerTool({ ...createFindToolDefinition(cwd), exposure: "hidden" });
    pi.registerTool({ ...createLsToolDefinition(cwd), exposure: "hidden" });

    // Returning operations claims every `!` command, so none falls through to the host.
    pi.on("user_bash", () => ({ operations: bashOps }));

    pi.on("session_start", (_event, ctx) => {
      context = ctx;
      if (session) host.closeSession(session);
      session = host.openSession(
        { workspaceId: workspace.workspaceId, sessionId: ctx.sessionManager.getSessionId() },
        cwd,
        (state, message) => context?.ui.setStatus(SANDBOX_STATUS_KEY, statusText(state, message)),
      );
      ctx.ui.setStatus(SANDBOX_STATUS_KEY, statusText(session.state, session.message));
    });

    pi.on("session_shutdown", () => {
      if (session) host.closeSession(session);
      session = undefined;
      context = undefined;
    });

    pi.on("before_agent_start", (event) => {
      session?.setReadonlyMounts(
        (event.systemPromptOptions?.skills ?? []).map((skill) =>
          path.basename(skill.filePath) === "SKILL.md" ? skill.baseDir : skill.filePath,
        ),
      );
      return { systemPrompt: `${event.systemPrompt}\n\n${SANDBOX_PROMPT}` };
    });

    pi.registerCommand("sandbox", {
      description: "Show this thread's sandbox status, or restart it with /sandbox restart",
      handler: async (args, ctx) => {
        if (!session) return;
        if (args.trim() === "restart") {
          await session.restart();
          ctx.ui.notify("The sandbox restarts with the next tool call.", "info");
          return;
        }
        ctx.ui.notify(
          `${statusText(session.state, session.message)}\nMounted: ${session.checkoutPath}`,
          session.state === "failed" ? "error" : "info",
        );
      },
    });
  };
}

function statusText(state: SandboxSessionState, message: string | undefined): string {
  return state === "failed" && message ? `${STATUS_TEXT[state]}: ${message}` : STATUS_TEXT[state];
}

const SANDBOX_PROMPT = `Tool sandbox: the read, write, edit and bash tools run inside a Linux virtual machine (Alpine). The current working directory is mounted at the same path, so file paths are unchanged, and changes there are visible to the user. The rest of the host machine (home directory, other projects, credentials) is not available. Git, ripgrep (rg), gh, node and pnpm are installed; install more with \`apk add\` (it lasts until the sandbox restarts). Use rg, find and ls through bash. Network access may be limited by the user's policy; a blocked request returns HTTP 403 with an explanation, which you should report instead of retrying. GitHub credentials are available to git and gh as placeholders the host fills in.`;
