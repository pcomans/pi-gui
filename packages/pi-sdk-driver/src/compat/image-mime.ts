/**
 * Pi 1.0 exports its file detector, but not the byte detector it uses underneath. Remote reads
 * need the latter so detection never opens a host path. Keep this private import in one seam.
 */
export async function detectPiImageMimeType(bytes: Uint8Array): Promise<string | null> {
  const mimeUrl = new URL(
    "./utils/mime.js",
    import.meta.resolve("@earendil-works/pi-coding-agent"),
  );
  const mime = (await import(mimeUrl.href)) as {
    detectSupportedImageMimeType?: (bytes: Uint8Array) => unknown;
  };
  if (typeof mime.detectSupportedImageMimeType !== "function") {
    throw new Error("The bundled Pi runtime does not support image detection from sandbox bytes.");
  }
  const result = mime.detectSupportedImageMimeType(bytes);
  if (result !== null && typeof result !== "string") {
    throw new Error("The bundled Pi runtime returned an invalid image MIME type.");
  }
  return result;
}
