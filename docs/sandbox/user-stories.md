# Remote workspace acceptance

The app opens repository URLs directly in Vercel Sandbox. Each thread owns its repository files; Pi, conversation history, settings and credentials stay on this computer. This replaces the earlier Docker bind-mount design.

## Open a repository

- Open repository accepts a public HTTPS Git URL and rejects local paths and embedded credentials.
- Registering a repository creates only local metadata, with no checkout or `.git` directory.
- New thread starts an independent remote clone. The interface has no local execution or worktree choice.
- Missing Vercel configuration reports an error and never runs a built-in tool on the host.
- Existing local histories remain readable; the app does not delete their source directories.

## Work on remote files

- Bash, read, write and edit operate on `/vercel/sandbox` through upstream Pi tools.
- Files lists and previews the selected thread’s remote checkout.
- Review compares the remote working tree, index, branches and captured turns.
- Staging changes the remote Git index. File changes between comparisons are rejected as stale.
- Pi’s model connections and credentials stay local. Repository instructions are fetched from the guest.
- Global extensions and MCP tools remain local; remote project extensions and skill discovery are outside this POC.

## Use a terminal

- The integrated terminal opens interactive bash in a real Linux PTY in the selected thread’s sandbox.
- Terminal writes appear in Files and Review without synchronization.
- Terminal resize reaches the PTY. Closing a tab terminates its shell descendants.
- Open terminal tabs prevent an idle stop. The sandbox’s compute deadline still ends running processes; the terminal can be restarted.

## Stop and recover

- Stop terminates an agent command’s process group and descendants.
- Interrupted commands are reported without automatically replaying them.
- Quitting the app stops its sandboxes. A later launch resumes the named sandbox’s saved filesystem in a new VM.
- Idle compute stops after ten minutes when no operation or terminal is active.
- Files and installed dependencies survive stop/resume. Processes do not.
- A missing previously created sandbox reports an error instead of cloning a replacement over lost work.

## Fork and switch threads

- Fork conversation preserves history through the selected response and copies the source thread’s current filesystem snapshot.
- The fork gets a separate sandbox; changing its files does not change the source.
- Switching threads switches Files, Review, terminal ownership and file mentions.
- Forking retains the source sandbox and its saved files.

## Follow-up scope

Private repository authentication, push credential brokering, export/download, local file imports, previews, remote project extension loading and skill discovery need their own implementation and acceptance checks. Internet access is unrestricted for the POC; the previous sbx network-rule controls have been removed.

See [implementation and verification](README.md) for commands, lifetime behavior and test evidence requirements.
