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

### `.pi/sandbox.json`

```json
{
  "packages": ["build-essential", "python3"],
  "setup": "pip install --break-system-packages uv"
}
```

`packages` are Ubuntu package names; `setup` is a shell script (or list of lines). Both run once as root when a thread's sandbox is created, with the project mounted. Every sandbox also gets pnpm, `safe.directory '*'` and `gc.worktreePruneExpire never`. The agent can install more itself with `sudo apt-get install`; that lasts for the thread's sandbox.

## Credentials

Real credentials never enter the sandbox. `sbx` keeps service secrets on the host (`sbx secret set github`, for example) and its proxy fills them in for requests; the sandbox sees placeholders such as `GH_TOKEN`. Commits use the host's `user.name` and `user.email` for the checkout.

## Network

`sbx`'s proxy enforces each sandbox's rules, which pi-gui keeps in step with the repository's settings (a worktree uses its main checkout's rules):

- **Allow all** adds an allow-everything rule to the sandbox; **Allowlist** adds one allow rule per listed host.
- Each blocked host is a deny rule, which `sbx` applies over any allow, so blocking works in every mode and takes effect on the next request.
- `sbx`'s global policy applies to all sandboxes. When it allows every host (its `allow-all` default), an allowlist cannot narrow it; Settings says so. Making `sbx` deny by default also affects sandboxes outside pi-gui, so pi-gui does not change it.

pi-gui reads `sbx policy log` while sandboxes are open and adds its counts to a per-repository host log (host names, counts, times and the last thread; never URLs or contents) in `<userData>/sandbox/network-log.json`. Settings > Sandbox lists it with Allow/Block buttons.

## Limitations

- macOS and Linux only; `sbx` must be installed and signed in.
- Packages installed into a checkout from the sandbox are Linux builds; prefer a worktree when native modules are involved, so the main checkout's own `node_modules` stays usable on the host.
- MCP servers and extension tools are not sandboxed.

## Tests

- `pnpm test:desktop-unit` covers the settings store.
- `pnpm --filter @pi-gui/desktop test:sandbox` drives the extension against real `sbx` sandboxes (needs `sbx` signed in); it removes only the sandboxes it created.
- `apps/desktop/tests/core/sandbox.spec.ts` drives the built app with a scripted provider; it runs only with `PI_APP_SANDBOX_E2E=1` on a machine where `sbx` is ready.
