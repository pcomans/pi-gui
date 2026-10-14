import { createServer, type Server } from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_BASE,
  kit,
  kitAuth,
  kitScopes,
  randomToken,
  registerKitClient,
  type KitClient,
  type Tokens,
} from "@vercel/kit";
import type { KitSnapshot } from "../../contracts/kit";

interface StoredKit {
  readonly baseUrl: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly tokens?: Tokens;
}

export interface KitOwnerOptions {
  readonly userDataDir: string;
  readonly baseUrl?: string;
  readonly encrypt: (value: string) => Buffer;
  readonly decrypt: (value: Buffer) => string;
}

/** One Kit agent for this desktop profile. Never writes provider credentials to Pi's auth.json. */
export class KitOwner {
  readonly baseUrl: string;
  private stored?: StoredKit;
  private client?: KitClient;
  private gateway?: { key: string; baseUrl: string };
  private status: KitSnapshot = { state: "disconnected", connections: [] };
  private server?: Server;
  private loginTimer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private writes: Promise<void> = Promise.resolve();
  private connecting?: Promise<KitSnapshot>;
  private readonly file: string;

  constructor(private readonly options: KitOwnerOptions) {
    const url = new URL(options.baseUrl ?? DEFAULT_BASE);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "127.0.0.1"))
    )
      throw new Error("Kit must use an HTTPS origin (or a loopback development server).");
    this.baseUrl = url.origin;
    this.file = path.join(options.userDataDir, "kit", "account.enc");
  }

  async initialize(): Promise<void> {
    try {
      const data = this.options.decrypt(await readFile(this.file));
      this.stored = parseStoredKit(JSON.parse(data), this.baseUrl);
      if (this.stored.tokens) {
        this.attach(this.stored);
        this.status = {
          state: "connected",
          connections: [],
          message: "Connected. Refresh to load your services.",
        };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        this.status = {
          state: "failed",
          connections: [],
          message:
            "Saved Kit authentication could not be opened. Sign in again; the saved file was retained.",
        };
    }
  }

  snapshot(): KitSnapshot {
    return this.status;
  }
  connected(): boolean {
    return Boolean(this.client);
  }

  async refresh(): Promise<KitSnapshot> {
    if (!this.client) return this.status;
    const generation = this.generation;
    try {
      const loaded = await this.client.loadKit();
      if (generation === this.generation)
        this.status = {
          state: "connected",
          account: loaded.user.email ?? loaded.user.name ?? loaded.user.id,
          connections: loaded.connections,
        };
    } catch {
      if (generation === this.generation)
        this.status = {
          ...this.status,
          state: "failed",
          message: "Kit could not load your account. Refresh or sign in again.",
        };
    }
    return this.status;
  }

  connect(): Promise<KitSnapshot> {
    this.connecting ??= this.beginLogin().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async beginLogin(): Promise<KitSnapshot> {
    this.cancelLogin();
    const generation = ++this.generation;
    this.client = undefined;
    this.gateway = undefined;
    // Verify secure storage before registering a client or opening authorization.
    try {
      this.options.encrypt("Kit storage availability check");
    } catch {
      this.status = {
        state: "failed",
        connections: [],
        message:
          "Kit requires OS secure credential storage. Enable your system keychain and sign in again.",
      };
      return this.status;
    }
    const state = randomToken();
    let verifier = "";
    let exchanging = false;
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (
        request.method !== "GET" ||
        url.pathname !== "/kit/callback" ||
        url.searchParams.get("state") !== state
      ) {
        response.writeHead(400).end("Invalid Kit callback.");
        return;
      }
      if (exchanging || generation !== this.generation) {
        response.writeHead(409).end("This sign-in has ended.");
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) {
        response.writeHead(400).end("Kit authorization was declined. Return to pi-gui.");
        this.status = {
          state: "disconnected",
          connections: [],
          message: "Kit authorization was declined.",
        };
        this.cancelLogin();
        return;
      }
      exchanging = true;
      const stored = this.stored!;
      this.auth(stored)
        .exchange(code, verifier)
        .then(async (tokens) => {
          if (generation !== this.generation) throw new Error("Sign-in cancelled.");
          const next = { ...stored, tokens };
          await this.persist(next);
          if (generation !== this.generation) throw new Error("Sign-in cancelled.");
          this.attach(next);
          this.status = { state: "connected", connections: [] };
          await this.refresh();
          response
            .writeHead(200, {
              "content-type": "text/plain; charset=utf-8",
              "cache-control": "no-store",
            })
            .end("Kit connected. Return to pi-gui.");
        })
        .catch(() => {
          if (generation === this.generation)
            this.status = {
              state: "failed",
              connections: [],
              message: "Kit sign-in failed. Start a new sign-in.",
            };
          response.writeHead(400).end("Kit sign-in failed. Return to pi-gui.");
        })
        .finally(() => {
          if (generation === this.generation) this.cancelLogin();
        });
    });
    this.server = server;
    try {
      const oldPort = this.stored ? new URL(this.stored.redirectUri).port : "0";
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(Number(oldPort), "127.0.0.1", () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Kit callback listener unavailable.");
      const redirectUri = `http://127.0.0.1:${address.port}/kit/callback`;
      const registration = this.stored
        ? { ...this.stored, tokens: undefined }
        : {
            baseUrl: this.baseUrl,
            ...(await registerKitClient({
              name: "pi-gui",
              redirectUris: [redirectUri],
              native: true,
              baseUrl: this.baseUrl,
              fetch: kitFetch,
            })),
            redirectUri,
          };
      if (generation !== this.generation) throw new Error("Sign-in cancelled.");
      this.stored = registration;
      await this.persist(registration);
      const authorization = await this.auth(registration).authorizeUrl(state);
      verifier = authorization.verifier;
      if (generation !== this.generation) throw new Error("Sign-in cancelled.");
      this.status = { state: "signing-in", signInUrl: authorization.url, connections: [] };
      this.loginTimer = setTimeout(() => {
        const cancelled = this.disconnect();
        const cancellationGeneration = this.generation;
        this.status = {
          state: "disconnected",
          connections: [],
          message: "Kit sign-in expired. Start again.",
        };
        cancelled.catch(() => {
          if (cancellationGeneration === this.generation)
            this.status = {
              state: "failed",
              connections: [],
              message:
                "Kit sign-in expired, but saved authentication could not be cleared. Disconnect again.",
            };
        });
      }, 5 * 60_000);
      this.loginTimer.unref();
      return this.status;
    } catch (error) {
      if (generation === this.generation) {
        this.cancelLogin();
        this.status = {
          state: "failed",
          connections: [],
          message: "Kit sign-in could not start. Check connectivity and secure credential storage.",
        };
      }
      throw error;
    }
  }

  async disconnect(): Promise<KitSnapshot> {
    ++this.generation;
    this.cancelLogin();
    this.client = undefined;
    this.gateway = undefined;
    this.status = { state: "disconnected", connections: [] };
    if (this.stored) {
      this.stored = { ...this.stored, tokens: undefined };
      await this.persist(this.stored);
    }
    return this.status;
  }

  close(): void {
    ++this.generation;
    this.cancelLogin();
  }

  private cancelLogin(): void {
    clearTimeout(this.loginTimer);
    this.loginTimer = undefined;
    this.server?.close();
    this.server = undefined;
  }

  requireClient(): KitClient {
    if (!this.client) throw new Error("Connect Kit in Settings → Kit before using its services.");
    return this.client;
  }

  async gatewayAuth(): Promise<{ apiKey: string; baseUrl: string }> {
    const generation = this.generation;
    const value = this.gateway ?? (await this.requireClient().gatewayKey());
    if (generation !== this.generation || !this.client) throw new Error("Kit was disconnected.");
    const url = new URL(value.baseUrl);
    if (url.origin !== this.baseUrl || url.username || url.password || url.search || url.hash)
      throw new Error("Kit returned an unexpected model endpoint.");
    this.gateway = value;
    return { apiKey: value.key, baseUrl: value.baseUrl };
  }

  private auth(stored: StoredKit) {
    return kitAuth({
      clientId: stored.clientId,
      redirectUri: stored.redirectUri,
      baseUrl: this.baseUrl,
      scopes: kitScopes("connections", "gateway", "skills"),
      fetch: kitFetch,
    });
  }

  private attach(stored: StoredKit): void {
    this.stored = stored;
    this.gateway = undefined;
    const generation = this.generation;
    this.client = kit({
      tokens: stored.tokens!,
      auth: this.auth(stored),
      baseUrl: this.baseUrl,
      fetch: kitFetch,
      onTokens: async (tokens) => {
        if (generation !== this.generation) throw new Error("Kit was disconnected.");
        this.stored = { ...stored, tokens };
        await this.persist(this.stored);
      },
    });
  }

  private persist(stored: StoredKit): Promise<void> {
    const encrypted = this.options.encrypt(JSON.stringify(stored));
    const write = async () => {
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.tmp`;
      await writeFile(temporary, encrypted, { mode: 0o600 });
      await rename(temporary, this.file);
    };
    const result = this.writes.then(write, write);
    this.writes = result.catch(() => undefined);
    return result;
  }
}

/** Bound stalled cloud requests without retrying actions. The SDK owns token refresh. */
const kitFetch: typeof fetch = (input, init) =>
  fetch(input, {
    ...init,
    signal: init?.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(120_000)])
      : AbortSignal.timeout(120_000),
  });

function parseStoredKit(value: unknown, baseUrl: string): StoredKit {
  const stored = value as Partial<StoredKit> | null;
  if (
    !stored ||
    stored.baseUrl !== baseUrl ||
    typeof stored.clientId !== "string" ||
    !stored.clientId ||
    typeof stored.redirectUri !== "string"
  )
    throw new Error("Invalid Kit account.");
  const callback = new URL(stored.redirectUri);
  if (
    callback.protocol !== "http:" ||
    callback.hostname !== "127.0.0.1" ||
    !callback.port ||
    callback.pathname !== "/kit/callback" ||
    callback.username ||
    callback.password ||
    callback.search ||
    callback.hash
  )
    throw new Error("Invalid Kit callback.");
  if (
    stored.tokens &&
    (typeof stored.tokens.accessToken !== "string" ||
      !stored.tokens.accessToken ||
      typeof stored.tokens.expiresAt !== "number" ||
      !Number.isFinite(stored.tokens.expiresAt) ||
      (stored.tokens.refreshToken !== undefined && typeof stored.tokens.refreshToken !== "string"))
  )
    throw new Error("Invalid Kit tokens.");
  return stored as StoredKit;
}
