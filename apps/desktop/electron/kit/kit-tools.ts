import { KIT_TOOLS, KitError, isBlocker, toolServed } from "@vercel/kit";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TUnsafe } from "typebox";
import type { KitOwner } from "./kit-owner";

export const KIT_AGENT_SCOPES = ["connections", "gateway", "skills"];

/** Adapt Kit's published table, retaining its cloud permissions and continuation URLs. */
export function kitTools(owner: KitOwner): ToolDefinition<TUnsafe<Record<string, unknown>>>[] {
  return KIT_TOOLS.filter(
    (tool) => toolServed(tool.name, KIT_AGENT_SCOPES) && tool.verb !== "gateway-key",
  ).map((tool) => ({
    name: `kit_${tool.name}`,
    label: `Kit: ${tool.name.replaceAll("_", " ")}`,
    description: `${tool.description} Approvals happen on Kit's approval page; in-app approval is unavailable.`,
    parameters: Type.Unsafe<Record<string, unknown>>(tool.input),
    execute: async (_id, input, signal) => {
      if (signal?.aborted) throw new Error("Kit call cancelled before dispatch.");
      if (input.approved === true)
        throw new Error(
          "Approve this action on Kit's approval page. In-app Kit approvals are not implemented.",
        );
      let value: unknown;
      try {
        value = await waitForKit(owner.requireClient().run(tool.name, input), signal);
      } catch (error) {
        if (!(error instanceof KitError) || !isBlocker(error.body)) throw error;
        value = error.body;
      }
      return {
        content: [
          { type: "text", text: typeof value === "string" ? value : JSON.stringify(value) },
        ],
        details: {},
      };
    },
  }));
}

/** Stop releases Pi's turn; Kit has no cancellation API for an already dispatched call. */
export function waitForKit<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  return new Promise((resolve, reject) => {
    const abort = () =>
      reject(
        new Error(
          "Kit call cancelled. It may still finish in Kit; check its outcome before retrying.",
        ),
      );
    signal.addEventListener("abort", abort, { once: true });
    operation
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort))
      .catch(() => undefined);
    if (signal.aborted) abort();
  });
}
