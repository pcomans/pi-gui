import assert from "node:assert/strict";
import { test } from "node:test";
import { PhotonImage } from "@silvia-odwyer/photon-node";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createSandboxExtension } from "../../electron/sandbox/sandbox-extension";
import type { SandboxConnection, ToolSandboxSession } from "../../electron/sandbox/sandbox-session";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGP478AARwzEcQAWohPx03ZM6QAAAABJRU5ErkJggg==",
  "base64",
);
const image = PhotonImage.new_from_byteslice(png);
const jpeg = Buffer.from(image.get_bytes_jpeg(90));
image.free();

async function sandboxRead(files: ReadonlyMap<string, Buffer>) {
  const tools = new Map<string, ToolDefinition>();
  let start: ((event: unknown, ctx: ExtensionContext) => unknown) | undefined;
  const readFile = async (file: string, maxBytes?: number) => {
    const bytes = files.get(file);
    if (!bytes) throw new Error(`ENOENT: ${file}`);
    return maxBytes === undefined ? bytes : bytes.subarray(0, maxBytes);
  };
  const connection = {
    worker: {
      readFile,
      access: async (file: string) => {
        await readFile(file);
      },
    },
    env: {},
  } as unknown as SandboxConnection;
  const session = {
    state: "idle",
    use: <T>(work: (connection: SandboxConnection) => Promise<T>) => work(connection),
  } as unknown as ToolSandboxSession;
  const api = {
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    on: (event: string, handler: typeof start) => {
      if (event === "session_start") start = handler;
    },
    registerCommand: () => undefined,
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: "/sandbox-only",
    sessionManager: { getSessionId: () => "image-test" },
    ui: { setStatus: () => undefined },
  } as unknown as ExtensionContext;
  const extension = createSandboxExtension(
    { workspaceId: "image-test", path: ctx.cwd },
    { openSession: () => session, closeSession: () => undefined },
  );
  await extension(api);
  await start!(undefined, ctx);
  return (path: string) =>
    tools.get("read")!.execute("read-test", { path }, undefined, undefined, ctx);
}

for (const [name, bytes, mimeType] of [
  ["png", png, "image/png"],
  ["jpeg", jpeg, "image/jpeg"],
] as const) {
  await test(`sandbox read returns a ${name} image attachment, even without an image extension`, async () => {
    const read = await sandboxRead(new Map([["/sandbox-only/frame.bin", bytes]]));
    const result = await read("frame.bin");
    const attachment = result.content.find((part) => part.type === "image");
    assert.ok(attachment, "read must return image content instead of decoding binary as text");
    assert.equal(attachment.mimeType, mimeType);
    assert.equal(Buffer.from(attachment.data, "base64").compare(bytes), 0);
  });
}

await test("sandbox read keeps text with an image extension as text", async () => {
  const read = await sandboxRead(
    new Map([["/sandbox-only/notes.jpg", Buffer.from("ordinary text\n")]]),
  );
  assert.deepEqual((await read("notes.jpg")).content, [{ type: "text", text: "ordinary text\n" }]);
});

await test("sandbox read rejects a missing file instead of reading the host", async () => {
  const read = await sandboxRead(new Map());
  await assert.rejects(read("missing.jpg"), /ENOENT/);
});
