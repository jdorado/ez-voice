# Direct phone audio

Experimental audio-only phone channel for direct two-way conversations without
Retell or Vapi. The listener remains available until stopped; it admits one call
at a time and caps each call at three minutes by default (`maxCallSeconds`), in either direction. It has no native-agent integration.
Audible quality, interruption handling and latency require separate acceptance.

```text
telephone ↔ Twilio number ↔ Twilio Media Streams ↔ Ez Voice ↔ gpt-live-1
```

Twilio and GPT-Live both use raw G.711 mu-law, mono, 8 kHz. Voice forwards the
base64 audio without STT/TTS services, transcoding, a hosted agent definition or
another voice platform. The short instructions live in the private Voice phone
configuration and go directly to OpenAI at call startup. Twilio and OpenAI still
bill their own usage, including call recording and its storage at Twilio.
Removing Retell/Vapi does not make a call free.

## Private configuration and routing

Install the reviewed release through the normal Ez manager. Use an isolated
test registry for development. Keep credentials and runtime state outside the agent workspace.
`ez voice phone configure` takes the following JSON on private stdin:

```json
{
  "apiKey": "OPENAI_PROJECT_KEY",
  "accountSid": "TWILIO_ACCOUNT_SID",
  "authToken": "TWILIO_ACCOUNT_AUTH_TOKEN",
  "number": "+15551230001",
  "origin": "https://phone.example.com",
  "instructions": "You are a friendly AI on a phone call. Introduce yourself and have a short conversation."
}
```

The number must belong to that account and support voice. An account auth token
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

## Call length and idle hang-up

Two optional private configuration fields bound a call: `maxCallSeconds` (30 to 3600, default 180; the Twilio call limit
is that plus 15 seconds) and `idleSeconds` (0 to turn off, otherwise 5 to 300, default 20). A call ends with the close
reason `idle_timeout` when nobody has spoken for `idleSeconds`: the contact's speech is the provider's
`session.input_transcript.delta`, the model's is `session.output_transcript.delta` (its output audio flows nonstop,
silence included, so it says nothing about who is speaking). The rule arms only after the first transcript event, and the receipt counts them
(`inputTranscriptEvents`), so a session that streams none is bounded by `maxCallSeconds` alone. It ends a voicemail whose
mailbox stays open after the message, and a dead line. GPT-Live has no model-callable hang-up.

## Tools

GPT-Live has no direct function calling; tools run on its backend (Responses delegation). The phone session starts with
`delegation: {type: 'responses'}`, a backend model (`toolModel`, default `gpt-6.1-sol` at reasoning effort `toolEffort`, default `low`), instructions that say the backend
can only end the call, and the tools in `src/phone-tools.mjs`. The live model hands a request to that backend; when the
backend calls a tool (`response.output_item.done` with a `function_call`) the plugin runs it and returns a
`function_call_output`, then `response.create` so the backend resumes. Add a tool by adding an entry to `PHONE_TOOLS`.
`tools: false` in the private configuration keeps the earlier client delegation, with no tools.

`end_call` marks the call as ending; the model may say a goodbye, and once it has been quiet for two seconds (at most
twelve after the call) the plugin closes the stream, which ends the call (close reason `end_call`). The receipt lists the
tools called (`tools`). When to end a call is the phone `instructions`' decision; `idleSeconds` stays as the backstop.

## Place a call

Use the installed CLI from the same agent environment while the phone service is running:

```sh
ez voice phone call --to +15551230002 --request-id owner-call-001
ez voice phone call-status --request-id owner-call-001
ez voice phone hangup --request-id owner-call-001
ez voice phone receipt
```

The recipient must be explicitly authorized. Caller ID is the configured Twilio
number; answering connects the recipient to the same audio bridge and phone
instructions. No new application, agent context, provider or inbound number route
is created. The existing HTTPS `/incoming` endpoint also receives the signed
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
time. The provider must report `session.started` before input is forwarded;
startup buffering is bounded. Caller hangup sends `session.close` and waits for
`session.closed` to confirm final usage. Service shutdown also waits for this
finalization and durable receipt storage; a receipt write failure is reported.
A connection failure without that event
is explicitly unconfirmed. Voice does not yet synchronize Twilio's playback
buffer with the model's full-duplex output; interruption quality needs later
work and must not be treated as accepted by synthetic transport tests.

Audible acceptance: an authorized person calls the routed number, the model responds
audibly in the same call, a second turn works, hangup stops the provider session,
and provider finalization is verified in its private receipt. Only that
proves the provider bypass end to end. A routing restoration test must also pass
before decommissioning a temporary endpoint. No production readiness or latency claim
is made from unit tests, process health or byte counts.

References: [OpenAI WebSocket audio](https://developers.openai.com/api/docs/guides/voice-websockets?api=live),
[Twilio Media Streams](https://www.twilio.com/docs/voice/media-streams/websocket-messages).

Outbound API reference: [Twilio Call resource](https://www.twilio.com/docs/voice/api/call-resource).
