# Direct phone audio POC

Experimental, bounded phone feature. The first question is whether we can have a
two-way phone conversation without Retell or Vapi. Latency, deployment placement,
cost comparison and native-agent integration come after a real call proves this.

```text
telephone ↔ Twilio number ↔ Twilio Media Streams ↔ Ez Voice ↔ gpt-live-1
```

Twilio and GPT-Live both use raw G.711 mu-law, mono, 8 kHz. Voice forwards the
base64 audio without STT/TTS services, transcoding, a hosted agent definition or
another voice platform. The short instructions live in the private Voice phone
configuration and go directly to OpenAI at call startup. Twilio and OpenAI still
bill their own usage. Removing Retell/Vapi does not make a call free.

## Private configuration and test

Install the reviewed release through the normal Ez manager. Use an isolated
test registry for development. Keep credentials and runtime state outside the agent workspace.
`ez voice phone configure` takes the following JSON on private stdin:

```json
{
  "apiKey": "OPENAI_PROJECT_KEY",
  "accountSid": "TWILIO_ACCOUNT_SID",
  "authToken": "TWILIO_ACCOUNT_AUTH_TOKEN",
  "number": "+15551230001",
  "origin": "https://phone-test.example.com",
  "instructions": "You are a friendly AI on a phone test. Introduce yourself and have a short conversation."
}
```

The number must belong to that account and support voice. An account auth token
is needed to validate Twilio signatures; a Twilio API key cannot validate them.
The origin must terminate HTTPS and forward HTTP/WebSocket upgrades to the
loopback publication. No request bodies, authorization headers or audio in logs.

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
`restore` refuses to overwrite a voice route changed outside this POC. Restore
the previous route before stopping the public test endpoint. The test is limited
to five admitted calls, three minutes per call and a thirty-minute admission
window per service start. At expiry it refuses new calls; restoration remains
an explicit operator action.

## Boundary and evidence

Phone callers are external callers, not authenticated Ez owners. This test has
no native-agent delegation, owner history, workspace access or external-action
tools. Client delegations receive a fixed capability-unavailable result. There
is no conversation store or recording. The latest private receipt holds call
and provider IDs, input/output byte counts, provider error code and final usage.
These counts prove transport activity, not audible quality or semantic accuracy.
No automatic calls, redial, replacement provider or model fallback exists.

The signed HTTP webhook creates a short-lived single-use ticket bound to the
Twilio Call SID. The signed media upgrade must present it in its start event,
with the configured account and the expected audio format. One call runs at a
time. The provider must report `session.started` before input is forwarded;
startup buffering is bounded. Caller hangup sends `session.close` and waits for
`session.closed` to confirm final usage. Service shutdown also waits for this
finalization and durable receipt storage; a receipt write failure is reported.
A connection failure without that event
is explicitly unconfirmed. The POC does not yet synchronize Twilio's playback
buffer with the model's full-duplex output; interruption quality needs later
work and must not be treated as accepted by synthetic transport tests.

Acceptance: an authorized person calls the routed number, the model responds
audibly in the same call, a second turn works, hangup stops the provider session,
and the previous number routing is restored with provider readback. Only that
proves the provider bypass end to end. No production readiness or latency claim
is made from unit tests, process health or byte counts.

References: [OpenAI WebSocket audio](https://developers.openai.com/api/docs/guides/voice-websockets?api=live),
[Twilio Media Streams](https://www.twilio.com/docs/voice/media-streams/websocket-messages).
