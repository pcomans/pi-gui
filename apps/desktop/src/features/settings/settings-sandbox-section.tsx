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
        description="pi's read, write, edit and bash tools run in each thread's own Docker sandbox (a Linux microVM) that can only see the thread's checkout. Models, MCP servers and extensions keep running on this Mac."
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
        <SettingsRow title="Docker Sandboxes" description={backendDescription(snapshot)}>
          {snapshot.backend.state === "ready" ? null : (
            <button
              className="button button--secondary"
              disabled={pending}
              type="button"
              onClick={() => {
                const api = window.piApp;
                if (api) run(() => api.prepareSandbox());
              }}
            >
              Check again
            </button>
          )}
        </SettingsRow>
        <SettingsRow title="Threads" description={sessionSummary(snapshot)} />
        <SettingsRow
          title="Sandboxes"
          description={`${snapshot.sandboxes.total} created by pi-gui, ${snapshot.sandboxes.running} running. Each thread keeps its own until it is removed; removing unused ones frees disk space, and a thread that needs one again gets a fresh sandbox.`}
        >
          <button
            className="button button--secondary"
            disabled={pending || snapshot.sandboxes.unused === 0}
            type="button"
            onClick={() => {
              if (
                window.confirm(
                  `Remove ${snapshot.sandboxes.unused} sandboxes no open thread uses? Packages installed in them are lost; files in your checkouts are not touched.`,
                )
              ) {
                update({ kind: "remove-unused-sandboxes" });
              }
            }}
          >
            Remove {snapshot.sandboxes.unused} unused
          </button>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup
        title="Network"
        description="Every host a sandbox contacts is recorded below, by repository. Blocking takes effect on the next request; nothing needs restarting."
      >
        {snapshot.globalAllowsAll ? (
          <div className="settings-row">
            <span className="settings-row__description settings-warning">
              Docker Sandboxes&apos; global policy allows every host, and its rules apply before
              pi-gui&apos;s, so Allowlist mode cannot narrow it here: blocks still work. To use an
              allowlist, make sbx deny by default (sbx policy reset, then sbx policy init deny-all);
              that also affects your other sandboxes.
            </span>
          </div>
        ) : null}
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

function backendDescription(snapshot: SandboxSnapshot): string {
  switch (snapshot.backend.state) {
    case "ready":
      return "Ready. Each thread gets its own sandbox on its first tool call.";
    case "missing":
      return `Not installed; sandboxed tools fail until it is. Install it: ${snapshot.backend.installHint}.`;
    case "signed-out":
      return "Installed but not signed in; sandboxed tools fail until it is. Run sbx login in a terminal.";
    case "unavailable":
      return `Not answering: ${snapshot.backend.message ?? "unknown error"}`;
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
  return `${parts.join(" · ")}. Idle sandboxes stop after 10 minutes and start again on the next tool call.`;
}

function baseName(repoPath: string): string {
  return repoPath.split(/[\\/]/).filter(Boolean).pop() ?? repoPath;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
