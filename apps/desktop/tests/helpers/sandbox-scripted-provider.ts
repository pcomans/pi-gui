const PROVIDER = "sandbox-e2e";

export interface ScriptedToolCall {
  readonly name: "bash" | "read" | "write" | "edit";
  readonly arguments: Readonly<Record<string, unknown>>;
}

export function scriptedProviderExtension(
  scripts: Readonly<Record<string, ScriptedToolCall>>,
): string {
  return String.raw`
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const SCRIPTS = ${JSON.stringify(scripts)};

function textOf(message) {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  return (message.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

export default function sandboxE2eProvider(pi) {
  pi.registerProvider("${PROVIDER}", {
    baseUrl: "http://127.0.0.1:9/never-contact",
    apiKey: "LOCAL_TEST_CANARY",
    api: "${PROVIDER}",
    models: [{
      id: "scripted", name: "Scripted sandbox driver", reasoning: false,
      input: ["text", "image"], contextWindow: 128000, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
    streamSimple(model, context) {
      const lastUser = context.messages.findLastIndex((message) => message.role === "user");
      const match = /\brun ([a-z0-9-]+)/.exec(textOf(context.messages[lastUser]));
      const tag = match ? match[1] : undefined;
      const script = tag ? SCRIPTS[tag] : undefined;
      const result = context.messages
        .slice(lastUser + 1)
        .find((message) => message.role === "toolResult");
      const content = !script
        ? [{ type: "text", text: "No sandbox script for this prompt." }]
        : !result
          ? [{ type: "toolCall", id: "sbx-" + tag, name: script.name, arguments: script.arguments }]
          : [{
              type: "text",
              text: "DONE " + tag + " isError=" + Boolean(result.isError) +
                "\n\n~~~text\n" + textOf(result) + "\n~~~\n" +
                "images=" + (result.content ?? []).filter((part) => part.type === "image")
                  .map((part) => part.mimeType + ":" + Boolean(part.data)).join(","),
            }];
      const toolUse = content[0].type === "toolCall";
      const message = {
        role: "assistant", content,
        api: model.api, provider: model.provider, model: model.id,
        usage: {
          input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: toolUse ? "toolUse" : "stop", timestamp: Date.now(),
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: { ...message, content: [] } });
      if (!toolUse) {
        stream.push({ type: "text_delta", contentIndex: 0, delta: content[0].text, partial: message });
      }
      stream.push({ type: "done", reason: message.stopReason, message });
      return stream;
    },
  });
}
`;
}
