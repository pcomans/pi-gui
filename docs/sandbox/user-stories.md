# Sandboxed Pi — User Stories

## Goal

Pi no longer runs with full access to my machine. Its built-in tools (`bash`, `read`, `write`, `edit`, `grep`, `find`, `ls`, and `!` commands) run inside a sandbox, and everything I rely on keeps working: my inference tokens, GitHub, MCP servers, worktrees and forks.

## Decisions so far

- **Backend:** [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/) (`sbx`, a Linux microVM per sandbox). Pi itself stays on the host; only tool execution is routed into the sandbox. (Gondolin was tried first and dropped: its file sharing made a pi-gui install take 15 minutes.)
- **Ownership:** a hidden pi-gui extension, injected through the driver's `sessionExtensions`, scoped per session (`ctx.cwd`, not `process.cwd()`).
- **One sandbox per thread**, mounting that thread's checkout at its own path (plus the main repository's `.git` for linked worktrees). It keeps its state until removed.
- **Credentials** stay on the host. `sbx` keeps service secrets and fills them in at its proxy; the sandbox sees placeholders.
- **Network:** sandboxes reach any host the user has not blocked, per repository; services on the host stay blocked unless allowed by name. Every outbound host is always recorded, and the user can block a host at any time. An **Allowlist** mode is deferred (see SBX-F1).

## Open questions

Each item lists a proposed default; confirm or change it before implementation.

| #   | Question                                                                                                      | Proposed default                                                         |
| --- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Q1  | Where do network rules live: global, per repository, or per thread?                                           | Decided: per repository (no global default while there is only one mode) |
| Q2  | In Allowlist mode, should an unknown host pause the request and ask live, or block and offer one-click Allow? | Block + one-click Allow (deferred with SBX-F1)                           |
| Q3  | Should threads in the main checkout (not a worktree) also be sandboxed?                                       | Yes, every thread by default                                             |
| Q4  | Does the integrated terminal for a sandboxed thread open in the sandbox or on the host?                       | Implemented: host, clearly labeled as unsandboxed                        |
| Q5  | Is there a per-thread "run unsandboxed" escape hatch, a per-call host approval, or neither?                   | Per-thread toggle with a persistent warning; no per-call approval in v1  |
| Q6  | Do changes outside the workspace (e.g. `apt-get install`) survive a sandbox restart?                          | Decided: yes, each thread's sandbox keeps its state until it is removed  |

## Story format

Each story has an ID, a priority, the story itself, and acceptance checks to run by hand on the real Electron app.

- **MVP**: required for the first usable version.
- **Later**: follow-up work.

---

## A. Setup and defaults

### SBX-A1 — Guided setup · MVP

**As a** pi-gui user, **I want** the app to detect whether sandboxing is ready and tell me exactly what's missing, **so I can** get a sandboxed thread working without reading docs.

- [ ] Without `sbx` installed (or signed in), the chip shows "Sandbox failed" with the install or `sbx login` command, before the first tool call.
- [ ] After installing and signing in, **Check again** in Settings and the next tool call work without restarting the app.
- [ ] On first use, the chip says the sandbox is being created and that the first time downloads Docker's image.
- [ ] A failed download (e.g. offline) shows an actionable error and a Retry.
- [ ] None of the above states ever runs a tool on the host.

### SBX-A2 — Sandboxed by default · MVP

**As a** pi-gui user, **I want** every new thread to run its tools in a sandbox without my having to opt in, **so I can** stop worrying about YOLO mode.

- [ ] A new thread in a fresh install is sandboxed with no settings changes.
- [ ] `!uname -a` in the composer reports Linux, not Darwin.

### SBX-A3 — Control the default · Later

**As a** pi-gui user, **I want** to set the sandbox default globally and override it per repository, **so I can** exempt a repo that can't run in Linux.

- [ ] Changing the global default affects new threads only, not running ones.
- [ ] A per-repo override wins over the global default.

---

## B. Everyday work inside the sandbox

### SBX-B1 — See sandbox status · MVP

**As a** pi-gui user, **I want** to see at a glance whether a thread is sandboxed and whether its sandbox is starting, ready, or failed, **so I can** trust where the agent's commands are running.

- [ ] The thread header shows Starting → Sandboxed while a new sandbox starts.
- [ ] Stopping the sandbox from outside (`sbx stop`) does not break the thread: the next tool call starts it again.
- [ ] An unsandboxed thread (if allowed, see Q5) shows a persistent, unmissable indicator.

### SBX-B2 — Agent edits show up normally · MVP

**As a** pi-gui user, **I want** files the agent writes in the sandbox to appear in my checkout immediately, **so I can** review, diff and commit as I do today.

- [ ] After the agent edits a file, it is changed on the host within a second.
- [ ] The Diff panel (Uncommitted, Staged, Unstaged, Branch) shows the change.
- [ ] **Last turn** review shows the turn's changes; checkpoints still capture.
- [ ] Opening the file in my editor shows the new content.

### SBX-B3 — Commands can't reach the rest of my machine · MVP

**As a** pi-gui user, **I want** the agent's commands confined to the thread's checkout, **so I can** know a bad command can't damage or read anything else.

- [ ] `ls ~`, `ls /Users`, `cat ~/.ssh/id_*` and `cat ~/.pi/agent/auth.json` fail or show nothing from the host.
- [ ] `ls ..` from the workspace root does not list sibling repositories.
- [ ] `read` and `write` to an absolute host path outside the checkout fail.
- [ ] `rm -rf /` (or an equivalent destructive command) damages nothing on the host; the thread keeps working (or gets a fresh sandbox once the broken one is removed).

### SBX-B4 — Composer `!` commands are sandboxed · MVP

**As a** pi-gui user, **I want** `!` commands I type to run in the same sandbox as the agent, **so I can** see exactly what the agent sees.

- [ ] `!pwd` shows the guest workspace path.
- [ ] `!touch probe.txt` creates `probe.txt` in the host checkout.

### SBX-B5 — My toolchain works · MVP

**As a** pi-gui user, **I want** to install dependencies, build and run tests inside the sandbox, **so I can** let the agent verify its own work.

- [ ] `git`, `node`, `pnpm`, `rg` and `gh` are available in the sandbox.
- [ ] `pnpm install` and `pnpm test` succeed for a typical JS repository.
- [ ] Linux-native dependencies installed in a worktree don't break the main checkout on the host (documented limitation if they do).

### SBX-B6 — Stop still stops · MVP

**As a** pi-gui user, **I want** the Stop button to kill a long-running sandboxed command, **so I can** regain control immediately.

- [ ] Stopping during `sleep 600` ends the run within 2 seconds.
- [ ] The next prompt in that thread runs normally.

### SBX-B7 — It's fast enough · MVP

**As a** pi-gui user, **I want** sandboxed tools to feel about as fast as host tools, **so I can** use sandboxing all day.

- [ ] A new thread's first tool call finishes in about 10 s; a stopped sandbox restarts in about 4 s; warm calls take well under a second.
- [ ] `read` and `grep` on a large repository are within X× of host speed (X set by the spike).
- [ ] Typing in a sandboxed thread while its sandbox starts is never blocked.

---

## C. Credentials

### SBX-C1 — Inference just works · MVP

**As a** pi-gui user, **I want** my configured models and provider logins to work unchanged, **so I can** chat without reconfiguring anything.

- [ ] Every provider that works today works in a sandboxed thread.
- [ ] No provider key or token is visible inside the sandbox (`env`, `cat ~/.pi/agent/*`, `grep -r sk- /`).

### SBX-C2 — GitHub over HTTPS · MVP

**As a** pi-gui user, **I want** `gh` and HTTPS git to use my GitHub credentials, **so I can** have the agent push branches and open PRs.

- [ ] `gh api user` returns my account.
- [ ] `git push` over HTTPS succeeds.
- [ ] `gh pr create` opens a PR.
- [ ] `echo $GITHUB_TOKEN` (or `gh auth token`) prints a placeholder, not the token on the host.
- [ ] `curl -H "Authorization: Bearer $GITHUB_TOKEN" https://example.com` sends the placeholder, not the token.

### SBX-C3 — GitHub over SSH · Later

**As a** pi-gui user who uses SSH remotes, **I want** `git push` over SSH to use my host ssh-agent, **so I can** push without copying keys into the sandbox.

- [ ] `git push` to a `git@github.com:` remote succeeds.
- [ ] No private key file exists in the sandbox.

### SBX-C4 — Commits are mine · MVP

**As a** pi-gui user, **I want** commits made in the sandbox to use my git name and email, **so I can** keep authorship consistent.

- [ ] `git log -1 --format='%an <%ae>'` after an agent commit matches my host git config.

### SBX-C5 — Other secrets · Later

**As a** pi-gui user, **I want** to add other secrets (e.g. an npm token) with the hosts each may be sent to, **so I can** use private registries and APIs safely.

- [ ] A secret configured for `registry.npmjs.org` is substituted only there.
- [ ] The UI lists secret names and allowed hosts, never values.

---

## D. MCP, extensions and skills

### SBX-D1 — MCP servers keep working · MVP

**As a** pi-gui user, **I want** my MCP servers to work in sandboxed threads, **so I can** keep my existing tools.

- [ ] A configured stdio MCP server's tools appear and run.
- [ ] A configured HTTP MCP server's tools appear and run.
- [ ] The UI makes clear that MCP tools run on the host, outside the sandbox.

### SBX-D2 — Extensions and extension views keep working · MVP

**As a** pi-gui user, **I want** Pi extensions, their tools and their desktop views to work as before, **so I can** sandbox without losing features.

- [ ] An extension-provided tool runs and is labeled as a host tool.
- [ ] An extension view opens and responds.

### SBX-D3 — Skills still load · MVP

**As a** pi-gui user, **I want** the agent to read my skills from the host, **so I can** keep using them without copying them into each sandbox.

- [ ] The agent can read a global skill and a project skill.
- [ ] Read access is limited to the skill files themselves, not their parent directories.

---

## E. Worktrees, forks and thread lifecycle

### SBX-E1 — New worktree, new sandbox · MVP

**As a** pi-gui user, **I want** creating a worktree thread to start a sandbox mounted on that worktree automatically, **so I can** start isolated work in one step.

- [ ] Creating a worktree thread shows sandbox Starting → Ready with no extra steps.
- [ ] Inside it, `git status`, `git branch`, `git commit` and `git log` all work (linked-worktree `.git` resolves).
- [ ] The commit is visible from the host checkout.

### SBX-E2 — Fork into its own sandbox · MVP

**As a** pi-gui user, **I want** forking a conversation to create a new worktree with its own sandbox, **so I can** explore an alternative without touching the original.

- [ ] Forking creates a new worktree and a new sandbox.
- [ ] The fork keeps the conversation history up to the fork point.
- [ ] Changes in the fork do not appear in the parent's checkout, and vice versa.

### SBX-E3 — Parallel threads are isolated from each other · MVP

**As a** pi-gui user, **I want** each thread's sandbox to see only its own checkout, **so I can** run several agents at once safely.

- [ ] Thread A cannot list or read thread B's worktree.
- [ ] Two threads can run long commands at the same time without interfering.
- [ ] Stopping one thread does not affect the other.

### SBX-E4 — Child threads are sandboxed too · MVP

**As a** pi-gui user, **I want** orchestrated child threads and scheduled tasks to run sandboxed like any other thread, **so I can** trust background work.

- [ ] A child thread shows its own sandbox status and runs tools in a sandbox.
- [ ] A scheduled task's run executes its tools in a sandbox.

### SBX-E5 — Survives restart · MVP

**As a** pi-gui user, **I want** to quit the app, reopen it and continue a sandboxed thread, **so I can** pick work back up.

- [ ] After restarting, sending a prompt starts the thread's sandbox again and the conversation continues.
- [ ] Uncommitted changes in the checkout are intact.
- [ ] No pi-gui sandboxes are left running after quitting; after a crash, the next launch stops them.

### SBX-E6 — Archiving cleans up · MVP

**As a** pi-gui user, **I want** archiving a thread to stop its sandbox, **so I can** avoid idle VMs using memory.

- [ ] After archiving, the thread's sandbox is stopped.
- [ ] Unarchiving and sending a prompt starts it again.
- [ ] Worktree handling on archive is unchanged from today.

### SBX-E7 — Idle sandboxes don't pile up · Later

**As a** pi-gui user with many threads, **I want** idle sandboxes to stop automatically and restart on demand, **so I can** keep many threads open without exhausting memory.

- [ ] A thread idle past the timeout stops its sandbox.
- [ ] The next tool call restarts it transparently, showing Starting in the header.

---

## F. Network control

### SBX-F1 — Choose a network mode · Deferred

**As a** pi-gui user, **I want** to choose between **Allow all** and **Allowlist** for sandbox network access, **so I can** trade convenience for control.

Deferred: `sbx`'s global policy outranks a sandbox's own allow rules, and on its `allow-all` default it lets every sandbox reach any host, so an allowlist cannot narrow anything. Changing that policy affects sandboxes outside pi-gui, so pi-gui leaves it alone and offers only blocking (SBX-F3) until `sbx` can deny by default per sandbox.

- [ ] Mode is set in settings at the scope agreed in Q1.
- [ ] The current mode is visible from the sandbox status.

### SBX-F2 — See every host the sandbox contacts · MVP

**As a** pi-gui user, **I want** a log of every outbound host, **so I can** see what my agents talk to.

- [ ] After `curl https://example.com`, `example.com` appears with thread, time, count and Allowed.
- [ ] Blocked attempts appear as Blocked.
- [ ] The log records host names only, never full URLs, headers or bodies.
- [ ] The log survives an app restart.

### SBX-F3 — Block a host at any time · MVP

**As a** pi-gui user, **I want** to block a host from the log, **so I can** cut off unwanted traffic without restarting anything.

- [ ] After blocking `example.com`, the next `curl https://example.com` fails in the same running thread.
- [ ] The agent sees a clear "blocked by sandbox network policy" error, not a hang.
- [ ] Unblocking restores access.

### SBX-F4 — Allow a host in Allowlist mode · Deferred

Deferred with SBX-F1, for the same reason. Allowing a service on the host by name stays in SBX-F5.

**As a** pi-gui user in Allowlist mode, **I want** blocked hosts surfaced with a one-click Allow, **so I can** grow the list as work needs it.

- [ ] A request to an unlisted host is blocked and appears in the log with **Allow**.
- [ ] After **Allow**, retrying succeeds without restarting the thread.
- [ ] (If Q2 chooses a live prompt) the prompt appears while the request waits and times out safely.

### SBX-F5 — Local network is opt-in · MVP

**As a** pi-gui user, **I want** the sandbox blocked from `localhost` and private network ranges unless I allow them, **so I can** keep it away from my local services and LAN.

- [ ] `curl http://host.docker.internal:3000` (or an equivalent route to the host) fails by default.
- [ ] Explicitly allowing a local host makes the dev server reachable.

### SBX-F6 — Non-HTTP traffic is visible or blocked · MVP

**As a** pi-gui user, **I want** raw TCP connections (e.g. a remote Postgres) blocked unless I map them, **so I can** be sure nothing leaves the sandbox unseen.

- [ ] `nc example.com 5432` follows the same rules (a blocked host is refused). Known gap: raw TCP does not appear in `sbx`'s policy log, so it is not listed.
- [ ] The attempt appears in the log.

---

## G. Failure and escape hatches

### SBX-G1 — Fail closed · MVP

**As a** pi-gui user, **I want** tools to fail rather than fall back to the host when the sandbox is unavailable, **so I can** trust that "sandboxed" always means sandboxed.

- [ ] With `sbx` missing or signed out, tool calls return a sandbox error; nothing runs on the host.
- [ ] Chatting (no tools) still works.
- [ ] **Retry** in the status brings the sandbox back.

### SBX-G2 — Recover from a sandbox crash · MVP

**As a** pi-gui user, **I want** the sandbox to restart after a crash, **so I can** keep working without restarting the thread.

- [ ] A tool call interrupted by a crash fails and is not replayed.
- [ ] The next tool call reconnects to the sandbox.

### SBX-G3 — Deliberately run unsandboxed · Later (depends on Q5)

**As a** pi-gui user, **I want** to explicitly turn off sandboxing for one thread, **so I can** do host-only work (e.g. macOS-specific builds) without leaving the app.

- [ ] Turning it off requires a confirmation that names the risk.
- [ ] The thread shows a persistent "Unsandboxed" indicator.
- [ ] The setting does not leak to other or new threads.

---

## H. Transparency

### SBX-H1 — Know where each tool ran · MVP

**As a** pi-gui user, **I want** each tool row in the transcript to show whether it ran in the sandbox or on the host, **so I can** audit a run afterwards.

- [x] Built-in tool rows are marked Sandbox.
- [ ] MCP and extension tool rows are marked Host.

### SBX-H2 — Inspect a sandbox · Later

**As a** pi-gui user, **I want** a details view for a thread's sandbox (mounts, network mode, secret names and allowed hosts, resources), **so I can** verify what it can reach.

- [ ] The view lists the mounted checkout and `.git` paths.
- [ ] It lists secret names and hosts, never values.

---

## Manual acceptance setup

Fixtures needed to run these stories:

- A test GitHub repository with HTTPS and SSH remotes, and permission to push branches and open PRs.
- One stdio MCP server and one HTTP MCP server configured in Pi.
- One Pi extension with a tool and a desktop view.
- A global skill and a project skill.
- A local dev server on the host (e.g. `python3 -m http.server 3000`).
- A launch with `sbx` off the PATH (`PI_APP_TEST_EXACT_PATH=1`) for SBX-A1 and SBX-G1.
