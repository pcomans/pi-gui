import type { KitClient } from "@vercel/kit";
import { KitError } from "@vercel/kit";
import { expect, test } from "@playwright/test";
import { kitTools } from "../../electron/kit/kit-tools";
import { KitOwner } from "../../electron/kit/kit-owner";

async function toolsFor(run: KitClient["run"]) {
  const owner = new KitOwner({
    userDataDir: "/unused",
    encrypt: () => Buffer.alloc(0),
    decrypt: () => "",
  });
  owner.requireClient = () => ({ run }) as KitClient;
  return new Map(kitTools(owner).map((tool) => [tool.name, tool]));
}

test("Kit tools cannot expose Gateway keys, approve access, or claim in-app approval", async () => {
  let calls = 0;
  const tools = await toolsFor(async () => {
    calls++;
    return {};
  });
  expect(tools.has("kit_get_ai_gateway_key")).toBe(false);
  expect(tools.has("kit_approve_access")).toBe(false);
  const tool = tools.get("kit_call")!;
  await expect(
    tool.execute(
      "fixture",
      { service: "github", capability: "create_issue", approved: true },
      undefined,
      undefined,
      {} as never,
    ),
  ).rejects.toThrow("Approve this action on Kit");
  expect(calls).toBe(0);
});

test("Kit permission blockers retain their approval URL as a normal tool result", async () => {
  const blocker = {
    status: "consent_required",
    request: "fixture-request",
    approveUrl: "https://kit.vercel.sh/approve/fixture",
  };
  const tools = await toolsFor(async () => {
    throw new KitError(403, blocker);
  });
  const result = await tools
    .get("kit_call")!
    .execute(
      "fixture",
      { service: "github", capability: "create_issue" },
      undefined,
      undefined,
      {} as never,
    );
  expect(result.content).toEqual([{ type: "text", text: JSON.stringify(blocker) }]);
});

test("Stop returns from a pending Kit call without repeating the cloud action", async () => {
  let calls = 0;
  let finish!: (value: unknown) => void;
  const operation = new Promise<unknown>((resolve) => {
    finish = resolve;
  });
  const tools = await toolsFor(() => {
    calls++;
    return operation;
  });
  const signal = new AbortController();
  const result = tools
    .get("kit_load_kit")!
    .execute("fixture", {}, signal.signal, undefined, {} as never);
  signal.abort();
  await expect(result).rejects.toThrow("may still finish in Kit");
  expect(calls).toBe(1);
  finish({ completed: true });
});
