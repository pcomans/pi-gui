import { expect, test } from "@playwright/test";
import { terminalSandboxNotice } from "../../contracts/sandbox";

test("terminal names the thread’s remote workspace", () => {
  expect(terminalSandboxNotice(true)).toEqual({
    label: "Runs in this thread’s Vercel Sandbox",
    detail: "This terminal shares the remote repository with Pi’s tools and Review.",
  });
  expect(terminalSandboxNotice(false)).toBeUndefined();
});
