import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { SandboxWorker } from "./sandbox-worker";

const execFileAsync = promisify(execFile);
const MAX_FILES = 10_000;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
type SyncWorker = Pick<SandboxWorker, "exec" | "mkdir" | "readFile" | "writeFile" | "writeFiles">;

export interface SyncedFile {
  readonly path: string;
  readonly hash: string;
  readonly mode: number;
  readonly link?: string;
}

function checkLink(name: string, link: string): void {
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(name), link));
  if (path.isAbsolute(link) || target === ".." || target.startsWith("../"))
    throw new Error(`Sandbox symlink leaves the checkout: ${name}`);
  syncPath("/", target);
}

export function syncPath(root: string, relative: string): string {
  if (
    !relative ||
    path.isAbsolute(relative) ||
    relative.includes("\\") ||
    relative
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          [".git", "node_modules", ".context", ".artifacts"].includes(part),
      )
  )
    throw new Error(`Unsupported sandbox sync path: ${relative}`);
  return path.join(root, relative);
}

/** Runs unchanged on the host and guest; never follows file or directory symlinks. */
export const INVENTORY_SOURCE = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const root = process.argv[1];
const extra = JSON.parse(process.argv[2]);
const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
for (const key of Object.keys(env)) if (key.startsWith("GIT_") && !["GIT_OPTIONAL_LOCKS", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL"].includes(key)) delete env[key];
const listed = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, env, maxBuffer: 4 * 1024 * 1024 }).toString().split("\0").filter(Boolean);
const files = [];
let total = 0;
for (const relative of [...new Set([...listed, ...extra])].sort()) {
  const parts = relative.split("/");
  if (parts.some((p) => [".git", "node_modules", ".context", ".artifacts"].includes(p))) continue;
  if (path.isAbsolute(relative) || relative.includes("\\") || parts.some((p) => !p || p === "." || p === "..")) throw new Error("Unsafe sync path: " + relative);
  let candidate = root, stat;
  try {
    for (const [index, part] of parts.entries()) {
      candidate = path.join(candidate, part);
      stat = fs.lstatSync(candidate);
      if (stat.isSymbolicLink() && index !== parts.length - 1) throw new Error("Vercel POC does not sync directory symlinks: " + relative);
    }
  } catch (error) { if (error.code === "ENOENT") continue; throw error; }
  let link;
  if (stat.isSymbolicLink()) {
    link = fs.readlinkSync(candidate);
    const target = path.resolve(path.dirname(candidate), link);
    if (path.isAbsolute(link) || !target.startsWith(root + path.sep)) throw new Error("Vercel POC does not sync symlinks outside the checkout: " + relative);
    if (fs.existsSync(target) && !fs.realpathSync(target).startsWith(fs.realpathSync(root) + path.sep)) throw new Error("Vercel POC does not sync symlinks outside the checkout: " + relative);
  } else if (!stat.isFile()) throw new Error("Vercel POC requires ordinary files: " + relative);
  if (stat.size > ${MAX_FILE_BYTES} || (total += stat.size) > ${MAX_BYTES} || files.length >= ${MAX_FILES}) throw new Error("Vercel POC sync limit exceeded (10,000 files, 64 MiB total, 16 MiB per file)");
  files.push({ path: relative, hash: createHash("sha256").update(link === undefined ? fs.readFileSync(candidate) : Buffer.from(link)).digest("hex"), mode: link === undefined && (stat.mode & 0o111) ? 0o755 : 0o644, ...(link === undefined ? {} : { link }) });
}
process.stdout.write(JSON.stringify(files));
`;

export function decodeInventory(value: unknown): SyncedFile[] {
  if (!Array.isArray(value) || value.length > MAX_FILES) throw new Error("Invalid sync inventory");
  const paths = new Set<string>();
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== "object") throw new Error("Invalid sync file");
    const file = entry as Record<string, unknown>;
    if (
      typeof file.path !== "string" ||
      typeof file.hash !== "string" ||
      !/^[a-f0-9]{64}$/.test(file.hash) ||
      (file.mode !== 0o644 && file.mode !== 0o755)
    ) {
      throw new Error("Invalid sync file");
    }
    syncPath("/", file.path);
    if (file.link !== undefined) {
      if (typeof file.link !== "string") throw new Error("Invalid sync symlink");
      checkLink(file.path, file.link);
    }
    // Linux can create names that address the same file on the user's macOS filesystem.
    const portablePath = file.path.normalize("NFC").toLowerCase();
    if (paths.has(portablePath))
      throw new Error("Sandbox sync paths collide on a case-insensitive filesystem");
    paths.add(portablePath);
    return {
      path: file.path,
      hash: file.hash,
      mode: file.mode,
      ...(typeof file.link === "string" ? { link: file.link } : {}),
    };
  });
}

export async function localInventory(
  root: string,
  extra: readonly string[] = [],
): Promise<SyncedFile[]> {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["-e", INVENTORY_SOURCE, root, JSON.stringify(extra)],
    {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  return decodeInventory(JSON.parse(stdout));
}

export async function remoteInventory(
  worker: SyncWorker,
  root: string,
  extra: readonly string[] = [],
): Promise<SyncedFile[]> {
  let output = "";
  const result = await worker.exec(["node", "-e", INVENTORY_SOURCE, root, JSON.stringify(extra)], {
    cwd: root,
    onData: (data) => {
      output += data.toString();
    },
  });
  if (result.exitCode !== 0) throw new Error(`Sandbox inventory failed: ${output.slice(-2000)}`);
  return decodeInventory(JSON.parse(output));
}

function same(a: SyncedFile | undefined, b: SyncedFile | undefined): boolean {
  return a?.hash === b?.hash && a?.mode === b?.mode && a?.link === b?.link;
}

export function planSync(
  base: readonly SyncedFile[],
  local: readonly SyncedFile[],
  remote: readonly SyncedFile[],
) {
  const b = new Map(base.map((f) => [f.path, f]));
  const l = new Map(local.map((f) => [f.path, f]));
  const r = new Map(remote.map((f) => [f.path, f]));
  const push: string[] = [],
    pull: string[] = [],
    conflicts: string[] = [];
  for (const name of new Set([...b.keys(), ...l.keys(), ...r.keys()])) {
    if (same(l.get(name), r.get(name))) continue;
    if (same(b.get(name), l.get(name))) pull.push(name);
    else if (same(b.get(name), r.get(name))) push.push(name);
    else conflicts.push(name);
  }
  return { push, pull, conflicts };
}

async function safeLocalPath(root: string, name: string): Promise<string> {
  const file = syncPath(root, name);
  let current = root;
  for (const part of name.split("/")) {
    current = path.join(current, part);
    const stat = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (stat?.isSymbolicLink()) {
      if (current !== file)
        throw new Error(`Refusing sandbox sync through directory symlink: ${name}`);
      checkLink(name, await readlink(current));
    }
  }
  return file;
}

async function localBytes(root: string, name: string): Promise<Buffer | undefined> {
  const file = await safeLocalPath(root, name);
  try {
    return (await lstat(file)).isSymbolicLink()
      ? Buffer.from(await readlink(file))
      : await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export class SandboxCheckoutSync {
  private base: SyncedFile[] = [];
  private loaded = false;

  constructor(
    readonly root: string,
    private readonly directory: string,
  ) {}

  async load(): Promise<boolean> {
    if (this.loaded) return true;
    try {
      this.base = decodeInventory(
        JSON.parse(await readFile(path.join(this.directory, "baseline.json"), "utf8")),
      );
      this.loaded = true;
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw new Error(
        `Sandbox sync baseline could not be read; retained original data: ${String(error)}`,
      );
    }
  }

  /** New guests start empty; the caller supplies a standalone git repository first. */
  async seed(worker: SyncWorker): Promise<void> {
    const files = await localInventory(this.root);
    const upload = [];
    for (const file of files) {
      const content = await localBytes(this.root, file.path);
      if (!content || createHash("sha256").update(content).digest("hex") !== file.hash)
        throw new Error(`Local file changed during sandbox upload: ${file.path}`);
      upload.push({
        path: syncPath(this.root, file.path),
        content,
        mode: file.mode,
        ...(file.link === undefined ? {} : { link: file.link }),
      });
    }
    await worker.writeFiles(upload);
    await this.save(files);
  }

  async reconcile(worker: SyncWorker): Promise<void> {
    const extra = this.base.map((f) => f.path);
    const local = await localInventory(this.root, extra);
    const remote = await remoteInventory(worker, this.root, extra);
    const plan = planSync(this.base, local, remote);
    const remoteMap = new Map(remote.map((f) => [f.path, f]));
    const localMap = new Map(local.map((f) => [f.path, f]));
    if (plan.conflicts.length) {
      const recovery = path.join(this.directory, "recovery", randomUUID());
      for (const name of plan.conflicts) {
        if (!remoteMap.has(name)) continue;
        const destination = syncPath(recovery, name);
        await mkdir(path.dirname(destination), { recursive: true });
        const entry = remoteMap.get(name)!;
        await writeFile(
          destination,
          entry.link === undefined
            ? await worker.readFile(syncPath(this.root, name))
            : Buffer.from(entry.link),
        );
      }
      await mkdir(recovery, { recursive: true });
      await writeFile(path.join(recovery, "conflicts.json"), JSON.stringify(plan.conflicts));
      throw new Error(
        `Sandbox sync conflict: ${plan.conflicts.join(", ")}. Local files were retained; remote versions are saved in ${recovery}. Resolve by making the local and remote versions agree, then retry.`,
      );
    }
    for (const name of plan.push) await this.push(worker, name, localMap.get(name));
    for (const name of plan.pull) {
      const file = await safeLocalPath(this.root, name);
      const previous = localMap.get(name);
      const existing = await localBytes(this.root, name);
      if (
        (existing ? createHash("sha256").update(existing).digest("hex") : undefined) !==
        previous?.hash
      ) {
        throw new Error(
          `Local file changed during sandbox sync: ${name}. Retry after reviewing the local edit.`,
        );
      }
      if (existing) {
        const backup = syncPath(path.join(this.directory, "recovery", randomUUID()), name);
        await mkdir(path.dirname(backup), { recursive: true });
        await writeFile(backup, existing);
      }
      const next = remoteMap.get(name);
      if (next) {
        const content =
          next.link === undefined
            ? await worker.readFile(syncPath(this.root, name))
            : Buffer.from(next.link);
        if (
          content.length > MAX_FILE_BYTES ||
          createHash("sha256").update(content).digest("hex") !== next.hash
        ) {
          throw new Error(`Remote file changed during sandbox sync: ${name}`);
        }
        await mkdir(path.dirname(file), { recursive: true });
        if (existing && (previous?.link !== undefined || next.link !== undefined))
          await unlink(file);
        if (next.link !== undefined) await symlink(next.link, file);
        else {
          await writeFile(file, content);
          await chmod(file, next.mode);
        }
      } else if (existing) await unlink(file);
    }
    const merged = new Map(localMap);
    for (const name of plan.pull) {
      const file = remoteMap.get(name);
      if (file) merged.set(name, file);
      else merged.delete(name);
    }
    await this.save([...merged.values()]);
  }

  private async push(
    worker: SyncWorker,
    name: string,
    file: SyncedFile | undefined,
  ): Promise<void> {
    const destination = syncPath(this.root, name);
    if (file) {
      const content = await localBytes(this.root, name);
      if (
        !content ||
        content.length > MAX_FILE_BYTES ||
        createHash("sha256").update(content).digest("hex") !== file.hash
      ) {
        throw new Error(`Local file changed during sandbox upload: ${name}`);
      }
      await worker.mkdir(path.dirname(destination));
      const removed = await worker.exec(["rm", "-f", "--", destination], { cwd: this.root });
      if (removed.exitCode !== 0) throw new Error(`Could not replace remote file: ${name}`);
      if (file.link === undefined) await worker.writeFile(destination, content);
    }
    const result = await worker.exec(
      file?.link !== undefined
        ? ["ln", "-s", "--", file.link, destination]
        : file
          ? ["chmod", file.mode.toString(8), destination]
          : ["rm", "-f", "--", destination],
      { cwd: this.root },
    );
    if (result.exitCode !== 0) throw new Error(`Sandbox file sync failed: ${name}`);
  }

  private async save(files: SyncedFile[]): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const target = path.join(this.directory, "baseline.json");
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(files));
    await rename(temporary, target);
    this.base = files;
    this.loaded = true;
  }
}
