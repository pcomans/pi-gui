import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";

/** Canonical public HTTPS Git source. Credentials belong to a broker, never a catalog URL. */
export function repositoryUrl(input: string): string {
  const url = new URL(input.trim());
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname === "/"
  )
    throw new Error(
      "Enter an HTTPS repository URL without credentials, query parameters or fragments.",
    );
  url.pathname = url.pathname.replace(/\/$/, "").replace(/\.git$/, "");
  return url.toString();
}

/** Pi needs a cwd for its resource loader and session identity; this holds metadata, never source. */
export async function prepareRemoteRepository(userDataDir: string, input: string) {
  const source = repositoryUrl(input);
  const id = createHash("sha256").update(source).digest("hex").slice(0, 24);
  const metadataPath = path.join(userDataDir, "remote-workspaces", id);
  await mkdir(metadataPath, { recursive: true });
  return {
    path: metadataPath,
    repositoryUrl: source,
    displayName: new URL(source).pathname.split("/").at(-1)!,
  };
}
