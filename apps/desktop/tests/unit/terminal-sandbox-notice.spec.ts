import { expect, test } from "@playwright/test";
import { terminalSandboxNotice } from "../../contracts/sandbox";

test.describe("terminal sandbox notice", () => {
  test("a sandboxed thread's terminal says it runs on the host, outside the sandbox", () => {
    expect(terminalSandboxNotice(true, "darwin")).toEqual({
      label: "Runs on this Mac, outside the sandbox",
      detail: "This terminal is not sandboxed. It runs on this Mac, outside the thread's sandbox.",
    });
  });

  test("off macOS the notice names this computer instead of this Mac", () => {
    expect(terminalSandboxNotice(true, "linux")?.label).toBe(
      "Runs on this computer, outside the sandbox",
    );
  });

  test("an unsandboxed thread's terminal shows no notice", () => {
    expect(terminalSandboxNotice(false, "darwin")).toBeUndefined();
    expect(terminalSandboxNotice(false, "linux")).toBeUndefined();
  });
});
