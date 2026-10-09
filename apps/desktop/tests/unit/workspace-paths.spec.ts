import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  resolveExistingWorkspaceEntry,
  resolveExistingWorkspacePath,
  resolveWorkspacePath,
} from "../../electron/platform/files/workspace-paths";

test("rejects relative paths that escape the workspace before reveal", async () => {
  const workspacePath = join(await mkdtemp(join(tmpdir(), "pi-gui-path-")), "safe");
  await mkdir(workspacePath, { recursive: true });
  await writeFile(join(workspacePath, "keep.txt"), "ok\n", "utf8");

  expect(() => resolveWorkspacePath(workspacePath, "../secret.txt")).toThrow(
    "Path escapes workspace",
  );
  await expect(resolveExistingWorkspacePath(workspacePath, "../secret.txt")).rejects.toThrow(
    "Path escapes workspace",
  );
});

test("resolves an existing file inside the workspace", async () => {
  const workspacePath = join(await mkdtemp(join(tmpdir(), "pi-gui-path-")), "safe");
  await mkdir(workspacePath, { recursive: true });
  await writeFile(join(workspacePath, "keep.txt"), "ok\n", "utf8");
  const resolved = await resolveExistingWorkspacePath(workspacePath, "keep.txt");
  expect(resolved).toBe(await realpath(join(workspacePath, "keep.txt")));
});

test("resolves a workspace-relative path when the workspace is opened through a symlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-gui-path-"));
  const realWorkspace = join(root, "safe");
  await mkdir(join(realWorkspace, "src"), { recursive: true });
  await writeFile(join(realWorkspace, "src", "keep.txt"), "ok\n", "utf8");
  await writeFile(join(root, "secret.txt"), "no\n", "utf8");
  const linkedWorkspace = join(root, "linked");
  await symlink(realWorkspace, linkedWorkspace, "junction");

  expect(await resolveExistingWorkspaceEntry(linkedWorkspace, "src/keep.txt")).toEqual({
    path: await realpath(join(realWorkspace, "src", "keep.txt")),
    relativePath: join("src", "keep.txt"),
  });
  await expect(resolveExistingWorkspaceEntry(linkedWorkspace, "../secret.txt")).rejects.toThrow(
    "Path escapes workspace",
  );
});
