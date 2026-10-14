import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "@playwright/test";
import { KitOwner } from "../../electron/kit/kit-owner";
import { kitCallback, kitIssuer } from "../helpers/kit-issuer";

// Fixture encryption exercises persistence/restart without macOS safeStorage or actual credentials.
function encryption() {
  const key = randomBytes(32);
  return {
    encrypt(value: string) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
    },
    decrypt(value: Buffer) {
      const cipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
      cipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString();
    },
  };
}

test("native PKCE rejects invalid callbacks, keeps secrets encrypted, reconnects and disconnects persistently", async () => {
  const issuer = await kitIssuer();
  const userDataDir = await mkdtemp(path.join(tmpdir(), "kit-owner-"));
  const storage = encryption();
  const options = { userDataDir, baseUrl: issuer.baseUrl, ...storage };
  const owner = new KitOwner(options);
  const restarted = new KitOwner(options);
  try {
    await owner.initialize();
    await expect(owner.gatewayAuth()).rejects.toThrow("Connect Kit");
    const authorization = (await owner.connect()).signInUrl!;
    const url = new URL(authorization);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")?.split(" ")).not.toContain("admin");
    expect((await fetch(kitCallback(authorization, "incorrect-state"))).status).toBe(400);
    expect(issuer.requests.filter((request) => request.path.endsWith("/token"))).toHaveLength(0);
    expect((await fetch(kitCallback(authorization))).status).toBe(200);
    expect(owner.snapshot()).toMatchObject({
      state: "connected",
      account: "kit-fixture@example.test",
      connections: [{ service: "github" }],
    });
    const tokenBody = new URLSearchParams(
      issuer.requests.find((request) => request.path.endsWith("/token"))!.body,
    );
    expect(tokenBody.get("code_verifier")).toBeTruthy();
    expect(tokenBody.get("grant_type")).toBe("authorization_code");
    expect(JSON.stringify(owner.snapshot())).not.toContain("fixture-access-token");
    const file = path.join(userDataDir, "kit", "account.enc");
    expect((await readFile(file)).toString()).not.toContain("fixture-refresh-token");
    owner.close();
    await restarted.initialize();
    expect(restarted.connected()).toBe(true);
    expect(await restarted.gatewayAuth()).toEqual({
      apiKey: "fixture-gateway-key",
      baseUrl: `${issuer.baseUrl}/api/gateway`,
    });
    await restarted.disconnect();
    const saved = storage.decrypt(await readFile(file));
    expect(saved).not.toContain("fixture-access-token");
    const disconnected = new KitOwner(options);
    await disconnected.initialize();
    expect(disconnected.connected()).toBe(false);
    const reauthorization = (await disconnected.connect()).signInUrl!;
    expect(issuer.requests.filter((request) => request.path.endsWith("/register"))).toHaveLength(1);
    expect((await fetch(kitCallback(reauthorization))).status).toBe(200);
    await disconnected.disconnect();
    disconnected.close();
  } finally {
    owner.close();
    restarted.close();
    await issuer.close();
  }
});

test("parallel requests share Kit's rotating refresh and persist refreshed tokens", async () => {
  const issuer = await kitIssuer();
  const userDataDir = await mkdtemp(path.join(tmpdir(), "kit-refresh-"));
  const storage = encryption();
  const options = { userDataDir, baseUrl: issuer.baseUrl, ...storage };
  const owner = new KitOwner(options);
  const restarted = new KitOwner(options);
  try {
    await fetch(kitCallback((await owner.connect()).signInUrl!));
    owner.close();
    const file = path.join(userDataDir, "kit", "account.enc");
    const saved = JSON.parse(storage.decrypt(await readFile(file))) as {
      tokens: { expiresAt: number };
    };
    saved.tokens.expiresAt = 0;
    await writeFile(file, storage.encrypt(JSON.stringify(saved)));
    await restarted.initialize();
    await Promise.all([restarted.refresh(), restarted.refresh(), restarted.gatewayAuth()]);
    const refreshes = issuer.requests.filter(
      (request) => new URLSearchParams(request.body).get("grant_type") === "refresh_token",
    );
    expect(refreshes).toHaveLength(1);
    const updated = JSON.parse(storage.decrypt(await readFile(file))) as typeof saved;
    expect(updated.tokens.expiresAt).toBeGreaterThan(Date.now());
  } finally {
    owner.close();
    restarted.close();
    await issuer.close();
  }
});

test("Gateway keys cannot be forwarded to an unexpected origin", async () => {
  const issuer = await kitIssuer();
  const owner = new KitOwner({
    userDataDir: await mkdtemp(path.join(tmpdir(), "kit-endpoint-")),
    baseUrl: issuer.baseUrl,
    ...encryption(),
  });
  try {
    await fetch(kitCallback((await owner.connect()).signInUrl!));
    issuer.gatewayOrigin("https://unexpected.example.test");
    await expect(owner.gatewayAuth()).rejects.toThrow("unexpected model endpoint");
  } finally {
    owner.close();
    await issuer.close();
  }
});

test("a cancelled sign-in cannot exchange its callback or restore credentials", async () => {
  const issuer = await kitIssuer();
  const owner = new KitOwner({
    userDataDir: await mkdtemp(path.join(tmpdir(), "kit-cancel-")),
    baseUrl: issuer.baseUrl,
    ...encryption(),
  });
  try {
    const authorization = (await owner.connect()).signInUrl!;
    await owner.disconnect();
    await expect(fetch(kitCallback(authorization))).rejects.toThrow();
    expect(owner.snapshot()).toMatchObject({ state: "disconnected" });
    expect(issuer.requests.filter((request) => request.path.endsWith("/token"))).toHaveLength(0);
  } finally {
    owner.close();
    await issuer.close();
  }
});

test("unavailable secure storage prevents client registration and sign-in", async () => {
  const issuer = await kitIssuer();
  const owner = new KitOwner({
    userDataDir: "/unused",
    baseUrl: issuer.baseUrl,
    encrypt: () => {
      throw new Error("Fixture keychain unavailable");
    },
    decrypt: () => "",
  });
  try {
    expect(await owner.connect()).toMatchObject({
      state: "failed",
      message: expect.stringContaining("secure credential storage"),
    });
    expect(issuer.requests).toHaveLength(0);
    expect(owner.connected()).toBe(false);
  } finally {
    owner.close();
    await issuer.close();
  }
});
