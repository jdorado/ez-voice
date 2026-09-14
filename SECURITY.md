# Security

Trusted local owner only. Report vulnerabilities privately through GitHub Security.
Never include credentials or transcripts.

The temporary bridge binds 127.0.0.1, checks Host/Origin and requires a random bearer
token stored in tab sessionStorage. Do not tunnel it. The installed container owns
provider credentials, agent identity and context tools. Configuration is mode 0600.
The browser cannot choose tools, identity or root. Core connects one command container
through the bound registry; no Docker socket or shell is exposed to the voice model.
Workspace tools execute in the voice container. Generic plugin requests execute via
core's installed-plugin dispatcher. Core separates plugin requests from client approvals:
the owner approves exact arguments in the page; the plugin cannot approve itself.
Discovery, help and declared skill reads do not require command approval. Native CLI
semantics remain those of the installed plugin, so review the exact command before
approving it. Plugin stdout is returned to the live model and may contain private data.

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
