import { createRemoteWorkbench } from "./remote-workbench";
import { homedir } from "node:os";
import path from "node:path";

const workspaceId = process.env.PI_GUI_WORKSPACE_ID;
const sessionId = process.env.PI_GUI_SESSION_ID;
if (!workspaceId || !sessionId) throw new Error("Missing remote thread identity.");

Object.assign(globalThis, {
  piGuiWorkbench: createRemoteWorkbench(
    process.cwd(),
    { workspaceId, sessionId },
    path.join(homedir(), ".pi-gui"),
  ),
});
