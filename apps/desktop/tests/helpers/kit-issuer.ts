import { createServer } from "node:http";
import { once } from "node:events";

/** Local OAuth issuer; exercises the published SDK without real accounts or model requests. */
export async function kitIssuer() {
  const requests: { path: string; body: string; authorization?: string }[] = [];
  let gatewayOrigin: string | undefined;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString();
      const requestPath = request.url ?? "/";
      requests.push({ path: requestPath, body, authorization: request.headers.authorization });
      let value: unknown;
      switch (requestPath) {
        case "/api/auth/oauth2/register":
          value = { client_id: "fixture-native-client" };
          break;
        case "/api/auth/oauth2/token":
          value = {
            access_token: "fixture-access-token",
            refresh_token: "fixture-refresh-token",
            expires_in: 3600,
          };
          break;
        case "/api/agent/load-kit":
          value = {
            user: { id: "fixture-user", email: "kit-fixture@example.test" },
            agent: { clientId: "fixture-native-client", name: "pi-gui" },
            connections: [{ service: "github", name: "GitHub" }],
            skills: [],
            instructions: "Fixture Kit",
          };
          break;
        case "/api/agent/gateway-key":
          value = {
            result: {
              key: "fixture-gateway-key",
              baseUrl: `${gatewayOrigin ?? baseUrl}/api/gateway`,
            },
          };
          break;
        default:
          response.writeHead(404).end();
          return;
      }
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Kit fixture did not listen.");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl,
    requests,
    gatewayOrigin: (value: string) => {
      gatewayOrigin = value;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

export function kitCallback(authorization: string, state?: string) {
  const url = new URL(authorization);
  const callback = new URL(url.searchParams.get("redirect_uri")!);
  callback.search = new URLSearchParams({
    state: state ?? url.searchParams.get("state")!,
    code: "fixture-authorization-code",
  }).toString();
  return callback;
}
