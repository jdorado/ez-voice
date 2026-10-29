# Direct phone audio

Experimental audio-only phone channel for direct two-way conversations without
Retell or Vapi. The listener remains available until stopped; it admits one call
at a time and caps each call at three minutes by default (`maxCallSeconds`), in either direction. It has no native-agent integration.
Audible quality, interruption handling and latency require separate acceptance.

```text
telephone ↔ Twilio number ↔ Twilio Media Streams ↔ Ez Voice ↔ speech provider
                                                       (gpt-live-1 | ElevenLabs Realtime | Gemini Live)
```

Twilio, GPT-Live and ElevenLabs Realtime use raw G.711 mu-law, mono, 8 kHz. Voice forwards the
base64 audio without STT/TTS services, transcoding, a hosted agent definition or
another voice platform. Gemini Live takes 16-bit PCM at 16 kHz and answers with PCM (24 kHz), never G.711,
so Voice converts both ways in pure JavaScript (no service, no native dependency). The short instructions live in the
private Voice phone configuration and go directly to the provider at call startup. Twilio and the provider still
bill their own usage, including call recording and its storage at Twilio.
Removing Retell/Vapi does not make a call free.

## Private configuration and routing

Install the reviewed release through the normal Ez manager. Use an isolated
test registry for development. Keep credentials and runtime state outside the agent workspace.
`ez voice phone configure` takes the following JSON on private stdin:

```json
{
  "provider": "openai",
  "apiKey": "PROVIDER_API_KEY",
  "accountSid": "TWILIO_ACCOUNT_SID",
  "authToken": "TWILIO_ACCOUNT_AUTH_TOKEN",
  "number": "+15551230001",
  "origin": "https://phone.example.com",
  "instructions": "You are a friendly AI on a phone call. Introduce yourself and have a short conversation."
}
```

One install can serve several numbers: give `lines` (1..8 entries, each with its own `number`, `apiKey`, and optional
`provider`, `model`, `voice`, `language`, `instructions`, `tools`...) instead of those fields at the top level; the
account, auth token, origin and limits are shared. An inbound call takes the line of the number called; an outbound
call takes `--from LINE` (default: the first line). `maxCalls` (1..8, default 1) is how many calls run at once across
all lines, inbound and outbound together: an outbound call holds its place from creation to its end. The single-line
form keeps working unchanged.

`provider` is optional (default `openai`); `model`, `voice` and `language` are optional too (see Providers). The number must belong to that account and support voice. An account auth token
is needed to validate Twilio signatures; a Twilio API key cannot validate them.
The origin must terminate HTTPS and forward HTTP/WebSocket upgrades to the
loopback publication. No request bodies, authorization headers or audio in logs.
Use an approved dedicated number and a host supervisor to keep the installed
`tools serve` command running. HTTPS ingress and supervision belong to the
deployment owner, not the plugin. Restart the service after changing configuration.

```sh
ez voice phone doctor
ez voice phone probe
ez tools serve 8793:8080 voice phone serve
ez voice phone preview
ez voice phone route
ez voice phone status
# Call the approved number yourself. Speak, listen for a reply, then hang up.
ez voice phone receipt
ez voice phone restore
ez voice phone status
```

`preview` and `status` read the actual number. `route` saves the previous voice
routing before its single provider update and verifies canonical readback.
It changes only voice fields; SMS configuration is not submitted. A receipt left
uncertain after a failure is inspected rather than automatically retried. If
readback shows the original route is intact, `restore` reconciles the receipt
without another provider update.
`restore` refuses to overwrite a voice route changed outside Voice. Restore
the previous route before decommissioning the public endpoint. The listener does
not expire after thirty minutes or stop after five completed calls. Simultaneous
callers receive busy; each admitted call remains limited to `maxCallSeconds`.
`/health` reports local readiness and returns 503 after a receipt-storage failure.
A health response does not prove provider connectivity; `phone probe` does.

## Providers

One provider serves a call, chosen by `provider` in the private configuration. `PhoneAudio` owns the Twilio bridge, timers,
tool registry and receipt; each provider's wire protocol is an adapter in `src/phone-providers/` (its contract is documented
in `index.mjs`). A new speech-to-speech service is one more adapter file and a registry line. `apiKey` is that provider's key,
checked against its key shape. `model` must be one the adapter lists; the default is the first column below.

| `provider` | Default and allowed `model` | Default `voice` | Audio | Tools | Close |
| --- | --- | --- | --- | --- | --- |
| `openai` | `gpt-live-1` | `marin` | mu-law 8 kHz both ways | Responses backend (`toolModel`, `toolEffort`), see Tools | `session.close` / `session.closed`, with final usage |
| `elevenlabs` | `eleven_realtime_v1_mini` or `eleven_realtime_v1_max` | `brian`, or an ElevenLabs voice id | mu-law 8 kHz both ways | native function calls on `eleven_realtime_v1_max` only | socket close; no usage |
| `gemini` | `gemini-3.8-live` or `gemini-3.8-live-extended-thinking` (`thinking` low, medium or high, default low) | `Kore` | PCM 16 kHz in, PCM out (24 kHz), converted | native, `BLOCKING` (not on the thinking variant) | socket close; the last reported usage |

ElevenLabs Realtime is the OpenAI Realtime protocol over WebSocket. Its socket refuses the account key, so each call first mints
a short-lived client secret (`POST /v1/convai/realtime/client_secrets`, needing an ElevenLabs key with ElevenAgents write
access) and connects with that. ElevenLabs documents Realtime as a cascaded stack, not native audio to audio. Its Mini model does
not call tools (it writes the tool name into its speech), so Voice declares none for Mini: use Max where the model must call
`end_call` (`phone doctor` shows `tools` as false then). `language` (default `en`) is the transcription language. The thinking variant needs a level at setup and the plain model refuses one, so `thinking` applies to the variant only (thinking adds delay). Gemini Live carries the key in the WebSocket URL: Voice
never logs it, and no error text or receipt includes it.

Known limits: `firstAudioMs` is the first audio frame, not a turn latency: GPT-Live streams silence from
the start, so there it is close to `readyMs`. The provider's own session cap applies too (ElevenLabs follows `maxCallSeconds`
up to 7200 s; Gemini audio sessions end after about 15 minutes).

A provider with no close handshake cannot confirm finalization: the receipt shows `finalized: false`, and `phone probe` proves
only that the session started. The receipt names the `provider` and `model`, and records `readyMs` and `firstAudioMs`
(milliseconds from the start of the bridge). A provider that reports when the caller starts talking over the model
(ElevenLabs voice activity, Gemini `interrupted`) makes Voice send Twilio a `clear` so audio queued at Twilio stops.

## Call length and idle hang-up

Two optional private configuration fields bound a call: `maxCallSeconds` (30 to 3600, default 180; the Twilio call limit
is that plus 15 seconds) and `idleSeconds` (0 to turn off, otherwise 5 to 300, default 20). A call ends with the close
reason `idle_timeout` when nobody has spoken for `idleSeconds`. Each adapter turns its provider's signals into "the contact
spoke" and "the model spoke" (GPT-Live: `session.input_transcript.delta` and `session.output_transcript.delta`; ElevenLabs: voice
activity, the input transcript and `response.output_audio_transcript.delta`; Gemini: its input and output transcriptions). Output
audio flows nonstop on some providers, silence included, so it says nothing about who is speaking. The rule arms only after the first
contact-speech signal, and the receipt counts them (`inputTranscriptEvents`), so a session that streams none is bounded by
`maxCallSeconds` alone. It ends a voicemail whose mailbox stays open after the message, and a dead line.

## Tools

GPT-Live has no direct function calling; tools run on its backend (Responses delegation). ElevenLabs Max and Gemini call
the tools natively: the adapter declares them in the session and answers each call (a `function_call_output` at ElevenLabs, a
`toolResponse` matched by `id` at Gemini), with no backend model. After `end_call` (a final tool) ElevenLabs is not asked to continue and Gemini gets no tool response (it narrated "the call has
ended" when it did), so the goodbye spoken before the call is the last thing said. With GPT-Live the phone session starts with
`delegation: {type: 'responses'}`, a backend model (`toolModel`, default `gpt-6.1-sol` at reasoning effort `toolEffort`, default `low`), instructions that say the backend
can only end the call, and the tools in `src/phone-tools.mjs`. The live model hands a request to that backend; when the
backend calls a tool (`response.output_item.done` with a `function_call`) the plugin runs it and returns a
`function_call_output`, then `response.create` so the backend resumes. Add a tool by adding an entry to `PHONE_TOOLS`; every provider declares it.
`tools: false` in the private configuration keeps the earlier client delegation, with no tools.

With GPT-Live, the adapter also declares the backend hang-up capability and the documented `<|SpawnThinking|>` trigger
to the live voice model. Registering `end_call` only on the Responses backend is insufficient: the voice model must
delegate before the backend can run it. This declaration is omitted with `tools: false`. The transport executes only
an actual backend function call; it never treats a transcript goodbye as a hang-up command. Acceptance requires
`tools: ["end_call"]` and close reason `end_call`, rather than the idle timer eventually closing a silent line.

`end_call` marks the call as ending; the model may say a goodbye, and once it has been quiet for two seconds (at most
twelve after the call) the plugin sends Twilio a `mark` behind everything already queued and closes the stream when Twilio echoes
it, that is, when the last of the goodbye has been played (at most fifteen seconds more), which ends the call (close reason
`end_call`). Without that wait, a provider that sends speech faster than realtime had a voicemail message cut off after one
sentence: closing the stream drops what Twilio still has queued. Where a provider's output audio only flows while the model
speaks (ElevenLabs, Gemini), its arrival counts as the model speaking, and for the idle hang-up the model keeps speaking until
what it sent has been played (Twilio plays at realtime speed, so a long message that arrived in a burst is not cut by `idleSeconds`;
a caller talking over the model drops what was queued). The receipt lists the
tools called (`tools`). When to end a call is the phone `instructions`' decision; `idleSeconds` stays as the backstop.

## Place a call

Use the installed CLI from the same agent environment while the phone service is running:

```sh
ez voice phone call --to +15551230002 --request-id owner-call-001
ez voice phone call --to +15551230002 --request-id owner-call-002 --instructions - < brief.txt
ez voice phone call --to +15551230002 --request-id owner-call-003 --from +15551230009
ez voice phone call-status --request-id owner-call-001
ez voice phone hangup --request-id owner-call-001
ez voice phone receipt
```

## Prepared caller contexts

An operator can prepare, for the numbers that may call back, what the line should know before it answers (the call
centre's "screen pop"). The set is replaced whole, atomically, on stdin:

```sh
ez voice phone context replace < contexts.json   # [{"number":"+15551230002","text":"...","claim":"...","find":"1450 East 102nd Street","at":"2026-10-29T12:00:00Z"}]
ez voice phone context status                    # {"count":1,"latest":"..."}
```

At most 500 entries; `text` 1..6000 characters, `claim` 1..600, `find` a property address (searchable). An inbound call
from a number in the set is answered with its `text` added to the line's instructions, as background that is never read out (an inbound call on a line with contexts is
also told it is incoming, with no brief, and whether its number matched); the lookup is local (no network call) and the receipt records `callerContext`. A call
from any other number gets the line's instructions alone, plus the `find_case` tool (inbound calls only): the model passes
the property address the caller names, and the tool answers with the `claim` of each context whose address matches (the
house number said first must be the address's own, and the street name or the street's own number must match; several properties of a caller are separated by ';' in `find`), at most three tries a call. A claim is
the little a stranger who names the property may be told; what `text` and `claim` hold is the operator's policy. A set that
is never replaced leaves the behavior unchanged, and the plugin decides nothing about what may be said.

The recipient must be explicitly authorized. Caller ID is the configured Twilio
number; answering connects the recipient to the same audio bridge and phone
instructions. `--instructions -` reads a per-call brief (1..12000 characters) on
stdin; it is saved with the request before dialing and added after the configured
instructions for that call only, under a heading that says the brief wins where
the two differ (the configuration stays the line's identity and conduct; inbound
calls and other requests get the configuration alone). A repeated request ID keeps its original brief. The brief is the
caller's: Voice adds no context, tools or history of its own. No new application,
provider or inbound number route is created. The existing HTTPS `/incoming` endpoint also receives the signed
outbound answer and terminal-status callbacks. Ringing is limited to forty-five
seconds (long enough for a carrier voicemail to pick up) and the call to `maxCallSeconds`. Outbound calls are recorded at Twilio like
inbound calls (see Recording).

Use one stable request ID per intended call. Repeating it returns the original
attempt and never dials again, including after a service restart. Reusing it with
a different destination fails. Creation is durably recorded before the provider
request; an ambiguous network failure remains uncertain, with no automatic retry.
Inspect that request and Twilio before attempting another call. Status reads the
provider when the Call SID is known. Hangup cancels a ringing call or ends an
answered call. Completion at Twilio alone does not prove a person answered;
voicemail may answer too. The private audio receipt must match the Call SID.

The CLI talks to the running phone process through a mode-0600 Unix socket in
the existing private volume. Ringing, answered and inbound calls share the same
single-call capacity. Stop the phone supervisor before replacing the plugin;
shutdown attempts to finalize audio and terminate its outstanding outbound call.
No service restart or transport loss automatically redials an uncertain attempt.

## Updating a live listener

Two listeners may run on one stable host behind its existing ingress. Optional private
`pathPrefix` (one segment, for example `/voice-a`) pins a listener's media and outbound
callbacks to that listener. The unprefixed `/incoming` remains the public inbound entry;
ingress selects its current listener. Forward the original signed URL unchanged.

`phone drain` atomically refuses new inbound admissions and outbound starts without
closing admitted tickets, ringing calls or audio. `phone capacity` reports `idle` only
after that listener's tickets, audio/receipt work and pending outbound attempt clear.
`phone resume` reopens admission. The barrier is saved privately before acknowledgment,
so a supervisor restart cannot reopen a drained listener. These operations use the private control socket.
Switch new inbound calls to a verified replacement before draining the old listener;
stop it only once idle. An uncertain outbound attempt keeps it non-idle until reconciled.
SIGTERM itself still terminates calls: it is not a drain operation.

Keep each listener's private volume across replacement, including its request journal.
Call receipts also live under `phone/receipts/<CallSid>.json`; `phone receipt` retains
the latest-receipt interface. The caller owns the shared task/claim and records the
listener and original request ID before dialing. Recovery inspects that same attempt
through its owning listener before any new action. Separate listener journals alone
do not deduplicate a request sent to both listeners. This plugin creates no task queue.

## Recording

Every call the bridge admits, inbound or outbound, is recorded at Twilio. When the
media stream's start event is accepted, the service makes one Calls Recordings API
request for that Call SID (`RecordingChannels=dual`, `RecordingTrack=both`) with the
configured account SID and auth token. The recording stays in the Twilio account and
is retrievable there by Call SID. This plugin stores no audio. Outbound call
creation still sends `Record=false`; the stream-start request covers both directions
with one code path.

The request is a single attempt that never delays the audio bridge. If Twilio rejects
it or it fails, the call continues unrecorded and nothing is retried. The private
receipt (`phone receipt`, and `call-status` for the matching Call SID) reports the
outcome with codes and SIDs only:

```json
{"recording": {"state": "started", "sid": "RE..."}}
{"recording": {"state": "failed", "code": "HTTP_403"}}
```

`failed` carries `HTTP_<status>` for a Twilio error response and `ERROR` for any other
failure, including a timeout. It means a recording start was not confirmed; after a
timeout a recording may still exist, so check the Twilio account. The receipt is
written when the call ends, after the recording request has settled.

The operator is responsible for any recording notice to callers and for the laws
that apply to recording; the phone `instructions` can state the notice.

## Boundary and evidence

Phone callers are external callers, not authenticated Ez owners. This channel has
no native-agent delegation, owner history, workspace access or external-action
tools. Its one tool is `end_call` (see Tools); a legacy client delegation
(`tools: false`) receives a fixed capability-unavailable result. There
is no conversation store, and this plugin stores no audio; Twilio holds the call
recording. The latest private receipt holds call and provider IDs, input/output
byte counts, provider error code, final usage and the recording outcome.
These counts prove transport activity, not audible quality or semantic accuracy.
No automatic dialing, redial, replacement provider or model fallback exists.

The signed HTTP webhook creates a short-lived single-use ticket bound to the
Twilio Call SID. The signed media upgrade must present it in its start event,
with the configured account and the expected audio format. One call runs at a
time. The provider must report readiness (GPT-Live `session.started`, ElevenLabs
`session.updated`, Gemini `setupComplete`) before input is forwarded; startup buffering is bounded. With GPT-Live, caller
hangup sends `session.close` and waits for `session.closed` to confirm final usage. Service shutdown also waits for this
finalization and durable receipt storage; a receipt write failure is reported.
A connection failure without that event, and any provider with no close handshake,
is explicitly unconfirmed. Voice does not synchronize Twilio's playback
buffer with the model's full-duplex output beyond clearing it when ElevenLabs or Gemini report a barge-in and waiting for it
to drain before an `end_call` hangup; interruption
quality needs later work and must not be treated as accepted by synthetic transport tests.

Audible acceptance: an authorized person calls the routed number, the model responds
audibly in the same call, a second turn works, hangup stops the provider session,
and provider finalization is verified in its private receipt. Only that
proves the provider bypass end to end. A routing restoration test must also pass
before decommissioning a temporary endpoint. No production readiness or latency claim
is made from unit tests, process health or byte counts.

References: [OpenAI WebSocket audio](https://developers.openai.com/api/docs/guides/voice-websockets?api=live),
[ElevenLabs Realtime](https://elevenlabs.io/docs/eleven-agents/guides/openai-realtime-compatibility),
[Gemini Live API](https://ai.google.dev/api/live),
[Twilio Media Streams](https://www.twilio.com/docs/voice/media-streams/websocket-messages).

Outbound API reference: [Twilio Call resource](https://www.twilio.com/docs/voice/api/call-resource).
