import { expect, test } from "@playwright/test";
import { isSandboxedStatus, toolRunLocation } from "../../contracts/sandbox";

test.describe("tool run location", () => {
  test("a thread is sandboxed unless its sandbox is off or reports no status", () => {
    expect(isSandboxedStatus(undefined)).toBe(false);
    expect(isSandboxedStatus("")).toBe(false);
    expect(isSandboxedStatus("Sandbox: off")).toBe(false);
    expect(isSandboxedStatus("Sandbox: on")).toBe(true);
    expect(isSandboxedStatus("Sandbox: starting")).toBe(true);
    expect(isSandboxedStatus("Sandbox: starting: Preparing the sandbox…")).toBe(true);
    expect(isSandboxedStatus("Sandbox: failed: sbx is not signed in")).toBe(true);
  });

  test("in a sandboxed thread, pi's read, write, edit and bash ran in the sandbox", () => {
    for (const tool of ["read", "write", "edit", "bash"]) {
      expect(toolRunLocation(tool, true)).toBe("sandbox");
    }
  });

  test("in a sandboxed thread, every other tool ran on the host", () => {
    // grep, find and ls are withdrawn in sandboxed threads; if one ever ran, it ran on the host.
    for (const tool of ["github_search", "mcp", "grep", "find", "ls", "Bash", "read_file"]) {
      expect(toolRunLocation(tool, true)).toBe("host");
    }
  });

  test("an unsandboxed thread labels no tool", () => {
    for (const tool of ["read", "write", "edit", "bash", "github_search"]) {
      expect(toolRunLocation(tool, false)).toBeUndefined();
    }
  });
});
