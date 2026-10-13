import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { createRemoteWorkbench } from "../../electron/sandbox/remote-workbench";
import { prepareRemoteRepository, repositoryUrl } from "../../electron/workspace/remote-repository";
import type { ReviewResult, ReviewFileResult, TurnChangesResult } from "../../contracts/review";

const git = promisify(execFile);

test("repository registration creates only stable Pi metadata and rejects credentials and local paths", async () => {
  const profile = await mkdtemp(path.join(tmpdir(), "pi-remote-metadata-"));
  const first = await prepareRemoteRepository(
    profile,
    "https://github.com/octocat/Hello-World.git/",
  );
  const again = await prepareRemoteRepository(profile, "https://github.com/octocat/Hello-World");
  expect(first).toEqual(again);
  expect(await readdir(first.path)).toEqual([]);
  for (const invalid of [
    "/Users/me/repo",
    "file:///tmp/repo",
    "https://token@github.com/owner/repo",
    "https://github.com/owner/repo?token=secret",
    "https://github.com/",
  ])
    expect(() => repositoryUrl(invalid)).toThrow();
});

test("guest Review, staging and turn captures use the remote root despite a nonexistent host cwd", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "pi-remote-workbench-"));
  const remote = path.join(fixture, "guest");
  await mkdir(remote);
  await writeFile(path.join(remote, "notes.txt"), "BASE\n");
  await git("git", ["init", "-q", remote]);
  await git("git", ["add", "notes.txt"], { cwd: remote });
  await git(
    "git",
    ["-c", "user.name=test", "-c", "user.email=test@localhost", "commit", "-qm", "base"],
    { cwd: remote },
  );
  const target = { workspaceId: "cloud-repo", sessionId: "cloud-thread" };
  const service = createRemoteWorkbench(remote, target, path.join(fixture, "guest-state"));
  const opening = {
    checkpointId: "checkpoint",
    beforeEntryId: null,
    startedAt: new Date().toISOString(),
  };
  const boundary = {
    sessionRef: target,
    workspace: { workspaceId: target.workspaceId, path: "/nonexistent/host/metadata" },
    runtimeGeneration: "generation",
    runId: "run",
    timestamp: opening.startedAt,
  };
  await service("capture", { ...boundary, opening });
  await writeFile(path.join(remote, "notes.txt"), "REMOTE\n");
  await service("capture", {
    ...boundary,
    closing: {
      ...opening,
      userEntryIds: ["user"],
      assistantEntryIds: ["assistant"],
      lastEntryId: "assistant",
      outcome: "completed",
      reason: "settled",
    },
  });
  const review = (await service("getReview", {
    target,
    checkoutId: target.workspaceId,
    scope: { kind: "uncommitted" },
  })) as ReviewResult;
  expect(review.state).toBe("available");
  if (review.state !== "available") throw new Error(review.message);
  const file = review.files[0]!;
  const patch = (await service("getReviewFile", {
    reviewId: review.reviewId,
    fileId: file.id,
  })) as ReviewFileResult;
  expect(patch.state === "available" && patch.patch).toContain("+REMOTE");
  expect(
    await service("changeReviewFileStage", {
      reviewId: review.reviewId,
      fileId: file.id,
      action: "stage",
    }),
  ).toEqual({ state: "applied" });
  expect((await git("git", ["diff", "--cached"], { cwd: remote })).stdout).toContain("+REMOTE");
  const turns = (await service("getTurnChanges", { target })) as TurnChangesResult;
  expect(turns.state === "available" && turns.turns[0]?.files[0]?.path).toBe("notes.txt");
  const captured = (await service("getReview", {
    target,
    checkoutId: target.workspaceId,
    scope: { kind: "turn" },
  })) as ReviewResult;
  expect(captured.state).toBe("available");
  await writeFile(path.join(remote, "notes.txt"), "AFTER_REVIEW\n");
  const stale = (await service("getReviewFile", {
    reviewId: review.reviewId,
    fileId: file.id,
  })) as ReviewFileResult;
  expect(stale.state).toBe("stale");
  expect(await readFile(path.join(remote, "notes.txt"), "utf8")).toBe("AFTER_REVIEW\n");
  expect(
    await service("getReview", {
      target: { ...target, sessionId: "other" },
      checkoutId: target.workspaceId,
      scope: { kind: "uncommitted" },
    }),
  ).toMatchObject({ state: "unavailable", code: "task-unavailable" });
});
