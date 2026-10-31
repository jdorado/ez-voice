# Direct phone audio

Experimental audio-only phone channel for direct two-way conversations without
Retell or Vapi. The listener remains available until stopped; it admits `maxCalls` calls at once across its lines (one by
default) and caps each call at three minutes by default (`maxCallSeconds`), in either direction. It has no native-agent
integration.
Audible quality, interruption handling and latency require separate acceptance.

```text
telephone ↔ Twilio number ↔ Twilio Media Streams ↔ Ez Voice ↔ speech provider
                                                       (GPT-Live | ElevenLabs Realtime | Gemini Live | Deepgram Voice Agent)
```

Twilio, GPT-Live and ElevenLabs Realtime use raw G.711 mu-law, mono, 8 kHz. Voice forwards the
base64 audio without STT/TTS services, transcoding, a hosted agent definition or
another voice platform. Gemini Live takes 16-bit PCM at 16 kHz and answers with PCM (24 kHz), never G.711,
so Voice converts both ways in pure JavaScript (no service, no native dependency). The short instructions live in the
private Voice phone configuration (or in files read at the start of every call, see Instructions from files) and go directly to the provider at call startup. Twilio and the provider still
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
`provider`, `model`, `voice`, `language`, `instructions` or `instructionsFiles`, `tools`...) instead of those fields at the top level; the
account, auth token, origin and limits are shared. An inbound call takes the line of the number called; an outbound
call takes `--from LINE` (default: the first line). An inbound call is answered: once the provider session is ready the
model is asked to speak first (`response.create` at OpenAI and ElevenLabs, a turn saying the call connected at Gemini),
as a person picking up the phone does; an outbound call waits for the callee to speak. While that session starts (a
provider may take a few seconds) an inbound call keeps ringing: the North American ringback (440 and 480 Hz, two seconds
on, four off) plays until the model's first audible audio, which first clears the queued ring at Twilio, so the start
sounds like the phone still ringing instead of a silent pickup the caller talks into. A line's `answerTone` is
`ringback` (default) or `none`; the receipt records `ringMs`. `maxCalls` (1..8, default 1) is how many calls run at once across
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

`preview` and `status` read the actual number (with several lines, the first line's: route each other number at
Twilio itself, to the same `/incoming`). `route` saves the previous voice
routing before its single provider update and verifies canonical readback.
It changes only voice fields; SMS configuration is not submitted. A receipt left
uncertain after a failure is inspected rather than automatically retried. If
readback shows the original route is intact, `restore` reconciles the receipt
without another provider update.
`restore` refuses to overwrite a voice route changed outside Voice. Restore
the previous route before decommissioning the public endpoint. The listener does
not expire after thirty minutes or stop after five completed calls. Callers past `maxCalls` receive busy; each admitted
call remains limited to `maxCallSeconds`.
`/health` reports local readiness and returns 503 after a receipt-storage failure.
A health response does not prove provider connectivity; `phone probe` does.

## Instructions from files

A line's `instructions` is a string in the private phone configuration, read once when the service starts. To change a
persona without a reconfigure and a restart, keep it in files and give the line `instructionsFiles` (1..8 relative paths)
and `instructionsRoot` (an absolute directory inside the container, for example a read-only folder the host binds there)
instead of `instructions`; setting both is refused, and `instructionsFiles` requires `instructionsRoot`:

```json
{
  "provider": "openai",
  "apiKey": "PROVIDER_API_KEY",
  "accountSid": "TWILIO_ACCOUNT_SID",
  "authToken": "TWILIO_ACCOUNT_AUTH_TOKEN",
  "number": "+15551230001",
  "origin": "https://phone.example.com",
  "instructionsRoot": "/state/agent",
  "instructionsFiles": ["persona/phone.md", "rules/calls.md"]
}
```

`instructionsRoot` may also be set on a line inside `lines`, where it wins over the top-level one (which is the default of
every line that uses files). Configuration checks the shape only; the files need not exist when it is saved.

At the start of every call (an inbound call's ticket; an outbound call when it is dialed, to stop a call that could not
start, and again when it is answered) each file is read again as UTF-8 (a leading byte order mark is dropped) and the
files are joined in the order listed with one blank line between them. The result is used exactly where a line's
`instructions` string is: a per-call brief or a caller context is added to it, and the 15,000-character session limit
applies as before. Nothing is cached between calls, so an edited file reaches the next call and a call already in progress
keeps the text it started with. The text goes only to the speech provider, as `instructions` do.

Every file must be a regular file inside the real path of `instructionsRoot` (a link that leaves it is refused), non-empty
after trimming, valid UTF-8 and at most 12,000 characters, which is also the limit of all the files joined. A path is
refused at configuration if it is absolute or has a `..`, a `.`, a backslash or an empty segment. The failure is closed: a
file that is missing, unreadable, empty, not a regular file, outside the root, not UTF-8 or too large refuses the call, and
nothing falls back to the default instructions or to an earlier read. An outbound `phone call` fails with an error that names the
file and a reason code (never its text) and does not dial. An inbound call, or an outbound call answered after the file
became unreadable, is refused like a call over capacity (`Reject` busy), holds no place, and the failure is saved as that call's
receipt: `reason` `instructions_unavailable` and `instructionsError` `{path, reason}`.

Each call's receipt records `instructionsSha256`, the SHA-256 (hex) of the line instructions the call started with (for a
line with files, the joined text; the brief and caller context are not part of it), so a reader can tell which revision of
a persona a call used. The text itself is stored nowhere new. `phone doctor` lists, per line that uses files, each file as
`{path, ok: true}` or `{path, ok: false, reason}` (`missing`, `outside_root`, `not_a_file`, `empty`, `not_utf8`,
`too_large`, `unreadable`, `root_unavailable`) with the digest of what a call would start with now, and `phone probe` starts its
provider session with the files' text as a call would, failing with the same error when one is unreadable. Neither
prints the text. They read the files from the process that runs them, so a folder bound into the running service must
be visible to that process too.

## Providers

One provider serves a call, chosen by `provider` in the private configuration. `PhoneAudio` owns the Twilio bridge, timers,
tool registry and receipt; each provider's wire protocol is an adapter in `src/phone-providers/` (its contract is documented
in `index.mjs`). A new managed speech service is one more adapter file and a registry line. `apiKey` is that provider's key,
checked against its key shape. `model` must be one the adapter lists; the default is the first column below.

| `provider` | Default and allowed `model` | Default `voice` | Audio | Tools | Close |
| --- | --- | --- | --- | --- | --- |
| `openai` | `gpt-live-1` | `marin` | mu-law 8 kHz both ways | Responses backend (`toolModel`, `toolEffort`), see Tools | `session.close` / `session.closed`, with final usage |
| `elevenlabs` | `eleven_realtime_v1_mini` or `eleven_realtime_v1_max` | `brian`, or an ElevenLabs voice id | mu-law 8 kHz both ways | native function calls on `eleven_realtime_v1_max` only | socket close; no usage |
| `gemini` | `gemini-3.8-live` or `gemini-3.8-live-extended-thinking` (`thinking` low, medium or high, default low) | `Kore` | PCM 16 kHz in, PCM out (24 kHz), converted | native, `BLOCKING` (not on the thinking variant) | socket close; the last reported usage |
| `deepgram` | `gemini-3.8-flash` | ElevenLabs Brian voice id | mu-law 8 kHz both ways | native functions, deferred until end of turn | socket close; no usage |

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
(milliseconds from the start of the bridge). It also keeps what each side said, as the provider transcribed it while the
call ran (`transcript`: turns of `caller` and `model`, each with its `text` and `atMs`; the caller's words are the
provider's speech-to-text, the model's are its own), at most 100,000 characters a call (`transcriptTruncated` past that):
whoever reads the receipt (`phone receipt --call-sid CA...`) has the call's words without a second transcription. A provider that reports when the caller starts talking over the model
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
house number said first must be the address's own, a hyphenated one such as 88-10 included, and every word of the
address's street name must have been said, a numbered street's number included; a direction, the street type, a unit, a
city or a ZIP never decide it; several properties of a caller are separated by ';' in `find`), at most three tries a call.
The set is the install's, for every line. `at` is an ISO time with its offset (kept in UTC). A claim is
the little a stranger who names the property may be told; what `text` and `claim` hold is the operator's policy. A set that
is never replaced, or is empty, leaves the behavior unchanged (no incoming note, no `find_case`), and the plugin decides
nothing about what may be said. An incoming call's instructions with its context are cut to 15,000 characters, the
context's end first; an outbound brief that would take the call past that is refused before dialing.

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
`maxCalls` capacity. Stop the phone supervisor before replacing the plugin;
shutdown attempts to finalize audio and terminate every outstanding outbound call (each is tried, and the ones that could
not be settled are reported together).
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
tools. Its tools are `end_call` and, on an inbound call with prepared caller contexts, `find_case` (see Tools); a legacy
client delegation (`tools: false`) receives a fixed capability-unavailable result. This plugin stores no audio; Twilio
holds the call recording. What it keeps, all in its private volume (mode 0600, readable by the operator only): each call's
receipt (call and provider IDs, the digest of the line instructions, input/output byte counts, provider error code, final usage, the recording outcome, the
ring and the call's transcript, up to 100,000 characters), kept until the operator removes it; outbound requests with
their briefs (`calls.sqlite`); and the prepared caller contexts (`contexts.sqlite`), replaced as a whole by the operator.
A caller context is chosen by the caller ID Twilio reports, which a caller can spoof: anyone presenting a known number is
answered with that number's context, so prepare only what the line may hear from that number.
These counts prove transport activity, not audible quality or semantic accuracy.
No automatic dialing, redial, replacement provider or model fallback exists.

The signed HTTP webhook creates a short-lived single-use ticket bound to the
Twilio Call SID. The signed media upgrade must present it in its start event,
with the configured account and the expected audio format. Up to `maxCalls` calls run at a
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

## Installed information tools

An operator can bind one installed plugin with `toolBinding` in the phone profile:
`{"alias":"records","schemas":["call","tools"],"invoke":["call","read","-"]}`.
The schema command returns `{tools: [Responses function definitions]}`. The invocation command
receives `{call: {id, remote, line, direction, started_at}, turn, name, arguments}` on stdin.
Its result must echo `call_id` and `turn`. The domain plugin owns validation, read permissions
and data; Voice never supplies arbitrary CLI or shell access to the model. The runtime uses
Ez `tools.invoke` through its existing `tools serve` connection and the installed plugin revision.
Call metadata comes from the authenticated Twilio admission ticket, outside model arguments.

GPT-Live exposes these tools through Responses delegation and ElevenLabs Max calls them natively.
Each bridge cancels pending work on a superseding request, interruption or close, refuses duplicate
call IDs, and discards late results. A read has a 15-second deadline; failure is explicitly
unavailable. ElevenLabs supplies speech-start boundaries; GPT-Live supplies delegation IDs,
which bind its backend request generations and scope cancellation. Transcript fragments cannot
reliably identify complete GPT-Live turns. Receipts keep tool names, status, duration and
cancellation counts, not retrieved private bodies.
Prepared context remains immediate and is labelled as historical evidence before a new greeting.
The bound plugin is trusted operator configuration; its domain read-only enforcement is required
for speech sessions that must not write. No native-agent delegation is granted to phone callers.

Caller audio is queued until provider readiness and forwarded even while local ringback plays.
ElevenLabs receives a call-connected event before its initial response request; an empty
response request alone is not reliable proof of an audible greeting.

### Deepgram cascaded speech

`provider: "deepgram"` uses the managed Voice Agent session with Flux (`flux-general-en`, v2)
turn detection, Google `gemini-3.8-flash` and ElevenLabs `eleven_flash_v2_5`. It is English-only
for now. `apiKey` is the Deepgram key; `llmApiKey` is the Google AI Studio key and `ttsApiKey`
is the ElevenLabs key. `voice` is an ElevenLabs voice ID. Supply all three through private
configuration stdin. Deepgram receives the two BYO keys to connect to those providers.
Arbitrary endpoints and alternative stack models are not accepted. The bridge does not
run its own STT/LLM/TTS loop or choose a fallback model.

The adapter waits for Welcome, submits Settings, and waits for SettingsApplied before audio.
The generic call-connected turn requests an inbound greeting; persona wording remains in
the operator's instructions. Every admitted client function, including `end_call`, receives its protocol response; the bridge allows its existing 12-second closing window before Twilio playback drain, because audio-done events do not identify the post-tool response. Native functions use the existing tool registry, with
`defer_until_eot` so speculative turn detection cannot end the call. Gemini thought signatures
return only with their originating function response. Cancelled functions receive no response,
and late results cannot cross calls or turns. A readiness probe alone does not establish
LLM/TTS compatibility, audible output, tool use or conversation quality: exercise a real
provider call through the installed plugin before selecting this stack for live callers.

Provider contracts: [message flow](https://developers.deepgram.com/docs/voice-agent-message-flow),
[BYO LLM](https://developers.deepgram.com/docs/voice-agent-llm-models),
[BYO TTS](https://developers.deepgram.com/docs/voice-agent-tts-models),
[functions](https://developers.deepgram.com/docs/voice-agent-function-call-request).

Deepgram currently accepts `ttsModel: "eleven_flash_v2_5"` (also the default). ElevenLabs v4 Turbo requires its Text-to-Dialogue WebSocket protocol, which this managed provider integration does not speak. It is refused at configuration time rather than producing a silent call. No automatic model substitution occurs.

File-backed instructions require the Linux Docker runtime: containment is verified using the opened descriptor under `/proc/self/fd`, so a parent-directory swap cannot redirect a read outside its root. Native non-Linux file loading is refused. Packed Docker/CI runs the filesystem stories.

The managed final-response window can leave the line open briefly after a goodbye. It is bounded by the existing end-call limit; an unrelated earlier AudioDone cannot close the call before the final response. Audible greeting activity also arms the configured idle timer when the caller remains silent.

## Side coach (advice)

An operator can give a line a side coach: `advice: true` on the line and one shared installed command,
`adviceBinding: {alias, invoke, deadlineMs}`, for example `{"alias": "advice", "invoke": ["evaluate", "-"], "deadlineMs": 4000}`.
It is off by default. Voice holds no classifier, rules or coach key; the installed command owns what a note means.

Each finished caller utterance (whole from Deepgram; on GPT-Live, complete once the model starts to answer) goes to
the command on stdin as `{call, turn, text, history, deadline_at}`, with identity from the call ticket, never from
model arguments. It answers `{call_id, turn, status, advice?}`: status `available`, `no_match` or `unavailable`;
advice `{id, text, source, source_revision, confidence}`, text at most 3,000 characters. An available note is added
to the model's context for its later replies: Deepgram `UpdatePrompt`, GPT-Live `session.thinking.append` (context
"without asking the model to say it immediately", at most 500 tokens). Other providers refuse `advice`.

Nothing waits for the coach: no reply is held or requested, so the reply already being formed does not see the note
and the next ones do. A lookup slower than `deadlineMs` (500..5000), one a newer utterance overtook, or one that
repeats the note last added adds nothing. Additions cannot be removed, so each note says it replaces the earlier
ones, and a call adds at most eight, within Deepgram's 25,000-character prompt. The receipt's `advice` lists each
lookup's status, timing, note ID, source revision and the provider's acknowledgement, never the note's text.
Acknowledgement is not proof the model used the note, and GPT-Live warns that appended context may still be spoken:
check on real calls that the model does not read a note out.
