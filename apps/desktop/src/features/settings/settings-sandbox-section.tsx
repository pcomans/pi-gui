import { useCallback, useEffect, useState } from "react";
import {
  isSandboxHostOnlyName,
  normalizeSandboxHost,
  SANDBOX_HOST_ONLY_NAMES,
  type SandboxHostLogEntry,
  type SandboxHostRule,
  type SandboxRepoNetworkRecord,
  type SandboxSettingsUpdate,
  type SandboxSnapshot,
} from "../../../contracts/sandbox";
import { SettingsSwitch } from "./settings-controls";
import { SettingsGroup, SettingsRow } from "./settings-utils";

/** Sandboxes start and contact hosts in the background, so the page polls while it is open. */
const REFRESH_MS = 2_000;

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
    return error ? (
      <p className="settings-warning">{error}</p>
    ) : (
      <p className="settings-row__description">Checking Docker Sandboxes…</p>
    );
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
                  `Remove ${snapshot.sandboxes.unused} ${snapshot.sandboxes.unused === 1 ? "sandbox" : "sandboxes"} no open thread uses? Packages installed in them are lost; files in your checkouts are not touched.`,
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
        plain
        title="Network"
        description="Sandboxes can reach any host you have not blocked; services on this Mac (host.docker.internal, localhost) stay blocked unless you allow them. Every host a sandbox contacts is recorded below, by repository. Blocking takes effect on the next request; nothing needs restarting."
      >
        {null}
      </SettingsGroup>

      {snapshot.repos.map((repo) => (
        <SandboxRepoGroup disabled={pending} key={repo.repoPath} repo={repo} onUpdate={update} />
      ))}
    </>
  );
}

function SandboxRepoGroup({
  repo,
  disabled,
  onUpdate,
}: {
  readonly repo: SandboxRepoNetworkRecord;
  readonly disabled: boolean;
  readonly onUpdate: (update: SandboxSettingsUpdate) => void;
}) {
  const [draftHost, setDraftHost] = useState("");
  const draft = normalizeSandboxHost(draftHost);
  const setRule = (host: string, rule: SandboxHostRule | null) =>
    onUpdate({ kind: "host-rule", repoPath: repo.repoPath, host, rule });
  const logged = (host: string) => repo.hosts.some((entry) => entry.host === host);
  // Blocked hosts and the services on this Mac are listed even before a sandbox contacts them.
  const unlogged = [...new Set([...repo.blockedHosts, ...SANDBOX_HOST_ONLY_NAMES])].filter(
    (host) => !logged(host),
  );
  return (
    <div data-testid="sandbox-repo" data-repo-path={repo.repoPath}>
      <SettingsGroup title={baseName(repo.repoPath)} description={repo.repoPath}>
        <div className="settings-row">
          <input
            aria-label={`Host for ${baseName(repo.repoPath)}`}
            className="settings-text-input"
            placeholder="e.g. *.example.com"
            value={draftHost}
            onChange={(event) => setDraftHost(event.currentTarget.value)}
          />
          <div className="settings-row__actions">
            <button
              className="button button--secondary"
              disabled={disabled || !draft}
              type="button"
              onClick={() => {
                if (!draft) return;
                setRule(draft, "block");
                setDraftHost("");
              }}
            >
              Block
            </button>
          </div>
        </div>
        {repo.hosts.length === 0 ? (
          <div className="settings-row">
            <span className="settings-row__description">
              No hosts contacted yet from this repository&apos;s sandboxes.
            </span>
          </div>
        ) : null}
        {repo.hosts.map((entry) => (
          <SandboxHostRow
            disabled={disabled}
            entry={entry}
            key={entry.host}
            rule={hostRule(repo, entry.host)}
            onRule={(rule) => setRule(entry.host, rule)}
          />
        ))}
        {unlogged.map((host) => (
          <SandboxHostRow
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
  disabled,
  onRule,
}: {
  readonly entry: SandboxHostLogEntry | undefined;
  readonly host?: string;
  readonly rule: SandboxHostRule | undefined;
  readonly disabled: boolean;
  readonly onRule: (rule: SandboxHostRule | null) => void;
}) {
  const hostOnly = isSandboxHostOnlyName(host);
  const ruleText =
    rule === "allow"
      ? "Allowed by you"
      : rule === "block"
        ? "Blocked by you"
        : hostOnly
          ? "A service on this Mac, blocked unless you allow it"
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
  // Services on this Mac are denied unless allowed; every other host is allowed unless blocked.
  const action: { readonly label: string; readonly rule: SandboxHostRule | null } = hostOnly
    ? rule === "allow"
      ? { label: "Block", rule: null }
      : { label: "Allow", rule: "allow" }
    : rule === "block"
      ? { label: "Unblock", rule: null }
      : { label: "Block", rule: "block" };
  return (
    <div className="settings-row" data-testid="sandbox-host" data-host={host}>
      <div className="settings-row__label">
        <div className="settings-row__title">{host}</div>
        <div className="settings-row__description">
          {[ruleText, traffic].filter(Boolean).join(" · ")}
        </div>
      </div>
      <div className="settings-row__actions">
        <button
          className="button button--secondary"
          disabled={disabled}
          type="button"
          onClick={() => onRule(action.rule)}
        >
          {action.label}
        </button>
      </div>
    </div>
  );
}

function hostRule(repo: SandboxRepoNetworkRecord, host: string): SandboxHostRule | undefined {
  if (repo.allowedHosts.includes(host)) return "allow";
  // A service on this Mac is denied either way; only an allow changes it.
  if (isSandboxHostOnlyName(host)) return undefined;
  if (repo.blockedHosts.includes(host)) return "block";
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
