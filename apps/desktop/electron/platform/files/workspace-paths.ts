import { realpath } from "node:fs/promises";
import path from "node:path";

export function resolveWorkspacePath(workspacePath: string, filePath: string): string {
  const workspaceRoot = path.resolve(workspacePath);
  const resolved = path.resolve(workspaceRoot, filePath);
  assertInsideWorkspace(workspaceRoot, resolved);
  return resolved;
}

export async function resolveExistingWorkspacePath(
  workspacePath: string,
  filePath: string,
): Promise<string> {
  return (await resolveExistingWorkspaceEntry(workspacePath, filePath)).path;
}

/**
 * The real path of an existing entry inside the workspace, and that path relative to the
 * workspace. The relative path is taken from the workspace's real path, so a folder opened
 * through a symlink (macOS `/var` or `/tmp`, a linked `~/code`) still yields `src/a.ts`.
 */
export async function resolveExistingWorkspaceEntry(
  workspacePath: string,
  filePath: string,
): Promise<{ readonly path: string; readonly relativePath: string }> {
  const resolved = resolveWorkspacePath(workspacePath, filePath);
  const [realWorkspaceRoot, realTarget] = await Promise.all([
    realpath(path.resolve(workspacePath)),
    realpath(resolved),
  ]);
  assertInsideWorkspace(realWorkspaceRoot, realTarget);
  return { path: realTarget, relativePath: path.relative(realWorkspaceRoot, realTarget) };
}

function assertInsideWorkspace(workspaceRoot: string, candidate: string): void {
  const relative = path.relative(workspaceRoot, candidate);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return;
  }
  throw new Error("Path escapes workspace");
}
