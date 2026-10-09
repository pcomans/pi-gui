# Tool sandbox

pi-gui runs pi's built-in tools in a local Linux micro-VM, one per thread, so a model-generated command cannot read or change anything on the machine beyond the thread's checkout. Pi itself, model calls, MCP servers and other extensions keep running on the host. The acceptance stories are in [user-stories.md](user-stories.md).

## What runs where

| Runs in the VM                                                              | Runs on the host                                 |
| --------------------------------------------------------------------------- | ------------------------------------------------ |
| `read`, `write`, `edit`, `bash` tools                                       | Pi, model requests and provider credentials      |
| `!` commands (pi's `user_bash`; pi-gui's composer does not send them today) | MCP servers and their tools                      |
| Everything those commands start: git, pnpm, tests                           | Other extensions' tools, the integrated terminal |

Pi's `grep`, `find` and `ls` tools are withdrawn in sandboxed threads (`exposure: "hidden"`), because pi runs ripgrep and fd on the host even when an extension supplies its own file operations. The model runs `rg`, `find` and `ls` through `bash` instead, inside the VM.

## How it works

The [sandbox owner](../../apps/desktop/electron/sandbox/sandbox-owner.ts) gives every session a hidden extension through the driver's `sessionExtensions` option. Users cannot switch it off in the extensions list; Settings > Sandbox turns it off for threads opened afterwards.

- **VM per thread.** [`SandboxSession`](../../apps/desktop/electron/sandbox/sandbox-session.ts) starts a [Gondolin](https://github.com/earendil-works/gondolin) VM on the first tool call and stops it after 10 idle minutes, when the thread closes, and when the app quits.
- **Same paths.** The checkout is mounted at its host path, so file paths, `git` metadata and transcript paths need no translation. A linked worktree also mounts its repository's shared git directory, so commits work; skill folders pi announces are mounted read-only.
- **Images.** The first VM in a profile builds a base image from Gondolin's Alpine image (git, ripgrep, gh, node, pnpm, curl). Later VMs resume from that checkpoint in tens of milliseconds. A project can add Alpine packages and setup commands in `.pi/sandbox.json`; each distinct file gets its own cached image. Images live in `<userData>/sandbox/images`.
- **Fail closed.** If the VM cannot start (no QEMU, image build failed), tool calls fail with the reason. They never fall back to the host.

### `.pi/sandbox.json`

```json
{
  "packages": ["python3", "make", "g++"],
  "setup": "pip install --break-system-packages uv"
}
```

`packages` are Alpine package names; `setup` is a shell script (or list of lines) run once as root while the image is built, without the project mounted. Changes in the guest outside the checkout (for example `apk add` in a thread) last until that thread's VM stops.

## Credentials

Real credentials never enter the VM. The host's `gh auth token`, when available, is registered with Gondolin as `GITHUB_TOKEN` and `GH_TOKEN`; the VM sees a placeholder, and Gondolin substitutes the real value only in requests to GitHub hosts. The base image's git credential helper sends that placeholder for HTTPS GitHub remotes. Commits use the host's `user.name` and `user.email` for the checkout.

## Network

All guest HTTP(S) traffic passes through Gondolin's host-side proxy. For each request the owner decides by the repository (a worktree uses its main checkout's rules):

1. A blocked host is refused.
2. In Allowlist mode, a host not on the allowlist is refused.
3. Otherwise the request goes through.

Refused requests get HTTP 403 with an explanation the model can report. Every decision is logged by host name with counts and the last thread (never URLs, headers or bodies) in `<userData>/sandbox/network-log.json`. Settings > Sandbox lists the log per repository and changes rules immediately, without restarting VMs. Private and loopback addresses are blocked by Gondolin; other TCP traffic is not forwarded.

## Limitations

- macOS and Linux only; QEMU must be installed (`brew install qemu`).
- File access goes through Gondolin's virtual file system: a ripgrep over a repository is roughly 20 times slower than on the host, and large installs take longer.
- Packages installed in a checkout from the VM are Linux builds; prefer a worktree when native modules are involved.
- MCP servers and extension tools are not sandboxed.

## Tests

- `pnpm test:desktop-unit` covers the settings store and network decisions.
- `pnpm --filter @pi-gui/desktop test:sandbox-vm` drives the extension against real VMs (needs QEMU).
- `apps/desktop/tests/core/sandbox.spec.ts` drives the built app with a scripted provider; it runs only with `PI_APP_SANDBOX_E2E=1` on a machine with QEMU.
