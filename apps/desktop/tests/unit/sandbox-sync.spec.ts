import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import {
  decodeInventory,
  localInventory,
  SandboxCheckoutSync,
  syncPath,
} from "../../electron/sandbox/sandbox-sync";
import type { WorkerExecOptions } from "../../electron/sandbox/sandbox-worker";

const execFileAsync = promisify(execFile);

async function fixture() {
  // Retain scratch files and recovery evidence, including on failed assertions.
  const directory = await mkdtemp(path.join(tmpdir(), "pi-gui-sandbox-sync-"));
  const local = path.join(directory, "local");
  const remote = path.join(directory, "remote");
  const state = path.join(directory, "state");
  for (const root of [local, remote]) {
    await mkdir(root);
    await execFileAsync("git", ["init", "-q", root]);
  }
  const guestPath = (file: string) =>
    file === local ? remote : syncPath(remote, path.relative(local, file));
  const worker = {
    readFile: (file: string) => readFile(guestPath(file)),
    writeFile: (file: string, content: string | Buffer) => writeFile(guestPath(file), content),
    writeFiles: async (
      files: readonly { path: string; content: Buffer; mode: number; link?: string }[],
    ) => {
      for (const file of files) {
        const destination = guestPath(file.path);
        await mkdir(path.dirname(destination), { recursive: true });
        if (file.link !== undefined) await symlink(file.link, destination);
        else {
          await writeFile(destination, file.content);
          await chmod(destination, file.mode);
        }
      }
    },
    mkdir: async (file: string) => {
      await mkdir(guestPath(file), { recursive: true });
    },
    exec: async (argv: readonly string[], options: WorkerExecOptions) => {
      const args = argv
        .slice(1)
        .map((arg) =>
          arg === local ? remote : arg.startsWith(`${local}/`) ? guestPath(arg) : arg,
        );
      const result = await execFileAsync(argv[0]!, args, {
        cwd: remote,
        env: { ...process.env, ...options.env },
      });
      options.onData?.(Buffer.from(result.stdout));
      return { exitCode: 0 };
    },
  };
  const sync = new SandboxCheckoutSync(local, state);
  return { directory, local, remote, state, worker, sync };
}

test("sync preserves binary files, executable modes, local edits and remote changes across restart", async () => {
  const f = await fixture();
  await writeFile(path.join(f.local, ".gitignore"), "ignored/\n");
  await writeFile(path.join(f.local, "notes.txt"), "initial");
  await symlink("notes.txt", path.join(f.local, "CLAUDE.md"));
  await mkdir(path.join(f.local, "ignored"));
  await writeFile(path.join(f.local, "ignored", "secret.txt"), "stay local");
  await f.sync.seed(f.worker);
  await expect(readFile(path.join(f.remote, "ignored", "secret.txt"))).rejects.toThrow();

  const binary = Buffer.from([0, 255, 10, 128, 1]);
  const hostileName = "it's $(touch escaped); file.bin";
  await writeFile(path.join(f.remote, hostileName), binary);
  await chmod(path.join(f.remote, hostileName), 0o755);
  await writeFile(path.join(f.local, "local.txt"), "local editor");
  await f.sync.reconcile(f.worker);
  expect(await readFile(path.join(f.local, hostileName))).toEqual(binary);
  expect((await stat(path.join(f.local, hostileName))).mode & 0o111).toBeTruthy();
  expect(await readFile(path.join(f.remote, "local.txt"), "utf8")).toBe("local editor");
  await expect(readFile(path.join(f.local, "escaped"))).rejects.toThrow();

  const resumed = new SandboxCheckoutSync(f.local, f.state);
  expect(await resumed.load()).toBe(true);
  await unlink(path.join(f.remote, "notes.txt"));
  await resumed.reconcile(f.worker);
  await expect(readFile(path.join(f.local, "notes.txt"))).rejects.toThrow();
  const backups = await readdir(path.join(f.state, "recovery"), { recursive: true });
  expect(backups.some((name) => name.endsWith("notes.txt"))).toBe(true);
});

test("concurrent edits and edit/delete conflicts retain local bytes and save remote recovery", async () => {
  const f = await fixture();
  await writeFile(path.join(f.local, "notes.txt"), "initial");
  await writeFile(path.join(f.local, "deleted.txt"), "initial");
  await f.sync.seed(f.worker);
  await writeFile(path.join(f.local, "notes.txt"), "local edit");
  await writeFile(path.join(f.remote, "notes.txt"), "remote edit");
  await writeFile(path.join(f.local, "deleted.txt"), "keep local");
  await unlink(path.join(f.remote, "deleted.txt"));
  await expect(f.sync.reconcile(f.worker)).rejects.toThrow("Sandbox sync conflict");
  expect(await readFile(path.join(f.local, "notes.txt"), "utf8")).toBe("local edit");
  expect(await readFile(path.join(f.local, "deleted.txt"), "utf8")).toBe("keep local");
  const [recovery] = await readdir(path.join(f.state, "recovery"));
  expect(await readFile(path.join(f.state, "recovery", recovery!, "notes.txt"), "utf8")).toBe(
    "remote edit",
  );
  // Matching the remote version resolves the conflict without losing either saved version.
  await writeFile(path.join(f.local, "notes.txt"), "remote edit");
  await unlink(path.join(f.local, "deleted.txt"));
  await f.sync.reconcile(f.worker);
});

test("inventory rejects symlinks and unsafe paths, and a corrupt baseline is retained", async () => {
  const f = await fixture();
  await writeFile(path.join(f.directory, "outside.txt"), "private");
  await symlink(path.join(f.directory, "outside.txt"), path.join(f.local, "link.txt"));
  await expect(localInventory(f.local)).rejects.toThrow("does not sync symlinks outside");
  for (const relative of ["../outside.txt", "/tmp/outside.txt", ".git/config", "a/../../b"]) {
    expect(() => syncPath(f.local, relative)).toThrow();
  }
  expect(() =>
    decodeInventory(
      ["notes.txt", "NOTES.txt"].map((name) => ({ path: name, hash: "a".repeat(64), mode: 0o644 })),
    ),
  ).toThrow("collide on a case-insensitive filesystem");
  await mkdir(f.state);
  await writeFile(path.join(f.state, "baseline.json"), "corrupt original");
  await expect(f.sync.load()).rejects.toThrow("retained original data");
  expect(await readFile(path.join(f.state, "baseline.json"), "utf8")).toBe("corrupt original");
});
