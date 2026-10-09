import { useCallback, useEffect, useState } from "react";
import {
  normalizeSandboxHost,
  type SandboxHostLogEntry,
  type SandboxHostRule,
  type SandboxNetworkMode,
  type SandboxRepoNetworkRecord,
  type SandboxSettingsUpdate,
  type SandboxSnapshot,
} from "../../../contracts/sandbox";
import { SettingsSegmented, SettingsSelect, SettingsSwitch } from "./settings-controls";
import { SettingsGroup, SettingsRow } from "./settings-utils";

/** Sandboxes start and contact hosts in the background, so the page polls while it is open. */
const REFRESH_MS = 2_000;

const MODE_OPTIONS = [
  { value: "allow-all", label: "Allow all" },
  { value: "allowlist", label: "Allowlist" },
] as const satisfies readonly { value: SandboxNetworkMode; label: string }[];

export function SettingsSandboxSection() {
  const [snapshot, setSnapshot] = useState<SandboxSnapshot | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const api = window.piApp;
    if (!api) return;
    let cancelled = false;
    const load = () => {
      api
        .getSandboxSnapshot()
        .then((next) => {
          if (!cancelled) setSnapshot(next);
        })
        .catch((loadError: unknown) => {
          if (!cancelled) setError(errorText(loadError));
        });
    };
    load();
    const timer = window.setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const run = useCallback((change: () => Promise<SandboxSnapshot>) => {
    setPending(true);
    change()
      .then((next) => {
        setSnapshot(next);
        setError(undefined);
      })
      .catch((changeError: unknown) => setError(errorText(changeError)))
      .finally(() => setPending(false));
  }, []);

  const update = useCallback(
    (change: SandboxSettingsUpdate) => {
      const api = window.piApp;
      if (api) run(() => api.updateSandboxSettings(change));
    },
    [run],
  );

  if (!snapshot) {
    return error ? <p className="settings-warning">{error}</p> : null;
  }

  return (
    <>
      <SettingsGroup
        title="Tool sandbox"
        description="pi's read, write, edit and bash tools run in a Linux virtual machine that can only see the thread's checkout. Models, MCP servers and extensions keep running on this Mac."
      >
        {error ? (
          <div className="settings-row">
            <span className="settings-row__description settings-warning">{error}</span>
          </div>
        ) : null}
        <SettingsRow
          title="Run tools in a sandbox"
          description={
            snapshot.supported
              ? "Applies to threads opened from now on. Reopen the app to switch threads that are already open."
              : "Not available on this platform."
          }
        >
          <SettingsSwitch
            checked={snapshot.enabled}
            disabled={pending || !snapshot.supported}
            label="Run tools in a sandbox"
            onChange={(enabled) => update({ kind: "enabled", enabled })}
          />
        </SettingsRow>
        <SettingsRow
          title="QEMU"
          description={
            snapshot.qemu.found
              ? "Installed."
              : `Not installed. Sandboxed tools fail until it is. Install it with: ${snapshot.qemu.installHint}`
          }
        />
        <SettingsRow
          title="Sandbox image"
          description={imageDescription(snapshot.baseImage.state, snapshot.baseImage.error)}
        >
          {snapshot.baseImage.state === "missing" || snapshot.baseImage.state === "failed" ? (
            <button
              className="button button--secondary"
              disabled={pending || !snapshot.qemu.found}
              type="button"
              onClick={() => {
                const api = window.piApp;
                if (api) run(() => api.prepareSandbox());
              }}
            >
              {snapshot.baseImage.state === "failed" ? "Retry" : "Prepare now"}
            </button>
          ) : null}
        </SettingsRow>
        <SettingsRow title="Running sandboxes" description={sessionSummary(snapshot)} />
      </SettingsGroup>

      <SettingsGroup
        title="Network"
        description="Every host a sandbox contacts is recorded below, by repository. Blocking takes effect on the next request; nothing needs restarting."
      >
        <SettingsRow
          title="Default for repositories"
          description="Allowlist blocks any host you have not allowed."
        >
          <SettingsSegmented
            label="Default network mode"
            options={MODE_OPTIONS}
            value={snapshot.defaultNetworkMode}
            onChange={(mode) => update({ kind: "default-network-mode", mode })}
          />
        </SettingsRow>
      </SettingsGroup>

      {snapshot.repos.map((repo) => (
        <SandboxRepoGroup
          defaultMode={snapshot.defaultNetworkMode}
          disabled={pending}
          key={repo.repoPath}
          repo={repo}
          onUpdate={update}
        />
      ))}
    </>
  );
}

function SandboxRepoGroup({
  repo,
  defaultMode,
  disabled,
  onUpdate,
}: {
  readonly repo: SandboxRepoNetworkRecord;
  readonly defaultMode: SandboxNetworkMode;
  readonly disabled: boolean;
  readonly onUpdate: (update: SandboxSettingsUpdate) => void;
}) {
  const [draftHost, setDraftHost] = useState("");
  const draft = normalizeSandboxHost(draftHost);
  const setRule = (host: string, rule: SandboxHostRule | null) =>
    onUpdate({ kind: "host-rule", repoPath: repo.repoPath, host, rule });
  const ruled = [
    ...repo.allowedHosts.filter((host) => !repo.hosts.some((entry) => entry.host === host)),
    ...repo.blockedHosts.filter((host) => !repo.hosts.some((entry) => entry.host === host)),
  ];
  return (
    <div data-testid="sandbox-repo" data-repo-path={repo.repoPath}>
      <SettingsGroup title={baseName(repo.repoPath)} description={repo.repoPath}>
        <SettingsRow title="Network access">
          <SettingsSelect
            label={`Network access for ${baseName(repo.repoPath)}`}
            options={[
              {
                value: "default",
                label: `Default (${defaultMode === "allowlist" ? "allowlist" : "allow all"})`,
              },
              ...MODE_OPTIONS,
            ]}
            value={repo.mode ?? "default"}
            onChange={(mode) =>
              onUpdate({
                kind: "repo-network-mode",
                repoPath: repo.repoPath,
                mode: mode === "default" ? null : mode,
              })
            }
          />
        </SettingsRow>
        <div className="settings-row">
          <input
            aria-label={`Host for ${baseName(repo.repoPath)}`}
            className="settings-text-input"
            placeholder="e.g. *.npmjs.org"
            value={draftHost}
            onChange={(event) => setDraftHost(event.currentTarget.value)}
          />
          <div className="settings-row__actions">
            {(["allow", "block"] as const).map((rule) => (
              <button
                className="button button--secondary"
                disabled={disabled || !draft}
                key={rule}
                type="button"
                onClick={() => {
                  if (!draft) return;
                  setRule(draft, rule);
                  setDraftHost("");
                }}
              >
                {rule === "allow" ? "Allow" : "Block"}
              </button>
            ))}
          </div>
        </div>
        {repo.hosts.length === 0 && ruled.length === 0 ? (
          <div className="settings-row">
            <span className="settings-row__description">
              No hosts contacted yet from this repository&apos;s sandboxes.
            </span>
          </div>
        ) : null}
        {repo.hosts.map((entry) => (
          <SandboxHostRow
            allowlist={repo.effectiveMode === "allowlist"}
            disabled={disabled}
            entry={entry}
            key={entry.host}
            rule={hostRule(repo, entry.host)}
            onRule={(rule) => setRule(entry.host, rule)}
          />
        ))}
        {ruled.map((host) => (
          <SandboxHostRow
            allowlist={repo.effectiveMode === "allowlist"}
            disabled={disabled}
            entry={undefined}
            host={host}
            key={host}
            rule={hostRule(repo, host)}
            onRule={(rule) => setRule(host, rule)}
          />
        ))}
      </SettingsGroup>
    </div>
  );
}

function SandboxHostRow({
  entry,
  host = entry?.host ?? "",
  rule,
  allowlist,
  disabled,
  onRule,
}: {
  readonly allowlist: boolean;
  readonly entry: SandboxHostLogEntry | undefined;
  readonly host?: string;
  readonly rule: SandboxHostRule | undefined;
  readonly disabled: boolean;
  readonly onRule: (rule: SandboxHostRule | null) => void;
}) {
  const ruleText =
    rule === "allow"
      ? "Allowed by you"
      : rule === "block"
        ? "Blocked by you"
        : allowlist
          ? "Not on the allowlist"
          : "";
  const traffic = entry
    ? [
        entry.allowedCount > 0 ? `${entry.allowedCount} allowed` : "",
        entry.blockedCount > 0 ? `${entry.blockedCount} blocked` : "",
        `last ${new Date(entry.lastSeenAt).toLocaleString()}`,
      ]
        .filter(Boolean)
        .join(" · ")
    : "Not contacted yet";
  return (
    <div className="settings-row" data-testid="sandbox-host" data-host={host}>
      <div className="settings-row__label">
        <div className="settings-row__title">{host}</div>
        <div className="settings-row__description">
          {[ruleText, traffic].filter(Boolean).join(" · ")}
        </div>
      </div>
      <div className="settings-row__actions">
        {rule ? (
          <button
            className="button button--secondary"
            disabled={disabled}
            type="button"
            onClick={() => onRule(null)}
          >
            {rule === "allow" ? "Remove from allowlist" : "Unblock"}
          </button>
        ) : (
          <>
            <button
              className="button button--secondary"
              disabled={disabled}
              type="button"
              onClick={() => onRule("allow")}
            >
              Allow
            </button>
            {allowlist ? null : (
              <button
                className="button button--secondary"
                disabled={disabled}
                type="button"
                onClick={() => onRule("block")}
              >
                Block
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function hostRule(repo: SandboxRepoNetworkRecord, host: string): SandboxHostRule | undefined {
  if (repo.blockedHosts.includes(host)) return "block";
  if (repo.allowedHosts.includes(host)) return "allow";
  return undefined;
}

function imageDescription(state: SandboxSnapshot["baseImage"]["state"], error?: string): string {
  switch (state) {
    case "ready":
      return "Ready. Sandboxes start in well under a second.";
    case "building":
      return "Preparing the Linux image with git, ripgrep, gh, node and pnpm…";
    case "failed":
      return `Preparing the image failed: ${error ?? "unknown error"}`;
    case "missing":
      return "Not prepared yet. It is built on the first sandboxed tool call (about a minute), or now.";
  }
}

function sessionSummary(snapshot: SandboxSnapshot): string {
  const running = snapshot.sessions.filter((session) => session.state === "ready").length;
  const failed = snapshot.sessions.filter((session) => session.state === "failed");
  const parts = [
    `${snapshot.sessions.length} open ${snapshot.sessions.length === 1 ? "thread" : "threads"}`,
    `${running} running`,
    ...(failed.length > 0
      ? [`${failed.length} failed: ${(failed[0]?.message ?? "").replace(/\.\s*$/, "")}`]
      : []),
  ];
  return `${parts.join(" · ")}. Idle sandboxes stop after 10 minutes and restart on the next tool call.`;
}

function baseName(repoPath: string): string {
  return repoPath.split(/[\\/]/).filter(Boolean).pop() ?? repoPath;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
