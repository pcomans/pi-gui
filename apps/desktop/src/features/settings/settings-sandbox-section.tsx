import { useEffect, useState } from "react";
import type { SandboxSnapshot } from "../../../contracts/sandbox";
import { SettingsGroup, SettingsRow } from "./settings-utils";

export function SettingsSandboxSection() {
  const [snapshot, setSnapshot] = useState<SandboxSnapshot>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const load = () => {
      window.piApp?.getSandboxSnapshot().then(
        (value) => {
          if (active) setSnapshot(value);
        },
        (error: unknown) => {
          if (active) setError(String(error));
        },
      );
    };
    load();
    const timer = window.setInterval(load, 2000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);
  return (
    <SettingsGroup
      title="Remote workspaces"
      description="Repositories, Git, tools and terminals live in Vercel Sandbox. Pi, conversations and model credentials stay on this computer."
    >
      {error ? <p className="settings-warning">{error}</p> : null}
      <SettingsRow
        title="Vercel Sandbox"
        description={
          snapshot?.backend.message ??
          (snapshot
            ? "Configured. Each thread resumes its own persistent workspace."
            : "Checking configuration…")
        }
      >
        <span>{snapshot?.backend.state === "ready" ? "Ready" : "Setup required"}</span>
      </SettingsRow>
      <SettingsRow
        title="Persistence"
        description="Idle compute stops after ten minutes. A new VM resumes the saved filesystem; running commands are never replayed."
      />
      <SettingsRow
        title="Connection"
        description="For this POC, sign in with vercel login and set VERCEL_TEAM_ID and VERCEL_PROJECT_ID before launching."
      />
      <SettingsRow
        title="Network"
        description="Sandbox internet access is enabled. Host services and credentials are unavailable."
      />
      {snapshot ? (
        <SettingsRow
          title="Active sandboxes"
          description={`${snapshot.sandboxes.running} running · ${snapshot.sandboxes.total} used in this app session`}
        />
      ) : null}
    </SettingsGroup>
  );
}
