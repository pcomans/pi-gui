import { kitInstructions } from "@vercel/kit";
import { vercelAIGatewayProvider } from "@pi-gui/pi-sdk-driver";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { KIT_PROVIDER_ID } from "../../contracts/kit";
import type { KitOwner } from "./kit-owner";
import { KIT_AGENT_SCOPES, kitTools, waitForKit } from "./kit-tools";

/** Thin adaptation of Kit's published tool table and Pi's native Gateway provider. */
export function createKitExtension(owner: KitOwner): ExtensionFactory {
  return (pi) => {
    const gateway = vercelAIGatewayProvider();
    pi.registerProvider({
      ...gateway,
      id: KIT_PROVIDER_ID,
      name: "Kit AI Gateway",
      getModels: () =>
        gateway.getModels().map((model) => ({ ...model, provider: KIT_PROVIDER_ID })),
      getAllModels: undefined,
      auth: {
        apiKey: {
          name: "Kit connection (Settings → Kit)",
          check: async () => (owner.connected() ? { type: "api_key", source: "Kit" } : undefined),
          resolve: async ({ signal }) =>
            owner.connected()
              ? { auth: await waitForKit(owner.gatewayAuth(), signal), source: "Kit" }
              : undefined,
        },
      },
    });
    for (const tool of kitTools(owner)) pi.registerTool(tool);
    pi.on("before_agent_start", (event) => {
      if (!owner.connected()) return;
      return {
        systemPrompt: `${event.systemPrompt}\n\n${kitInstructions("mcp", KIT_AGENT_SCOPES)}\nKit tools in this app have the prefix kit_. They run through Kit's cloud service. Pi is still local; repository bash cannot access Kit credentials. If a Kit call is cancelled after dispatch, it may still complete remotely; never retry a mutation without checking its outcome.`,
      };
    });
  };
}
