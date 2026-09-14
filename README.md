# Ez Voice

Owner-authenticated voice for an Ez agent. The installed Docker plugin owns the live model,
agent identity, Markdown search/read and retained voice conversation. Core provides
one persistent `ez tools connect voice connect` connection and generic installed-plugin
dispatch. The bundled web client provides microphone, mute and call controls.
It contains no plugin-specific tool logic and invokes no second reasoning engine.

## Install and bind

Use the owning agent's absolute ez launcher. Inspect and install a reviewed package:

```sh
ez plugins inspect voice --source /absolute/reviewed/package
ez plugins install voice --source /absolute/reviewed/package --revision sha256:REVIEWED_HASH
ez plugins folder-bind voice --service voice --source /actual/agent/workspace --target /state/context
ez plugins start voice
```

Resolve workspace, name and purpose from the existing agent configuration. The mount
is read-only. Supply `{ "name": "agent-name", "purpose": "existing agent purpose" }`
to `ez voice bind` through stdin. SOUL.md and USER.md supply identity and owner context
from the mounted workspace, capped at 2,500 characters each. Missing files are optional.
New calls reload identity; browser requests cannot override identity, root or tools.

Supply `{ "apiKey": "YOUR_KEY", "model": "gpt-realtime-2.1", "voice": "marin" }`
to `ez voice configure` through private stdin. Never put credentials in argv or source.
`ez voice doctor` checks configuration; `ez voice health` checks the resident runtime.

## Browser and Telegram access

Start the resident runtime with `ez plugins start voice`, then serve the bundled
client through the owning agent's CLI:

```sh
ez tools serve 8791:8080 voice web --origin http://127.0.0.1:8791
```

Open the private one-time link printed on stdout. This exchanges the login secret
for a 20-minute browser session. The link is a credential: keep command output
private. The local mode works without Telegram or a telephone provider.

For Telegram, use a dedicated HTTPS origin forwarded to the same loopback port:

```sh
ez tools serve 8791:8080 voice web --origin https://voice.example.com --bot-id 123456789
```

The bot ID is the numeric public ID of the owning agent's Telegram bot, not its
secret token. Configure the relay's Compose environment or `.env`, then recreate its container:

```dotenv
EZ_TELEGRAM_WEB_APP={"command":"voice","label":"Voice","url":"https://voice.example.com/"}
```

The `/voice` command returns an Open Voice button and `/menu` includes Voice.
Standard commands remain available. Telegram supplies signed launch data;
Voice verifies Telegram's production Ed25519 signature, a five-minute launch
window, and the current paired private-chat owner through core. No bot token is
passed to Voice. A launch can be exchanged only once. Reopen the Mini App after
expiry. Unpairing or relinking invalidates existing sessions; requests and tool
calls recheck access, and the active-call lease checks at five-second intervals.
Group owners are not supported by this web entry point.

`tools serve` runs a connection container with an explicit **loopback-only** port
publication. The resident Voice container retains provider sessions and state;
the Voice web command container serves HTTP and forwards tool frames through core.
Neither container receives the Docker socket. Run the foreground command under
your host's normal service supervisor for unattended use. Stopping it closes the
connection and ends the call. There is no separate host web bridge.

A reverse proxy or tunnel must terminate HTTPS and preserve the configured Host
header, forward requests to `127.0.0.1:8791`, and avoid logging authorization headers
or request bodies. It must not cache authenticated responses. No domain, certificate
or public ingress is created automatically. Example Caddy configuration:

```caddyfile
voice.example.com {
    reverse_proxy 127.0.0.1:8791
}
```

Open `/voice` in the paired owner's private chat and press Start talking. Real
microphone, playback and interruption behavior must be tested on the target
Telegram clients; this release does not claim device compatibility from HTTP tests.
The same local browser client remains available for installations without Telegram.

Requires `@jc_stack/ez-agents` 0.1.0-beta.28 or newer for `tools serve`,
`tools.owner` and persistent connection support.
The old `examples/local-bridge.mjs` is removed: stop that QA process and use the
command above. Configuration, retained conversations and workspace binding are
unchanged. Do not run the old bridge and new web client simultaneously.

## Context tools and limits

context_search performs literal case-insensitive word search in Markdown paths/text.
An empty query lists files. A relative directory prefix narrows the search.
context_read returns numbered lines and a nextLine cursor. Both execute in the container.

Hidden paths, symlinks, generated/dependency directories and non-Markdown files are
excluded. Limits: 512 KiB per file, 120 lines/10,000 characters per read; 2,000 Markdown
files, 10,000 directories and 15 results per search. Truncation is explicit; narrow
the prefix before concluding something is absent.

## Installed plugins and resume

plugins_list reads the current registry; plugin_skill and plugin_help retrieve the
plugin's own usage. plugin_run accepts an alias, a JSON array of literal arguments
and output_name: an empty string for text output, or a simple filename for binary
stdout. On code 0, use result.artifact.path, bytes and sha256. The path is relative
to the owning workspace, under artifacts/; files remain there after sending.
No Library-specific bindings or per-plugin voice schemas exist. Registry changes are
visible on the next discovery request. Core checks alias/revision again at execution.
The connected plugin itself is excluded. The trusted owner connection uses the agent's
existing plugin permissions without a second voice approval prompt. The agent follows
the owner's request and each plugin's own authorization rules. End cancels pending commands; an
already-started external operation may still have an uncertain outcome. Core rejects
invocation when the owning native workspace has pending/running work.

Each call loads a bounded current core-command catalogue into its startup context,
including on resume. This is capability data, not action authorization; old assistant
claims cannot override current tools. If startup discovery is unavailable, the call
continues and can use core_tools to check again.

core_tools discovers native commands available to this connection. core_run invokes
the returned command name and literal arguments; read its --help first. The schedule
command can request
image/PDF processing through that agent's native tools and the installed Library
intake instructions, then search the source-linked text. It reuses Ez's scheduler
and native executor; voice does not implement OCR or another execution queue.
Submission returns a task receipt. Check native task status and indexed source
readback before reporting completion. The native task may finish after the call ends.

For an explicit message/file request, discover the native message command and use
its existing CLI directly through core_run. For example, after reading Library
help, retrieve a source with Library `get --raw` and a nonempty output_name, then
pass artifact.path from a successful result to the message command's `--document`
option. Core binds delivery to the owning connection's paired Telegram owner.
An explicit request needs no repeat
voice confirmation; verify the receipt before reporting sent. Respect discovery's
availability and limitations; do not retry uncertain delivery.
Message history requires a native run and is not available through this connection.

Completed text transcripts are atomically stored in the private plugin volume under
conversations/, with latest-conversation.json selecting the current conversation.
Resume talking restores up to 30 recent messages/12,000 characters into a new live
session. It restores text with original user/assistant roles, never old tool calls.
Each retained conversation is bounded to its latest 500 message items. New conversation
starts a new retained file and preserves the prior file. Interrupted assistant
transcripts are removed because the provider cannot align the text to played audio.
Raw audio is not stored.

This is the owning agent's identity/workspace in a distinct live-model context. Native
CLI chat is not inherited. Older-history search is not exposed in this increment.

End stops the call. Stopping the web connection requests hangup; a 60-second lease closes
abandoned sessions. Calls are capped at 20 minutes and 100 tool calls. Uncertain hangup
is reported without automatic redial. ez plugins stop voice stops the runtime;
uninstall preserves the private data volume.

Development: pnpm install --frozen-lockfile; pnpm verify; npm run release:check.
Build Docker test/runtime targets from the packed artifact and run docker/smoke.mjs.
See CONTRIBUTING.md and SECURITY.md. MIT licensed; provider usage is paid.
