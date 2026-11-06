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
import { useTranslation, type Translate } from "../../i18n";
import { SettingsSwitch } from "./settings-controls";
import { SettingsGroup, SettingsRow } from "./settings-utils";

/** Sandboxes start and contact hosts in the background, so the page polls while it is open. */
const REFRESH_MS = 2_000;

export function SettingsSandboxSection() {
  const { t } = useTranslation();
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
      <p className="settings-row__description">{t("sandbox.checking")}</p>
    );
  }
  return (
    <>
      <SettingsGroup title={t("sandbox.title")} description={t("sandbox.description")}>
        {error ? (
          <div className="settings-row">
            <span className="settings-row__description settings-warning">{error}</span>
          </div>
        ) : null}
        <SettingsRow
          title={t("sandbox.enabled")}
          description={
            snapshot.supported ? t("sandbox.appliesToNewThreads") : t("sandbox.unsupported")
          }
        >
          <SettingsSwitch
            checked={snapshot.enabled}
            disabled={pending || !snapshot.supported}
            label={t("sandbox.enabled")}
            onChange={(enabled) => update({ kind: "enabled", enabled })}
          />
        </SettingsRow>
        <SettingsRow title={t("sandbox.backend")} description={backendDescription(snapshot, t)}>
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
              {t("sandbox.checkAgain")}
            </button>
          )}
        </SettingsRow>
        <SettingsRow title={t("sandbox.threads")} description={sessionSummary(snapshot, t)} />
        <SettingsRow
          title={t("sandbox.sandboxes")}
          description={t("sandbox.countSummary", {
            total: snapshot.sandboxes.total,
            running: snapshot.sandboxes.running,
          })}
        >
          <button
            className="button button--secondary"
            disabled={pending || snapshot.sandboxes.unused === 0}
            type="button"
            onClick={() => {
              if (
                window.confirm(t("sandbox.removeConfirm", { count: snapshot.sandboxes.unused }))
              ) {
                update({ kind: "remove-unused-sandboxes" });
              }
            }}
          >
            {t("sandbox.removeUnused", { count: snapshot.sandboxes.unused })}
          </button>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup
        plain
        title={t("sandbox.network")}
        description={t("sandbox.networkDescription")}
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
  const { t } = useTranslation();
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
            aria-label={t("sandbox.hostFor", { repository: baseName(repo.repoPath) })}
            className="settings-text-input"
            placeholder={t("sandbox.hostPlaceholder")}
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
              {t("sandbox.block")}
            </button>
          </div>
        </div>
        {repo.hosts.length === 0 ? (
          <div className="settings-row">
            <span className="settings-row__description">{t("sandbox.noHosts")}</span>
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
  const { t, locale } = useTranslation();
  const hostOnly = isSandboxHostOnlyName(host);
  const ruleText =
    rule === "allow"
      ? t("sandbox.allowedByYou")
      : rule === "block"
        ? t("sandbox.blockedByYou")
        : hostOnly
          ? t("sandbox.hostService")
          : "";
  const traffic = entry
    ? [
        entry.allowedCount > 0 ? t("sandbox.allowedCount", { count: entry.allowedCount }) : "",
        entry.blockedCount > 0 ? t("sandbox.blockedCount", { count: entry.blockedCount }) : "",
        t("sandbox.lastSeen", { time: new Date(entry.lastSeenAt).toLocaleString(locale) }),
      ]
        .filter(Boolean)
        .join(" · ")
    : t("sandbox.notContacted");
  // Services on this Mac are denied unless allowed; every other host is allowed unless blocked.
  const action: { readonly label: string; readonly rule: SandboxHostRule | null } = hostOnly
    ? rule === "allow"
      ? { label: t("sandbox.block"), rule: null }
      : { label: t("sandbox.allow"), rule: "allow" }
    : rule === "block"
      ? { label: t("sandbox.unblock"), rule: null }
      : { label: t("sandbox.block"), rule: "block" };
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

function backendDescription(snapshot: SandboxSnapshot, t: Translate): string {
  switch (snapshot.backend.state) {
    case "ready":
      return t("sandbox.ready");
    case "missing":
      return t("sandbox.missing", { installHint: snapshot.backend.installHint });
    case "signed-out":
      return t("sandbox.signedOut");
    case "unavailable":
      return t("sandbox.unavailable", {
        message: snapshot.backend.message ?? t("sandbox.unknownError"),
      });
  }
}

function sessionSummary(snapshot: SandboxSnapshot, t: Translate): string {
  const running = snapshot.sessions.filter((session) => session.state === "ready").length;
  const failed = snapshot.sessions.filter((session) => session.state === "failed");
  const parts = [
    t("sandbox.openThreads", { count: snapshot.sessions.length }),
    t("sandbox.runningCount", { count: running }),
    ...(failed.length > 0
      ? [
          t("sandbox.failedCount", {
            count: failed.length,
            message: (failed[0]?.message ?? "").replace(/\.\s*$/, ""),
          }),
        ]
      : []),
  ];
  return t("sandbox.sessionSummary", { summary: parts.join(" · ") });
}

function baseName(repoPath: string): string {
  return repoPath.split(/[\\/]/).filter(Boolean).pop() ?? repoPath;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
