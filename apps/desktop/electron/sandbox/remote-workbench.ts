import { open } from "node:fs/promises";
import path from "node:path";
import type { SessionRef, TurnCaptureBoundary } from "@pi-gui/session-driver";
import type { ReviewRequestsOwner } from "../ipc/review-requests";
import {
  listWorkspaceFiles,
  readWorkspaceFile,
  type ListWorkspaceFilesOptions,
} from "../platform/files/app-store-files";
import { getChangedFiles, getFileDiff, stageFile } from "../platform/files/app-store-diff";
import { TurnCheckpointStore } from "../workbench/checkpoint-store";
import { ReviewOwner } from "../workbench/review-owner";
import { readProjectSandboxConfig, sandboxSetupScript } from "./sandbox-setup";
import {
  decodeTurnChangesInput,
  decodeGetReviewInput,
  decodeReviewFileInput,
  decodeSetReviewFileReviewedInput,
  decodeChangeReviewFileStageInput,
} from "../../contracts/review";

export type RemoteWorkbenchCalls = {
  [K in keyof ReviewRequestsOwner]: {
    input: Parameters<ReviewRequestsOwner[K]>[0];
    output: Awaited<ReturnType<ReviewRequestsOwner[K]>>;
  };
} & {
  capture: { input: TurnCaptureBoundary; output: void };
  listFiles: { input: ListWorkspaceFilesOptions; output: string[] };
  readFile: { input: { path: string }; output: Awaited<ReturnType<typeof readWorkspaceFile>> };
  changedFiles: { input: null; output: Awaited<ReturnType<typeof getChangedFiles>> };
  fileDiff: { input: { path: string }; output: string };
  stageFile: { input: { path: string; sourcePath?: string }; output: void };
  instructions: { input: null; output: string };
  setup: { input: null; output: string };
};

/** This bundle runs in the guest. Git semantics and capture storage have exactly one implementation. */
export function createRemoteWorkbench(cwd: string, target: SessionRef, statePath: string) {
  const checkpoints = new TurnCheckpointStore(statePath);
  const valid = (ref: SessionRef) =>
    ref.workspaceId === target.workspaceId && ref.sessionId === target.sessionId;
  const review = new ReviewOwner({
    userDataDir: statePath,
    checkpoints,
    validateTask: valid,
    resolveCheckoutPath: (id) => (id === target.workspaceId ? cwd : undefined),
  });
  return async (action: string, rawInput: unknown, signal?: AbortSignal): Promise<unknown> => {
    switch (action) {
      case "getReview":
        return review.getReview(decodeGetReviewInput(rawInput));
      case "getTurnChanges":
        return review.getTurnChanges(decodeTurnChangesInput(rawInput));
      case "getReviewFile":
        return review.getReviewFile(decodeReviewFileInput(rawInput));
      case "setReviewFileReviewed":
        return review.setReviewFileReviewed(decodeSetReviewFileReviewedInput(rawInput));
      case "changeReviewFileStage":
        return review.changeReviewFileStage(decodeChangeReviewFileStageInput(rawInput));
      case "capture": {
        const boundary = rawInput as TurnCaptureBoundary;
        if (!valid(boundary.sessionRef)) throw new Error("Capture belongs to another thread.");
        return checkpoints.recordBoundary(
          { ...boundary, workspace: { ...boundary.workspace, path: cwd } },
          signal ?? new AbortController().signal,
        );
      }
      case "listFiles":
        return listWorkspaceFiles(cwd, rawInput as ListWorkspaceFilesOptions);
      case "readFile":
        return readWorkspaceFile(cwd, fileInput(rawInput).path);
      case "changedFiles":
        return getChangedFiles(cwd);
      case "fileDiff":
        return getFileDiff(cwd, fileInput(rawInput).path);
      case "stageFile":
        return stageFile(cwd, fileInput(rawInput).path, fileInput(rawInput));
      case "instructions": {
        const sections = await Promise.all(
          ["AGENTS.md", "CLAUDE.md"].map(async (name) => {
            try {
              const file = await open(path.join(cwd, name), "r");
              try {
                const buffer = Buffer.alloc(64 * 1024);
                const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
                return buffer.subarray(0, bytesRead).toString("utf8");
              } finally {
                await file.close();
              }
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
              throw error;
            }
          }),
        );
        return [...new Set(sections)].filter(Boolean).join("\n\n");
      }
      case "setup":
        return sandboxSetupScript(await readProjectSandboxConfig(cwd));
      default:
        throw new Error(`Unknown workbench operation: ${action}`);
    }
  };
}

function fileInput(value: unknown): { path: string; sourcePath?: string } {
  if (!value || typeof value !== "object" || !("path" in value) || typeof value.path !== "string")
    throw new Error("Expected a file path.");
  const sourcePath = "sourcePath" in value ? value.sourcePath : undefined;
  if (sourcePath !== undefined && typeof sourcePath !== "string")
    throw new Error("Expected a source path.");
  return { path: value.path, ...(sourcePath ? { sourcePath } : {}) };
}
