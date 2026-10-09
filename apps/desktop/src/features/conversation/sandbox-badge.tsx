import { ShieldIcon } from "../../ui/icons";

/** Where this thread's tools run, from the sandbox's extension status. */
export function SandboxBadge({ status }: { readonly status: string | undefined }) {
  if (!status) return null;
  const state = status.startsWith("Sandbox: failed")
    ? "failed"
    : status === "Sandbox: off"
      ? "off"
      : status.startsWith("Sandbox: starting")
        ? "starting"
        : "on";
  const label = {
    failed: "Sandbox failed",
    off: "Not sandboxed",
    starting: "Sandbox starting",
    on: "Sandboxed",
  }[state];
  const detail =
    state === "off"
      ? "Tools run directly on this Mac. Turn the sandbox on in Settings > Sandbox."
      : state === "failed"
        ? `${status}\nTools do not run until the sandbox works. See Settings > Sandbox.`
        : state === "starting" && status.length > "Sandbox: starting".length
          ? status.slice("Sandbox: starting: ".length)
          : "Tools run in a Linux VM that can only see this thread's checkout.";
  return (
    <span
      className={`model-selector__badge sandbox-badge sandbox-badge--${state}`}
      data-state={state}
      data-testid="sandbox-badge"
      title={detail}
    >
      <ShieldIcon />
      {label}
    </span>
  );
}
