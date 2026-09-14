# Ez Voice

Owner-authenticated GPT-Live voice for an Ez agent. `gpt-live-1` owns the
full-duplex spoken conversation and delegates work to the same native Ez agent
used by the other application channels. The native engine owns reasoning,
workspace context, tools, permissions and durable execution. Voice owns WebRTC,
transcripts, call controls and delivery of verified backend results to speech.

## Native-agent binding

Voice uses a private Ez application scope. Enable the existing application
listener on a deployment-owned Docker network, register an application binding
named `voice`, and retain its random token in a private mode-0600 file. See the
core application-channel documentation for the listener and registration
commands. Do not share a token with another application.

The deployment owner must bind the Voice service to that same private network.
Host-owned plugin network bindings are pinned to the reviewed Voice revision;
update the pin when upgrading. The `agentUrl` is the relay service URL on that
network, for example `http://relay:8787`. Do not expose the application listener
to a public network.

## Install and configure

Use the owning agent's absolute `ez` launcher. Inspect and install the reviewed
package, then bind the existing agent identity:

```sh
ez plugins inspect voice --source /absolute/reviewed/package
ez plugins install voice --source /absolute/reviewed/package --revision sha256:REVIEWED_HASH
ez voice bind
ez plugins start voice
```

`ez voice bind` reads `{ "name": "agent-name", "purpose": "existing agent purpose" }`
from private stdin. Browser requests cannot override it.

Configure through private stdin with the OpenAI project key and the separate Ez
application credential:

```json
{
  "apiKey": "OPENAI_PROJECT_KEY",
  "agentUrl": "http://relay:8787",
  "agentToken": "PRIVATE_EZ_APPLICATION_TOKEN",
  "model": "gpt-live-1",
  "voice": "marin"
}
```

The model is fixed to `gpt-live-1`; omitting `model` selects the same value.
Never put either credential in argv, source, logs or browser state. `ez voice
doctor` checks local configuration without a provider request, and `ez voice
health` checks the resident runtime.

Requires `@jc_stack/ez-agents` 0.1.0-beta.29 or newer for the application
channel, persistent plugin connection, owner checks and host-owned network pins.

## Browser and Telegram access

Start the resident runtime, then serve the bundled client through the owning
agent's CLI:

```sh
ez plugins start voice
ez tools serve 8791:8080 voice web --origin http://127.0.0.1:8791
```

Open the private one-time link printed on stdout. It becomes a 20-minute browser
session. The link is a credential; keep command output private. Local mode needs
no Telegram or telephone provider.

For Telegram, use a dedicated HTTPS origin forwarded to the same loopback port:

```sh
ez tools serve 8791:8080 voice web --origin https://voice.example.com --bot-id 123456789
```

Configure the relay and recreate its container:

```dotenv
EZ_TELEGRAM_WEB_APP={"command":"voice","label":"Voice","url":"https://voice.example.com/"}
```

The bot ID is the public numeric bot ID, never its token. Telegram launch data is
verified with its production Ed25519 signature, a five-minute window and the
current paired private-chat owner. Launch exchange is single-use. Reopen after
expiry. Unpairing or relinking invalidates existing sessions. Group owners are
not supported by this web entry point.

`tools serve` publishes only to loopback. The resident container owns provider
sessions and private state; the command container serves HTTP and forwards only
owner-authentication frames through core. Neither receives the Docker socket.
Run the foreground command under the host's service supervisor for unattended
use. Stopping it ends the call.

A public reverse proxy must terminate HTTPS, preserve Host, forward to
`127.0.0.1:8791`, disable authenticated caching, and avoid logging authorization
headers or request bodies. Voice does not create domains, certificates or ingress.

## Delegation, retention and lifecycle

GPT-Live handles casual spoken conversation. For facts, files, planning, tools,
permissions or actions it emits client delegation. Voice sends the accumulated
speaker transcript to the owning native agent's private `voice` application
scope. That agent uses its normal workspace instructions, plugins and authority.
Only its concise final reply is appended back to GPT-Live for speech. The Live
model never receives application or provider credentials and cannot invoke a
plugin directly.

Voice submits each delegation once with a stable request ID. End requests native
run cancellation when one was admitted; a cancellation or external action can
still have an uncertain outcome, so receipts remain authoritative. There is no
automatic mutation retry or replacement inference queue.

Transcript deltas are atomically retained in the private plugin volume. Resume
seeds up to 30 recent speaker rows and 12,000 characters into a new Live session;
New conversation preserves the prior file and starts an empty one. Each file is
bounded to 500 rows. Raw audio, credentials and native tool calls are not stored.
This retained voice context is distinct from the native agent's application
session and Telegram chat history.

The browser waits for `session.started` before showing Listening. End sends
`session.close`, retains media while events drain, and reports success only after
`session.closed`; otherwise provider finalization is explicitly unconfirmed.
Calls are capped at 20 minutes and 100 delegations. A 60-second connection lease
closes abandoned sessions. `ez plugins stop voice` stops the runtime; uninstall
preserves the private data volume.

Real microphone, playback, interruption and device behavior require human QA on
the target client. HTTP, unit and Docker tests do not prove audible quality.

Development: `pnpm install --frozen-lockfile`; `pnpm verify`; `npm run release:check`.
Build the Docker test/runtime targets from the exact packed artifact and run
`docker/smoke.mjs`. See CONTRIBUTING.md, SECURITY.md and docs/releasing.md.
