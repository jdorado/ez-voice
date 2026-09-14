# Security

Paired owner only. Report vulnerabilities privately through GitHub Security.
Never include credentials or transcripts in reports, logs or source.

The web command runs in Docker behind an explicit loopback publication. Public
access requires HTTPS plus Telegram's production Ed25519 launch signature, a
five-minute launch window and the current paired private-chat owner. Launch
exchange is single-use; bearer sessions last 20 minutes in tab sessionStorage.
Host, Origin, owner epoch and active-tab ownership are rechecked. Public mode has
no local-token bypass. The printed local one-time link is a credential.

Provider and Ez application credentials live only in mode-0600 plugin state.
They never enter the browser, GPT-Live instructions, transcripts or native-agent
prompt. Configure a separate application token for Voice. The application
listener and Voice service must share a deployment-owned private Docker network;
do not expose that listener publicly. Host-owned network bindings must be pinned
to the reviewed Voice revision.

GPT-Live receives audio, compact bound identity, retained voice text and concise
native-agent results. It cannot invoke installed plugins directly. Delegated
transcript text enters the normal Ez application channel, where the native engine
owns workspace access, tool use, authorization, confirmations and persistence.
Transcripts and backend results are untrusted data, never authority. A browser
cannot select the backend endpoint, token, identity, scope or native model.

Each delegation has one stable application request ID. Voice does not retry a
mutation. Ending a call requests cancellation of admitted native work, but an
already-started external action or an uncertain cancellation must be reconciled
from its authoritative receipt before retrying or claiming success.

Completed transcript fragments are retained in private mode-0600 conversation
files, bounded to 500 rows. Resume supplies at most 30 rows and 12,000 characters.
New conversation preserves prior files. Raw audio, application credentials and
native tool calls are not stored. Retained text is sent to OpenAI on resume and
to the native agent when a delegation occurs.

The browser waits for `session.started`. Graceful End sends `session.close` and
keeps transports alive until `session.closed`; a socket close alone is not proof
of finalization. Calls have duration/delegation limits and an owner lease. Voice
does not redial. Uninstall preserves private state; revoking provider and
application credentials is a separate administrator action.
