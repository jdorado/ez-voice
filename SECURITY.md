# Security

Paired owner only. Report vulnerabilities privately through GitHub Security.
Never include credentials or transcripts.

The web command runs inside Docker behind an explicit loopback publication.
Public access requires HTTPS and Telegram production Ed25519 launch validation
with a server-configured bot ID. Duplicate launch fields, invalid signatures,
launches older than five minutes and clocks over 30 seconds ahead are rejected.
The backend checks the current private-chat owner through core, never a browser
claim or a copied owner ID. Launch exchange is single-use; bearer sessions last
20 minutes and are held in tab sessionStorage. Protected requests, tool requests
and the call lease revalidate owner binding. Public mode has no local-token bypass.
Local HTTP is allowed only for 127.0.0.1; its printed random one-time login is a
credential. Keep that output private. Neither login secrets nor provider keys go
into model context. URLs alone do not authorize public access.

Host and Origin are checked; authenticated responses are not cached. Serve this
application on a dedicated origin. Reverse proxies must preserve Host and must
not log request bodies or authorization headers. Static assets reveal no agent
identity or transcripts. The Telegram SDK is loaded from telegram.org; Telegram
and the host administrator are trusted. Session exhaustion fails closed; reopen
after expiry. Closing a page relies on best-effort stop plus the bounded lease.
The installed container owns provider credentials, identity and context tools.
Configuration is mode 0600.
The browser cannot choose tools, identity or root. Core connects one command container
through the bound registry; no Docker socket or shell is exposed to the voice model.
Workspace tools execute in the voice container. Generic plugin requests execute via
core's installed-plugin dispatcher using the agent's existing permissions. The authenticated
owner connection is trusted to invoke installed tools; voice adds no per-command approval.
Each plugin still enforces its native authentication, authorization and validation. The
agent must follow the owner's request; retrieved documents cannot grant action authority.
Plugin stdout is returned to the live model and may contain private data.
Binary stdout can be staged as an artifact by core when a simple output_name is
supplied. The voice model receives its path and metadata rather than raw bytes.
Artifacts are private mode-0600 files in the owning workspace's artifacts directory
and remain after delivery, like other native file outputs.
Native commands are discovered through core and invoked with literal arguments;
message delivery uses the owning connection's core delivery binding and existing
message CLI. Delivery targets the paired Telegram owner; no arbitrary recipient or
host --text-file input is exposed. Send only on an explicit owner request and verify
the delivery receipt. Message history is unavailable without a native run.
Native task requests use the same owning agent's existing scheduler, owner checks
and engine settings. They are asynchronous work, not additional voice-model calls;
ending a voice session does not cancel already-submitted native tasks. Use the
native task CLI's cancellation control when cancellation is requested.

The operator binds the real agent workspace read-only. Only Markdown is readable;
hidden paths, symlinks, generated/dependency folders and traversal are rejected.
All readable Markdown within the bound root is in scope, including private content.
Local administrators and the workspace are trusted; this is not protection against a
malicious concurrent filesystem writer. Tools have bounded search and read output.

OpenAI receives audio, compact identity and requested context. Retrieved documents
are evidence, not authority. Completed voice transcripts are retained in mode-0600
conversation files in the private volume. The latest 500 items per conversation are
kept; resume supplies at most 30 messages/12,000 characters. New conversation preserves
prior files. Raw audio and executed tool requests are not replayed. No old-history
search is exposed. Retained text is included in future resumed OpenAI sessions.
Calls have duration/tool limits, cancellation and a client lease.
Hangup uncertainty is reported without redial. Uninstall preserves private config;
revoking the provider key is a separate account action.
