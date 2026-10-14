# Remote workspaces

pi-gui opens repository URLs in [Vercel Sandbox](https://vercel.com/docs/sandbox), with a persistent named sandbox for each thread. There is no local checkout, bind mount, or file synchronization. Pi and the desktop interface run locally.

| In the sandbox                                         | On this computer                                         |
| ------------------------------------------------------ | -------------------------------------------------------- |
| Repository files, full Git history, branches and index | Pi runtime, model connections and credentials            |
| Read, write, edit and bash tools                       | Conversation history, settings and drafts                |
| Files, Review, staging and turn captures               | MCP servers and extension tools                          |
| Interactive bash terminals and dependencies            | Small repository/session metadata and Vercel credentials |

Open repository in the sidebar accepts a public HTTPS Git URL. Each new thread clones the repository independently. Fork conversation copies the source thread’s current saved filesystem into a new sandbox. A saved local workspace remains in the history catalog; start a repository URL workspace to execute tools remotely. Existing histories and local checkouts are not deleted.

## Run the POC

Sign in with `vercel login`, then provide the owning Vercel project:

```sh
export VERCEL_TEAM_ID=team_example
export VERCEL_PROJECT_ID=prj_example
pnpm dev
```

`VERCEL_TOKEN` can also be supplied through the environment. The app otherwise reads the existing Vercel CLI login. Model authentication remains in Pi’s normal local agent profile. Settings → Sandbox reports configuration; execution always uses Vercel. There is no host tool fallback or sandbox-off switch.

Settings → Kit connects the published `@vercel/kit` 0.15.0 SDK to your Kit account
through browser OAuth with PKCE. Refresh Kit after authorizing, then select a
**Kit AI Gateway** model under Models for an open repository. Kit provides its
service and skill tools through Pi's extension API; permissions and approvals
remain in Kit. Its agent tokens are encrypted with OS credential storage and
refreshed by the SDK. Gateway keys stay in main-process memory, separate from
Pi's provider credentials and the sandbox. Kit installation currently requires
access to the private Vercel npm scope.

Kit does not move Pi or command-based MCP servers remotely and does not supply
Git's authenticated clone/push transport. See [MISSING.md](../../MISSING.md) for
the explicit remaining features and limitations.

For this workspace, `.context/run-vercel-poc.sh` supplies the selected `pi-gui-sandbox-poc` project and isolated profile. It opens this repository’s GitHub URL rather than copying the local Conductor checkout. Unpushed local edits are therefore not part of a sandbox clone.

## Implementation

The [sandbox owner](../../apps/desktop/electron/sandbox/sandbox-owner.ts) provides a hidden extension through the Pi driver’s supported `sessionExtensions` option. Upstream Pi owns agent execution; the desktop supplies tool operations and capture observers.

The [Vercel session](../../apps/desktop/electron/sandbox/sandbox-vercel.ts) clones directly in the sandbox. The managed image chooses its initial clone directory; the app moves that guest checkout once to `/vercel/sandbox`, the stable tool cwd. A worker answers JSON lines over the SDK’s stdin/stdout connection. File operations transfer only requested content. Commands have separate process groups, and Stop kills their descendants without replaying them.

The existing [Review owner](../../apps/desktop/electron/workbench/review-owner.ts), Git adapters and [turn checkpoint store](../../apps/desktop/electron/workbench/checkpoint-store.ts) are bundled into a guest service. Main validates thread ownership and routes narrow requests. Working-tree and index comparisons, stale-file detection, staging and immutable turn captures keep their existing implementation, running next to the actual repository. File previews use the same guest path validation and size limits. Review comparison handles expire when a worker is replaced; Refresh creates a new comparison.

The [terminal service](../../apps/desktop/electron/sandbox/remote-terminal.ts) connects xterm to a Linux PTY in the same sandbox. Python’s standard `pty` module bridges terminal bytes and resize controls over the worker pipe. Terminal tabs belong to their originating window and thread. Closing a tab kills its remote shell descendants.

Repository URLs are stored in the catalog. A stable directory under `userData/remote-workspaces/` provides Pi’s local cwd/session identity and settings storage; it contains no repository source. The renderer continues to use a narrow preload API.

## Lifetime and recovery

Sandboxes use 30-minute compute sessions and persistent snapshots with no expiration. Idle compute stops after ten minutes when no operation or terminal is active; archiving a thread or quitting the app also stops its sandbox. Between operations, a session near its deadline stops and resumes on the next operation, unless a terminal is open. The named sandbox resumes its filesystem in a new VM; running processes do not survive a stopped VM. Interrupted operations report failure and are never automatically replayed. Restart the terminal after a connection loss.

A small local creation marker distinguishes a new thread from a previously provisioned sandbox. If a previously created sandbox is missing, the app fails instead of cloning a replacement over the lost state. Restoring that sandbox requires an explicit recovery decision. Crashed app sessions remain bounded by the sandbox timeout. Stopped snapshots still incur storage usage; this POC retains them for recovery and inspection.

## Current scope

Public HTTPS repositories and unrestricted sandbox internet access are supported. Private-repository authentication, credential brokering for push, explicit export/download, importing local file attachments, remote project extension loading, and remote project skill discovery need separate work. Global Pi extensions and MCP stay local. Root `AGENTS.md`/`CLAUDE.md` content is fetched from the guest before agent execution. `.pi/sandbox.json` can add Ubuntu packages and setup commands, which run once per configuration in the guest.

No Docker daemon or sbx login is needed. The prior sbx backend, host terminal service, checkout reconciliation and bind-mount code have been removed.

## Verification

`pnpm check` covers repository checks and units. `remote-workbench.spec.ts` verifies URL/metadata handling and the existing guest Review, staging, stale comparisons and turn-capture semantics against a separate Git fixture.

`tests/core/sandbox-vercel-config.spec.ts` drives the repository URL dialog and proves missing cloud configuration fails without a host file write. `tests/production/sandbox-vercel.spec.ts` is opt-in:

```sh
PI_APP_VERCEL_SANDBOX_E2E=1 \
VERCEL_TEAM_ID=team_example VERCEL_PROJECT_ID=prj_example \
pnpm --filter @pi-gui/desktop run test:e2e:runner -- \
  apps/desktop/tests/production/sandbox-vercel.spec.ts
```

The scripted-provider test uses real Vercel compute through Electron for tools, Files, Review, staging, PTY, cancellation, stop/resume and isolated snapshot forks. The second test additionally requires `PI_APP_REAL_AUTH=1`, `PI_APP_REAL_AUTH_SOURCE_DIR`, `PI_GUI_PROVIDER` and `PI_GUI_MODEL` and drives an actual provider with test hooks absent. Neither fixtures nor a skipped provider test count as real-provider proof.

`tests/core/kit-settings.spec.ts` verifies the real Settings surface with a local
OAuth issuer, encrypted persistence, service discovery and disconnect. The
opt-in `tests/production/kit-vercel.spec.ts` uses actual browser authorization,
a Kit model and tools, and Vercel compute with test hooks absent:

```sh
PI_APP_KIT_E2E=1 \
VERCEL_TEAM_ID=team_example VERCEL_PROJECT_ID=prj_example \
pnpm --filter @pi-gui/desktop run test:e2e:runner -- \
  apps/desktop/tests/production/kit-vercel.spec.ts --retries=0
```

Authorize pi-gui in the browser opened by the test. `PI_APP_KIT_PROFILE` can reuse
the retained private test profile to verify saved sign-in after restart. Do not
include that credential-bearing directory in shared proof artifacts.
