import { createContext, useContext } from "react";
import { toolRunLocation } from "../../../contracts/sandbox";

/** Whether the selected thread is sandboxed, read by transcript tool rows. */
export const ThreadSandboxedContext = createContext(false);

const LOCATION_TEXT = {
  sandbox: { label: "Sandbox", detail: "Ran in this thread's sandbox" },
  host: { label: "Host", detail: "Ran on the host, outside the sandbox" },
} as const;

/** "· Sandbox" or "· Host" in a tool row's metadata; nothing in an unsandboxed thread. */
export function ToolRunLocationLabel({ toolName }: { readonly toolName: string }) {
  const location = toolRunLocation(toolName, useContext(ThreadSandboxedContext));
  if (!location) return null;
  const { label, detail } = LOCATION_TEXT[location];
  return (
    <span
      className="timeline-tool__location"
      data-location={location}
      data-testid="timeline-tool-location"
      title={detail}
    >
      <span aria-hidden="true">{"\u00b7 "}</span>
      <span className="sr-only">{detail}</span>
      <span aria-hidden="true">{label}</span>
    </span>
  );
}
