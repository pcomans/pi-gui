import { useEffect, useState } from "react";
import type { KitSnapshot } from "../../../contracts/kit";
import { SettingsGroup, SettingsRow } from "./settings-utils";

export function SettingsKitSection() {
  const [snapshot, setSnapshot] = useState<KitSnapshot>();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  useEffect(() => {
    let active = true;
    const load = () => {
      window.piApp?.getKitSnapshot().then(
        (value) => {
          if (active) setSnapshot(value);
        },
        () => {
          if (active) setError("Kit status could not be loaded.");
        },
      );
    };
    load();
    const timer = window.setInterval(load, 1000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  async function run(action: () => Promise<KitSnapshot>) {
    setPending(true);
    setError("");
    try {
      setSnapshot(await action());
    } catch {
      setError("Kit could not complete this action. Check connectivity and try again.");
    } finally {
      setPending(false);
    }
  }
  const api = window.piApp;
  const state = snapshot?.state;
  return (
    <>
      <SettingsGroup
        title="Kit account"
        description="Connect services once in Kit. Kit owns service authentication, permissions and the activity ledger."
      >
        {error || snapshot?.message ? (
          <p className="settings-warning" role="status">
            {error || snapshot?.message}
          </p>
        ) : null}
        <SettingsRow
          title={snapshot?.account ?? "Vercel Kit"}
          description={
            state === "connected"
              ? "Connected to Kit's cloud service."
              : state === "signing-in"
                ? "Finish sign-in and authorize pi-gui in your browser."
                : "Sign in with Vercel and authorize pi-gui to use your Kit."
          }
        >
          <div className="settings-row__actions">
            <button
              className="button"
              disabled={pending || !api}
              onClick={() => {
                if (api) run(() => api.connectKit()).catch(() => undefined);
              }}
            >
              Connect Kit
            </button>
            <button
              className="button button--secondary"
              disabled={pending || !api || state === "disconnected"}
              onClick={() => {
                if (api) run(() => api.disconnectKit()).catch(() => undefined);
              }}
            >
              {state === "signing-in" ? "Cancel sign-in" : "Disconnect locally"}
            </button>
          </div>
        </SettingsRow>
        {snapshot?.signInUrl ? (
          <SettingsRow title="Finish sign-in">
            <a
              className="button"
              href={snapshot.signInUrl}
              onClick={(event) => {
                event.preventDefault();
                api
                  ?.openExternal(snapshot.signInUrl!)
                  .catch(() => setError("Could not open the sign-in page."));
              }}
            >
              Continue in browser
            </a>
          </SettingsRow>
        ) : null}
        <SettingsRow
          title="Connections"
          description={
            snapshot?.connections.length
              ? snapshot.connections.map((value) => value.name).join(", ")
              : "Refresh after signing in to see your connected services."
          }
        >
          <button
            className="button button--secondary"
            disabled={pending || !api || state === "signing-in" || state === "disconnected"}
            onClick={() => {
              if (api) run(() => api.refreshKit()).catch(() => undefined);
            }}
          >
            Refresh Kit
          </button>
        </SettingsRow>
        <SettingsRow
          title="Manage services and permissions"
          description="Connect accounts, approve pending requests, revoke grants and inspect activity in Kit."
        >
          <button
            className="button button--secondary"
            onClick={() => {
              api
                ?.openExternal("https://kit.vercel.sh/agents")
                .catch(() => setError("Could not open Kit."));
            }}
          >
            Open Kit
          </button>
        </SettingsRow>
        <SettingsRow
          title="Models"
          description="After connecting, refresh Kit and choose a Kit AI Gateway model in Models or the composer. Model usage uses Kit-managed Gateway access and billing; existing provider logins stay separate."
        />
        <SettingsRow
          title="Credential storage"
          description="The app encrypts its Kit agent tokens with OS secure storage. Provider credentials stay with Kit and Vercel Connect. Disconnect locally removes this app's tokens; revoke cloud grants in Kit."
        />
      </SettingsGroup>
      <SettingsGroup
        title="Missing in this POC"
        description="Kit is an account and permissions service. It does not move this app's agent runtime into the sandbox."
      >
        <SettingsRow
          title="Unattended cloud agents"
          description="Pi still runs on this computer. Agent progress stops when the computer sleeps or the app closes."
        />
        <SettingsRow
          title="Sandbox MCP processes"
          description="Command-based MCP servers still run locally. Kit service tools call the cloud service through the SDK."
        />
        <SettingsRow
          title="Private Git clone and push"
          description="Kit's GitHub API tools do not authenticate Git transport. Repository onboarding still supports public HTTPS sources only."
        />
        <SettingsRow
          title="Per-thread permissions and native approvals"
          description="Threads share this profile's Kit agent identity. Approval and revocation happen in Kit; the app does not auto-approve writes."
        />
        <SettingsRow
          title="Recovery, exports and previews"
          description="Snapshot cleanup, file export, preview forwarding and 24-hour session configuration are not implemented. The complete gap list is in the repository's MISSING.md."
        />
      </SettingsGroup>
    </>
  );
}
