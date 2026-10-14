# Missing features in the remote workspace POC

This is a proof of concept, not a complete cloud agent. Kit is the service
authentication and permissions layer; it does not move Pi or arbitrary MCP
servers into a sandbox. This file records app gaps, including capabilities Kit
already has that this app has not integrated.

## Execution and authentication

| Missing feature                                   | Current behavior                                                                 | What is needed                                                                                           |
| ------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Pi running in the sandbox                         | Pi and its model connection run on this computer. Repository tools run remotely. | A remote Pi process, event transport, durable session ownership, and reconnect.                          |
| Agents continuing while this computer sleeps      | The sandbox can remain running, but local Pi stops progressing.                  | Remote Pi plus authentication that refreshes without the desktop.                                        |
| Process-based MCP servers in the sandbox          | Pi launches command-based MCP servers locally.                                   | Install and launch Linux-compatible servers remotely; route their tools back to Pi.                      |
| Private Git clone and authenticated push          | Repository onboarding supports public HTTPS Git sources.                         | A Git transport adapter. Kit's GitHub REST/MCP operations are not `git clone` or `git push`.             |
| Forwarding every existing host login              | Host credential files, browser cookies, and SSH agents are not copied.           | Supported per-service connections or adapters; Kit authorization is separate from arbitrary host logins. |
| Per-thread Kit identities                         | All threads share one Kit agent identity for this desktop profile.               | Separate revocable agent identities and grants for individual threads.                                   |
| Automatic migration of existing model credentials | Existing Pi provider credentials remain separate.                                | An explicit supported migration; Kit models use Kit-managed AI Gateway access and billing.               |
| In-app Kit approvals                              | Kit owns grants and approval pages.                                              | A native approval presentation and safe continuation, if needed. The app must not auto-approve writes.   |
| Cloud revocation on disconnect                    | Disconnect clears local tokens; Kit grants and model keys remain managed in Kit. | A verified revocation flow. Revoke the agent in Kit to withdraw cloud access.                            |
| Cancelling dispatched Kit actions                 | Stop releases Pi's turn, but a dispatched Kit action may still finish remotely.  | Kit-side action cancellation or outcome reconciliation. Check the result before retrying a mutation.     |
| Kit MCP transport and arbitrary MCP passthrough   | Kit's published tool table is adapted to Pi using its SDK REST calls.            | Remote MCP process/transport support. A host `mcp.json` login is not automatically a Kit connection.     |

## Lifetime, recovery, and storage

| Missing feature                         | Current behavior                                                                  | What is needed                                                                                                        |
| --------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Using the Pro 24-hour lifetime          | The POC explicitly requests 30-minute sessions.                                   | A configurable plan-aware timeout and verification of long-running work.                                              |
| Restoring running processes             | Snapshots restore the filesystem, not terminals or dev servers.                   | Restartable process definitions and visible recovery status. Interrupted commands must not be replayed automatically. |
| Snapshot retention and quota management | Snapshots have no expiration. Stopped sandboxes retain storage usage.             | Retention policy, storage visibility, and deliberate cleanup. Snapshot quota has already blocked testing.             |
| Recovery after a sandbox is deleted     | The app retains metadata and fails closed rather than cloning over missing state. | An explicit restore/import flow. Local conversation history is not a backup of remote repository files.               |
| Export/download and independent backup  | Edits and commits remain in the remote sandbox.                                   | Download/export and a supported push flow.                                                                            |

## Repository and desktop compatibility

| Missing feature                                       | Current behavior                                                                         | What is needed                                                                                                     |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Local file imports                                    | Opening a Git URL clones pushed content only.                                            | Explicit upload/import for local edits and attachments.                                                            |
| Project extensions and skill discovery in the sandbox | Global extensions remain local; root AGENTS.md/CLAUDE.md is fetched remotely.            | Remote resource discovery/loading with clear trust and path boundaries. Kit skills are a separate service surface. |
| Preview forwarding                                    | No integrated browser preview of remote localhost services.                              | Port exposure, preview URLs, and lifecycle handling.                                                               |
| Migration of saved local workspaces                   | Existing histories and checkouts are retained; tools require a repository URL workspace. | A deliberate migration/import flow.                                                                                |
| Mac-only tools and host services                      | The guest runs Ubuntu Linux.                                                             | Linux replacements or explicit host adapters; these cannot automatically become sandbox processes.                 |

## Verification and distribution

- Full historical desktop/native/packaged verification has not been migrated
  and rerun against remote workspaces. Focused Electron proof is not full release
  qualification.
- Large repositories, many concurrent threads, and 24-hour runs have not been
  benchmarked or verified.
- Kit is currently a private package requiring access to the Vercel npm scope.
  Public installation and distributable packaged-app support need verification.
- Browser sign-in, encrypted credential persistence, rotating token refresh and
  local disconnect have been verified. A real Kit AI Gateway model called a Kit
  tool and edited a remote repository through visible Electron; Files and Review
  showed the change with test hooks absent and Pi's `auth.json` empty.
- This test account has no GitHub connection in Kit. The real service attempt
  returned Kit's connection/approval link. An authenticated GitHub read and
  other upstream service operations still require their own live verification.

## Implemented Kit integration

The app pins the published `@vercel/kit` SDK to `0.15.0`. Settings → Kit signs in
with native OAuth and PKCE, stores agent tokens using OS-backed encryption,
lists connected services, and links to Kit for permissions and activity. The SDK
refreshes rotating tokens and runs Kit's service/skill tools under their existing
permission rules. The app does not request Kit's administrative approval scope.

Models from **Kit AI Gateway** use Kit-managed access; keys stay in main-process
memory and are not written to Pi's `auth.json`, exposed to the renderer, or sent
to repository bash. Existing providers continue using their own authentication.
Pi itself still runs on the host.

## Overlap with v and eve-code

The local `~/Vercel/internal-agents` checkout already has substantial coding
infrastructure. v mounts `eve-code` for editing tools, investigation/PR skills,
worker agents and sandbox tooling. Its GitHub command adapter requests
repository-scoped GitHub App tokens through Vercel Connect, substitutes them
through a temporary sandbox network-policy lease, and supports authenticated
clone/fetch/push. Eve owns durable cloud sessions and reconnecting streams.

These are reusable precedents for several gaps above, rather than new capabilities
this desktop app needs to invent. The desktop's Review, staging, Files, terminals,
conversation forks and Pi extension/provider support remain useful product work.
Further backend work should first evaluate sharing sandbox and credential-broker
code from that implementation.

`eve-code` is an Eve extension, not a drop-in Pi extension. v's GitHub identity is
an organization-scoped app identity; Kit connections are personal, user-authorized
identities. Reusing either requires a deliberate adapter and permission model.
Replacing Pi with v/Eve would change the agent runtime and is outside this POC.

See [remote workspaces](docs/sandbox/README.md) for implemented repository behavior
and [Kit](https://github.com/vercel/kit) for the upstream service.
