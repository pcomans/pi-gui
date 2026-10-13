# Tool sandbox

pi-gui runs pi's built-in tools in a [Docker Sandbox](https://docs.docker.com/ai/sandboxes/) (`sbx`, a Linux microVM), one per thread, so a model-generated command cannot read or change anything on the machine beyond the thread's checkout. Pi itself, model calls, MCP servers and other extensions keep running on the host. The acceptance stories are in [user-stories.md](user-stories.md).

An earlier version used Gondolin micro-VMs. Its file sharing ran at about 1.5 MB/s for small files (a pi-gui `pnpm install` took 15 minutes against 107 seconds in `sbx`), and idle VMs on macOS could not resume, so pi-gui switched to `sbx`.

## Requirements

- macOS or Linux with Docker Sandboxes installed and signed in: `brew install --cask docker/tap/sbx`, then `sbx login`.
- Settings > Sandbox shows whether `sbx` is ready. Until it is, sandboxed tools fail with the reason (they never run on the host); the sandbox can be turned off there.

## What runs where

| Runs in the sandbox                                                         | Runs on the host                                 |
| --------------------------------------------------------------------------- | ------------------------------------------------ |
| `read`, `write`, `edit`, `bash` tools                                       | Pi, model requests and provider credentials      |
| `!` commands (pi's `user_bash`; pi-gui's composer does not send them today) | MCP servers and their tools                      |
| Everything those commands start: git, pnpm, tests                           | Other extensions' tools, the integrated terminal |

Pi's `grep`, `find` and `ls` tools are withdrawn in sandboxed threads (`exposure: "hidden"`), because pi runs ripgrep and fd on the host even when an extension supplies its own file operations. The model runs `rg`, `find` and `ls` through `bash` instead, inside the sandbox.

## How it works

The [sandbox owner](../../apps/desktop/electron/sandbox/sandbox-owner.ts) gives every session a hidden extension through the driver's `sessionExtensions` option. Users cannot switch it off in the extensions list; Settings > Sandbox turns it off for threads opened afterwards.

- **A sandbox per thread.** On a thread's first tool call, [`SandboxSession`](../../apps/desktop/electron/sandbox/sandbox-session.ts) creates an `sbx` shell sandbox named `pi-gui-<thread>-<mounts>` (the first one downloads Docker's image), applies the repository's network rules, runs the one-time setup, and starts a small worker inside it with `sbx exec -i`. The sandbox keeps its state (installed packages) between calls and app launches.
- **Same paths.** `sbx` mounts the checkout at its host path, so file paths, `git` metadata and transcript paths need no translation. A linked worktree also mounts its repository's shared git directory; other worktrees' admin folders and pi's skill folders are mounted read-only.
- **The worker.** [`sandbox-worker.ts`](../../apps/desktop/electron/sandbox/sandbox-worker.ts) answers JSON lines over the `sbx exec` connection: commands (each in its own process group, so Stop kills everything they started) and file reads and writes. One connection per thread avoids `sbx exec`'s half-second start per tool call.
- **Lifecycle.** A sandbox stops after 10 idle minutes, when its thread is archived or closed, and when the app quits; the next tool call starts it again. A launch stops pi-gui sandboxes a crash left running. If the connection drops, the call that hit it fails (it may have partly run and is never repeated) and the next call reconnects. Settings can remove sandboxes no open thread uses, to free disk space.
- **Fail closed.** If the sandbox cannot start, tool calls fail with the reason. They never fall back to the host.
- **Writes stay visible.** `write` and `edit` refuse paths outside the checkout (except `/tmp`), because those would land on the sandbox's own disk.
- **Separate `node_modules`.** On every start (bind mounts end when a sandbox stops), [`SandboxSession`](../../apps/desktop/electron/sandbox/sandbox-session.ts) bind-mounts a folder on the sandbox's own disk (`/var/lib/pi-gui/node_modules/<hash of the path>`) over the checkout's `node_modules` and the one beside every git-tracked `package.json`, creating an empty `node_modules` on the host where none exists. The sandbox's Linux installs (native modules such as `node-pty`) stay inside it and persist with it, and the host's own `node_modules` stays untouched and hidden from the sandbox, which installs its own.

### `.pi/sandbox.json`

```json
{
  "packages": ["build-essential", "python3"],
  "setup": "pip install --break-system-packages uv"
}
```

This repository's own [`.pi/sandbox.json`](../../.pi/sandbox.json) adds build tools for `node-pty` and the official Node 22 build, since Ubuntu's Node cannot run the `.mts` tests.

`packages` are Ubuntu package names; `setup` is a shell script (or list of lines). Both run once as root when a thread's sandbox is created, with the project mounted. Every sandbox also gets pnpm, `safe.directory '*'` and `gc.worktreePruneExpire never`. The agent can install more itself with `sudo apt-get install`; that lasts for the thread's sandbox.

## Credentials

Real credentials never enter the sandbox. `sbx` keeps service secrets on the host (`sbx secret set github`, for example) and its proxy fills them in for requests; the sandbox sees placeholders such as `GH_TOKEN`. Commits use the host's `user.name` and `user.email` for the checkout.

## Network

`sbx`'s proxy enforces each sandbox's rules, which pi-gui keeps in step with the repository's settings (a worktree uses its main checkout's rules):

- Every sandbox gets an allow-everything rule, so it can reach any host.
- Each blocked host is a deny rule, which `sbx` applies over any allow, so blocking takes effect on the next request.
- Services on this Mac (`host.docker.internal`, `localhost`) are denied unless the person allows that exact name for the repository. Those two names are the only hosts that can be allowed; `allowedHosts` in `<userData>/sandbox/sandbox-settings.json` holds just them.

There is no allowlist mode for now. `sbx`'s global policy applies to all sandboxes and outranks their own allow rules; on its `allow-all` default an allowlist could not narrow anything, and making `sbx` deny by default also affects sandboxes outside pi-gui, so pi-gui does not change it. Settings files saved with the earlier Allowlist mode still load: their `defaultNetworkMode`, per-repository `mode` and allowlisted hosts are ignored and dropped on the next save.

pi-gui reads `sbx policy log` while sandboxes are open and adds its counts to a per-repository host log (host names, counts, times and the last thread; never URLs or contents) in `<userData>/sandbox/network-log.json`. Settings > Sandbox lists it with Block/Unblock buttons, and Allow buttons for the services on this Mac. Counting starts from what `sbx` reports when a run first uses a sandbox, so a relaunch does not count earlier traffic again. Raw TCP connections follow the rules but do not appear in `sbx`'s log.

## Limitations

- macOS and Linux only; `sbx` must be installed and signed in.
- Only `node_modules` folders are kept apart (see [How it works](#how-it-works)); other build output in the checkout, such as `dist` or caches, is shared with the host. `.pi/sandbox.json`'s `setup` runs before they are mounted, so it should not install into the checkout.
- MCP servers and extension tools are not sandboxed.

## Tests

- `pnpm test:desktop-unit` covers the settings store and which `node_modules` folders are mounted.
- `pnpm --filter @pi-gui/desktop test:sandbox` drives the extension against real `sbx` sandboxes (needs `sbx` signed in); it removes only the sandboxes it created.
- `apps/desktop/tests/core/sandbox.spec.ts` drives the built app with a scripted provider; it runs only with `PI_APP_SANDBOX_E2E=1` on a machine where `sbx` is ready.

## Vercel Sandbox POC

An opt-in remote backend keeps Pi, model connections, session history, MCP servers and extension
tools on the host, while the built-in tools and `!` commands run in one persistent Vercel Sandbox
per thread. Docker remains the default. Launch the development app with:

```sh
vercel login
PI_APP_SANDBOX_BACKEND=vercel \
VERCEL_TEAM_ID=team_your_team \
VERCEL_PROJECT_ID=prj_your_project \
pnpm dev
```

The main process uses `VERCEL_TOKEN` if supplied through your secret manager; otherwise it reads
the existing Vercel CLI login. Credentials stay on the host. Settings > Sandbox identifies the
active backend and its limitations. The SDK dependency includes piped stdin for the existing
JSON-line worker; command cancellation still kills the entire process group.

The first tool call uploads the checkout at the same absolute path and creates an independent Git
repository from its current files. Before and after each operation, three-way synchronization
compares the last shared version with the local and remote files. Changes made through bash are
included, along with binary files, executable permissions and deletions. Synchronization finishes
before tool results return, so Review and turn captures see the changes. Local/remote conflicts
fail the tool without overwriting local edits, and save remote versions under
`<userData>/sandbox/vercel/<thread>/recovery/`. Matching the local file to the remote version
resolves a conflict on the next call. Backups of overwritten/deleted local files are also retained
there. No uncertain tool operation is automatically replayed after a connection failure.

Sandboxes stop after 10 idle minutes or on thread close/app quit. Each VM session is configured for
30 minutes, and the app stops/resumes between operations when less than two minutes remain. The
filesystem and Linux dependencies persist; the worker starts again after resume. A tool still
running at the deadline is interrupted, rather than migrated or repeated. Snapshots have no
expiration in this POC; retained compute and snapshot storage are billed to the selected project.
Stopping removes running-compute usage, but retained snapshot storage continues to accrue charges.

POC boundaries:

- Requires a Git checkout. Transfers tracked and nonignored untracked files, capped at 10,000 files,
  64 MiB total and 16 MiB per file. `node_modules`, `.git`, `.context` and `.artifacts` are excluded.
- Supports relative symlinks within the checkout; rejects directory traversal, synchronization
  through directory symlinks, links outside the checkout and filenames that collide when case is
  ignored. Host dependencies and ignored build outputs stay local.
- Commits, branch changes, Git history, the index and Git credentials do not synchronize. Commit
  through the host terminal. Linked worktrees upload their files to independent remote repos.
- Global skills outside the checkout, local services, GitHub credential brokering, the outbound-host
  log and network-rule editing are outside this POC. The remote sandbox has Internet access.
  Repositories with saved blocked-host rules fail closed rather than ignoring those rules.
- File transfer runs at operation boundaries, not continuously during a long-running command.
  Synchronization is bounded and conflict-aware, but does not provide a filesystem transaction
  across concurrent local editors or background processes.
- Remote sandbox removal is manual; the app retains stopped sandboxes and recovery artifacts.
  This backend has not established production or packaged-app readiness.

For repeatable proof with a scripted Pi provider, real cloud infrastructure and visible Electron:

```sh
PI_APP_VERCEL_SANDBOX_E2E=1 \
VERCEL_TEAM_ID=team_your_team \
VERCEL_PROJECT_ID=prj_your_project \
pnpm --filter @pi-gui/desktop run test:e2e:runner -- \
  apps/desktop/tests/production/sandbox-vercel.spec.ts \
  --output .context/vercel-sandbox-proof
```

This test requires working Vercel authentication and incurs Sandbox usage. It verifies remote
bash/write/edit, local Review, Last turn, Stop including child processes, concurrent-edit recovery,
and persistence after app restart. It retains its scratch checkout, profile and stopped sandbox.
The unit lane covers synchronization independently of cloud access. The credential-free Core
spec checks missing configuration and saved blocked-host rules on the actual Settings surface,
and verifies failed sandbox tools never fall back to the host.

To include the separate real-model Electron proof, add these environment variables to the cloud
test command above, using an agent directory with working credentials:

```sh
PI_APP_REAL_AUTH=1 \
PI_APP_REAL_AUTH_SOURCE_DIR="$HOME/.pi/agent" \
PI_GUI_PROVIDER=vercel-ai-gateway \
PI_GUI_MODEL=anthropic/claude-haiku-4.5
```

That proof runs without test mode or main-process test hooks. It requires a visible, focused app,
actual remote bash/read output, a local file side effect and Last Turn Review. It copies only the
selected provider's auth into a private temporary directory outside the evidence folder and
retains it. This is targeted tool-sandbox coverage; the full `verify-pi-gui` conversation recipe,
native OS interactions and packaged launch remain separate lanes.
