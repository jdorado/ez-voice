# Ez Voice

Talk to an Ez agent using OpenAI Realtime and its existing installed plugin tools.
Library lookups execute directly through the bound CLI; they do not require another LLM call.

This first beta provides a Dockerized voice service and a temporary local web page for owner QA.
It is a separate voice session with selected context and direct tools, not a continuation of the
main CLI engine's private conversation. Phone/SIP adapters and public webapp authentication come later.

## Requirements

- An existing Ez plugin registry and Docker installation.
- Node 22+ on the host for the temporary HTTP/stdio bridge.
- OpenAI API access to `gpt-realtime-2.1` (configurable) and a browser microphone.
- Explicitly reviewed read-only tool bindings for the owning agent.

The model is deliberately Realtime, not `gpt-live-1`: this slice tests direct function calling.
Audio travels browser ↔ OpenAI over WebRTC. The container opens a server-side control connection,
validates completed function calls, and sends structured requests to the local bridge. The bridge
uses the agent's existing `ez` dispatcher with literal argv; results return to the same voice model.
API keys stay in the container's private volume. No engine subprocess or conversation replay is added.

## Install and configure

Use the agent's absolute bound launcher (shown as `ez` below), never another workspace's global CLI.
Obtain a reviewed source release and inspect it before installation:

```sh
ez plugins inspect voice --source /absolute/reviewed/ez-voice
ez plugins install voice --source /absolute/reviewed/ez-voice --revision sha256:INSPECTED_HASH
ez plugins start voice
ez voice doctor
```

Supply `{ "apiKey": "YOUR_OPENAI_KEY", "model": "gpt-realtime-2.1", "voice": "marin" }` through
private stdin to `ez voice configure`. Do not put the key in shell arguments, a public file, or chat.
`configure` writes mode 0600 atomically. `doctor` checks configuration without contacting OpenAI;
actual session creation and audio playback establish provider readiness. A 401/403 indicates account
or access setup; a 429 can indicate quota/billing. Errors omit provider bodies and keys.

## Open the temporary voice page

Prepare a private copy of `examples/library-profile.json`, set its agent label, and review each tool
against `ez tools list --details` and the installed CLI help. The sample uses Library `default`.
Keep profile/context files outside the published package. Then run:

```sh
node /absolute/reviewed/ez-voice/examples/local-bridge.mjs \
  --ez /absolute/agent/tools/bin/ez \
  --profile /absolute/private/voice-profile.json \
  --port 8787
```

An optional `--context-file /absolute/private/brief.md` supplies a short startup brief (12,000
characters maximum). Select only facts/instructions appropriate for this owner conversation.
Library reads supply more context on demand. No local Markdown is automatically uploaded.

Open the printed private link on the same machine and select **Start talking**. Allow the microphone.
The page shows captions and tool durations. Use **Mute**, **End**, and the audio playback control.
The link's random token is required for API access; keep it private. Loopback HTTP permits local
microphone use. There is no LAN, tunnel, hosted or multi-user access in this pilot.

The bridge is an interim host transport, not a new plugin installation path. It opens `ez voice bridge`
through the registry and forwards requests to the resident container over a private Unix socket.
Its only tool execution is the existing bound dispatcher. Docker owns the provider service lifecycle.
Stop the bridge with Ctrl-C. `ez plugins stop voice` stops the provider service.

## Tool bindings

Each operator-authored binding contains a Realtime function schema, installed `command` alias,
literal `args` template, and `effect: "read"`. Arguments use `{ "parameter": "query" }` slots.
Only declared scalar parameters are supported; strings/integers require bounds and unknown fields
are rejected. Values beginning with `-` cannot inject CLI options. The model sees the function
definition, never host paths or executable selection. It cannot register tools or alter its profile.

Bindings can target any installed plugin's reviewed read operations. Installation alone grants
nothing. The `effect` label does not prove a command is read-only; the operator must inspect it.
This beta intentionally has no write bindings or arbitrary shell/argv tool. Supporting writes later
requires the existing execution/approval boundaries and operation receipts, not simply changing a label.
Plugin removal takes effect before each invocation. Changing bindings requires restarting the bridge.

## Limits and verification

- One live session per voice service; 20-minute maximum and 100 tool calls. Tool calls are serialized,
  bounded to 30 seconds and 16,000 returned characters. Narrow queries when output is too large.
- Browser captions are temporary. Voice transcripts and memory are not persisted into the owner mind.
- Main-agent history, goals and full CLI tool context are not inherited. Supply a brief and retrieve.
- Disconnects stop tool work and request provider hangup. Failed hangup is reported as unconfirmed;
  no automatic redial or action retry. Provider receipts do not prove the owner heard the audio.
- Mobile backgrounding, screen lock, Bluetooth and sustained PWA calls need separate device QA.
- Retrieved content can include prompt injection. See SECURITY.md for the actual trust boundary.

QA should prove microphone input, audible replies, direct Library search/read, interruption/correction,
tool timings, clean End, and re-opening the page. Synthetic tests and container health are insufficient
to claim audible quality. The temporary page itself is not a production webapp.

## State and removal

Private state is `/state/config.json` and the service socket. Back up configuration privately.
`ez plugins uninstall voice` unregisters/stops the deployment and preserves its named volume.
Reinstall reuses credentials. Revoking a provider key is a separate OpenAI account operation.
First-beta state schema is 1; no migration exists. Keep the prior artifact when upgrading.

## Development

`pnpm install --frozen-lockfile`, `pnpm verify`, `npm run release:check`.
Build Docker `test` and `runtime` targets from the packed artifact; run `docker/smoke.mjs`.
See CONTRIBUTING.md and docs/releasing.md. MIT licensed; source is public, provider usage is paid.
