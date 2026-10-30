# Changelog

## 0.1.0-beta.11.rc.26

- Preserve binary-framed JSON from Gemini Live while decoding Deepgram binary frames as audio.

## 0.1.0-beta.11.rc.25

- Report refused provider WebSocket upgrades by HTTP status, without retaining response bodies or credentials.

## 0.1.0-beta.11.rc.24

- Add a Deepgram Voice Agent adapter for Flux, Gemini 3.8 Flash and ElevenLabs v4 Turbo, with private BYO credentials, binary mu-law audio and the existing installed information tools.
- Bind function cancellation and Gemini thought signatures to each call; discard interrupted or stale reads.

## 0.1.0-beta.11.rc.23

- Preserve the explicit GPT-Live hang-up delegation policy when information tools are installed; read-only business access does not remove call control.

## 0.1.0-beta.11.rc.22

- Bind ElevenLabs client secrets to the complete initial call session (instructions, model, tools and audio), as required by the provider contract. Drain startup audio in bounded batches to preserve delayed PCM-provider connections.
- Preserve caller audio during phone ringback, including speech before provider readiness.
- Trigger ElevenLabs inbound greetings with an explicit call-connected event.

## 0.1.0-beta.11.rc.15

- Bind GPT-Live reads and cancellation to provider delegation IDs; transcript fragments and cancellation from an older response do not cancel the current lookup. Superseded reads resolve as cancelled so the backend cannot wait forever.

- Phone sessions can read through an operator-bound installed plugin on both GPT-Live and ElevenLabs Max, with call/turn binding, cancellation and stale-result rejection. Historical context ends before the new-call greeting.

## 0.1.0-beta.11.rc.11

Fixes from the final-diff review of the per-call brief and multi-line work (rc.3 to rc.10):

- A line runs with the shared fields and its own fields only: the first line's optional fields (tools, language,
  answerTone, thinking, toolModel, toolEffort) no longer leak into the other lines.
- Caller contexts and `find_case` apply only once a set was prepared: an empty or never-replaced store leaves inbound
  calls as they were. The set is the install's, for every line; `at` must be an ISO time with its offset and is kept in UTC.
- The ringback is bounded: it stops on the model's first audible words, 5 seconds after the session is ready, or on close,
  and the receipt says why (`ringStop`). Caller audio is not passed to the model while it rings (a ring echoed back was
  answered as words), and the ring is paced by elapsed time a little ahead of Twilio.
- GPT-Live without Responses delegation (`tools: false`) is not asked for a greeting (not verified there), and its client
  commentary no longer says no private information is connected.
- `find_case` keeps a hyphenated house number whole (88-10) and requires every word of the address's street name, so
  another street at the same house number never matches and Queens Boulevard, Court Street or New York Avenue do; a
  unit, a city or a ZIP in what the caller said only adds words.
- A session never starts with more than 15,000 characters of line instructions plus a brief or caller context: an
  outbound brief that would exceed it is refused before dialing, an inbound context is cut.
- Shutdown and restart try every pending call and report the failures together. Caller contexts on stdin are bounded in
  bytes like the control channel, and a malformed file is refused without echoing its text. The receipt's transcript
  keeps nothing once it is full, and a caller starting to speak ends the model's turn in it.
- Docs, skill and help: several lines, both tools, the ringback, what the volume keeps (transcripts, briefs, contexts) and
  that a caller context is selected by a spoofable caller ID. QA candidate only; not tagged or published.

## 0.1.0-beta.11.rc.10

- An inbound call keeps ringing while the speech session starts: the North American ringback plays from the moment the
  media stream connects until the model's first audible audio (silence some providers stream does not stop it), and the
  queued ring is cleared at Twilio first. The seconds a provider needs to start (ElevenLabs about 3) sound like one more
  ring instead of a silent pickup the caller talks into. A line's `answerTone` (`ringback`, default, or `none`); the
  receipt's `ringMs`. QA candidate only; not tagged or published.

## 0.1.0-beta.11.rc.9

- GPT-Live no longer tells its voice that no private records are connected: the delegation policy came after an inbound
  call's caller context and said so, and the backend answered "no private information" to a lookup, so the line said it
  had nothing on a caller whose context it held. Questions about the caller, their number or an earlier conversation are
  answered from the instructions; the backend says only that no tool does that.
- The receipt's transcript places a caller's words where they began to speak (ElevenLabs sends an utterance once it is
  finished, after the model may have begun to answer), and keeps a space between sentences streamed back to back.
  QA candidate only; not tagged or published.

## 0.1.0-beta.11.rc.8

- A call's receipt keeps what each side said, as the provider transcribed it while the call ran (`transcript`: turns of
  `caller` and `model` with `text` and `atMs`, at most 100,000 characters, `transcriptTruncated` past that), for OpenAI,
  ElevenLabs and Gemini alike. The plugin used these transcripts only to tell who was speaking and dropped the words, so
  a call's words needed a second transcription of the recording. Still no audio is kept. QA candidate only; not tagged or
  published.

## 0.1.0-beta.11.rc.7

- An inbound call is answered: once the provider session is ready the model is asked to speak first, so the caller hears
  the line's greeting instead of silence (ElevenLabs Realtime waited for the caller; an inbound caller then heard a reply
  to their own "hello?" as if the line had placed the call). Outbound calls still wait for the callee. QA candidate only;
  not tagged or published.

## 0.1.0-beta.11.rc.6

- Prepared caller contexts (the call centre's "screen pop"). `phone context replace < contexts.json` replaces, atomically,
  the set of up to 500 `{number, text, claim, find, at?}` the operator prepared; `phone context status` reads its count.
  An inbound call from a number in the set is answered with its `text` added to the line's instructions before the
  greeting (local read, no network call, no model); the receipt records `callerContext`; on a line with contexts every inbound call is told it is incoming with no brief, and whether its number matched. A call from another number can name
  a property to the `find_case` tool (declared on inbound calls only, at most 3 tries a call), which answers with the
  `claim` of each context whose address matches (the house number said first, and the street name or the street's own number). Tool calls now hand their arguments to the
  bridge on every provider. Caller audio that arrives before the provider is ready is held for up to 200,000 characters (about 18 s of the line, past the 15 s start timeout) instead of 64,000 (about 6 s), after which a slow provider start closed the call as `startup_audio_limit`; GPT-Live is told to run `end_call` right after its goodbye. `phone receipt --call-sid CA...` reads the receipt of one call (the plain `phone receipt` is the last call to end, which with several calls at once is any of them). QA candidate only; not tagged or published.

## 0.1.0-beta.11.rc.5

- A line's configured `instructions` take up to 12000 characters (was 4000), the same as a per-call brief, so a line
  can carry a full persona and call conduct for the calls it answers and places. QA candidate only; not tagged or
  published.

## 0.1.0-beta.11.rc.4

- One install serves several numbers (`lines`), each with its own provider, voice, key and instructions; an inbound
  call takes the called number's line, an outbound call `phone call --from LINE`. `maxCalls` (default 1, unchanged
  behavior) lets inbound and outbound calls run at once. The request journal records each call's line; a request ID
  reused with another line is refused. `probe` checks every line. QA candidate only; not tagged or published.

## 0.1.0-beta.11.rc.3

- `phone call --instructions -` takes a per-call brief (1..12000 characters) on stdin. It is saved with the request
  before dialing and added after the configured instructions for that outbound call only (the brief wins where they
  differ); inbound calls keep the configuration alone. ElevenLabs Realtime Max accepted 16000 characters of
  instructions in a live probe. QA candidate only; not tagged or published.

## 0.1.0-beta.11.rc.2

- Declare the backend `end_call` capability and GPT-Live's delegation trigger to the live model, as well as registering
  the function on its Responses backend. Without the live declaration, it could say goodbye but never delegate the
  hang-up; the call then waited for `idle_timeout`. The bridge still waits for the tool and Twilio playback acknowledgement.
  No declaration is added when tools are disabled. QA candidate only; not tagged or published.

## 0.1.0-beta.11.rc.1

- Private control-socket admission drain, resume and capacity read for safe listener replacement.
  Admitted tickets, ringing calls, active audio and receipt finalization remain with their listener.
- Optional signed public path prefix pins media and outbound callbacks across ingress switches.
  A prefixed listener returns 503 for new inbound calls when busy or draining so ingress may try another.
- Retain per-call metadata receipts alongside the compatible latest receipt. The caller retains task
  ownership and the original listener/request ID; no queue or automatic redial is introduced.

## 0.1.0-beta.10

GitHub release only (no npm), as beta.8 and beta.9.

- The idle hang-up (`idleSeconds`) no longer cuts a long message. Where a provider sends speech faster than realtime (ElevenLabs,
  Gemini) the idle timer counted from when the audio arrived, not from when Twilio finished playing it, so a message longer than
  `idleSeconds` could be hung up on while still being played (a live call ended `idle_timeout` while the model was still talking).
  The model now counts as speaking until everything it sent has been played (8 bytes of mu-law a millisecond); a caller talking
  over it drops what was queued. `end_call` is unchanged (it waits for the mark since beta.9). GPT-Live is unchanged.

## 0.1.0-beta.9

GitHub release only (no npm), as beta.8.

- `end_call` no longer cuts off what the model was saying. A live voicemail call on ElevenLabs lost all but the first sentence of
  its message: the provider sends speech faster than realtime, so seconds of it were still queued at Twilio when the bridge closed
  the stream. After the model has been quiet, Voice now sends Twilio a `mark` behind the queued audio and closes when Twilio echoes
  it (at most 15 seconds more). Where output audio only flows while the model speaks (ElevenLabs, Gemini), its arrival counts as
  the model speaking. GPT-Live is unchanged apart from the extra echo wait, which is immediate for its realtime-paced audio.

## 0.1.0-beta.8

GitHub release only (no npm), as beta.7. It rolls up the QA candidates rc.1 to rc.10 below.

- The phone bridge serves more than one speech provider. `provider` (default `openai`), `model`, `voice` and `language` in the
  private phone configuration choose it; each provider's wire protocol is an adapter in `src/phone-providers/` and `PhoneAudio`
  keeps the Twilio bridge, timers, tools and receipt. GPT-Live moves there unchanged. New: **ElevenLabs Realtime**
  (`eleven_realtime_v1_mini`, `eleven_realtime_v1_max`): mu-law passes straight through, a client secret is minted per call, tools
  are native on Max (Mini does not call tools, so none are declared for it), no close handshake. **Gemini Live**
  (`gemini-3.8-live`, `gemini-3.8-live-extended-thinking`): 16 kHz PCM in and 24 kHz PCM out converted in pure JavaScript
  (`g711.mjs`), native blocking tools, the key in the URL never reaches a log, error text or receipt. A barge-in reported by
  ElevenLabs or Gemini clears Twilio's queued audio. The receipt gains `provider`, `model`, `readyMs` and `firstAudioMs`, and
  `/health` and `phone doctor` name the provider. Providers with no close handshake report `finalized: false`; `phone probe`
  proves the session started. Gemini was written from Google's documentation and is not yet verified on a live call.
  After `end_call` ElevenLabs is no longer asked to keep talking (a live call showed a second goodbye three seconds after the first)
  and Gemini gets no tool response (it narrated "the call has ended").
  Gemini accepts both key shapes (`AIza...` and the newer `AQ....`), and its thinking variant takes a `thinking` level.
  Released as `0.1.0-beta.8`.

- The tools backend model defaults to `gpt-6.1-sol` at reasoning effort `low` (`toolModel`, `toolEffort` in the private
  phone configuration). QA candidate `0.1.0-beta.8.rc.9`; not tagged or published.

- The model's first tool: `end_call`. The phone session now starts with Responses delegation (backend model `toolModel`,
  default `gpt-6-luna`; `tools: false` keeps the earlier client delegation) and a small registry (`src/phone-tools.mjs`)
  of tools the plugin runs for the backend. `end_call` lets the model hang up after a goodbye or a voicemail message
  (close reason `end_call`; the receipt lists `tools`). `idleSeconds` remains the backstop. QA candidate
  `0.1.0-beta.8.rc.8`; not tagged or published.

- End a call when nobody has spoken for `idleSeconds` (default 20; 0 turns it off): neither the contact (the provider's
  `session.input_transcript.delta`) nor the model (its `session.output_transcript.delta`; its output audio flows nonstop,
  silence included, so it says nothing) has spoken. It
  arms only once the provider has streamed a transcript, so a session without transcripts is never cut short. This
  ends a voicemail whose mailbox stays open after the message, and a dead line, without the model needing a hang-up tool
  (GPT-Live has none). The receipt gains `inputTranscriptEvents` and the close reason `idle_timeout`.
- The call length is `maxCallSeconds` (30..3600, default 180) in the private phone configuration; the Twilio call limit is
  that plus 15 seconds. QA candidate `0.1.0-beta.8.rc.7`; not tagged or published.

- Ring an outbound call for forty-five seconds: a live call to a phone that rang thirty seconds without reaching its
  voicemail ended `no-answer`. QA candidate `0.1.0-beta.8.rc.5`; not tagged or published.

- Ring an outbound call for thirty seconds instead of twenty, so a call the person does not answer can reach their
  carrier voicemail, where the live model leaves a message under the phone `instructions`. QA candidate
  `0.1.0-beta.8.rc.4`; not tagged or published.

- Record every phone call the direct Twilio bridge admits, inbound and outbound, at
  Twilio: one dual-channel Calls Recordings API request per call when its media stream
  starts. The recording stays in the Twilio account, retrievable by Call SID; the plugin
  stores no audio. The operator is responsible for any recording notice to callers.
- The request never delays or closes the call and is not retried. The private call
  receipt (`phone receipt`, and `call-status` for the same Call SID) gains `recording`
  with `state: started` and the Recording SID, or `state: failed` and an `HTTP_<status>`
  or `ERROR` code. Outbound creation keeps `Record=false`.
- QA candidate `0.1.0-beta.8.rc.3`; not tagged or published. It is `rc.1` re-versioned: `rc.2` (answering-machine
  detection before the answer) was withdrawn because it delays every person who answers. A voicemail is left by the
  live model itself under the phone `instructions`, and the app labels it from the call transcript.

## 0.1.0-beta.7

- Add explicit outbound call, status and hangup commands through the existing
  direct Twilio audio bridge and configured caller ID. No native-agent context
  or new public dialing endpoint is added.
- Persist request IDs before dialing, verify signed answer/status callbacks and
  share one-call capacity with inbound calls. Never automatically redial an
  uncertain attempt; preserve receipts across restarts.
- Handle private control-socket errors without an unhandled frame-reader error.

## 0.1.0-beta.6

- Keep the inbound phone listener available until stopped, rather than expiring
  after thirty minutes or five calls. Retain one call at a time, a three-minute
  per-call limit, signed ingress and private finalization receipts.
- Report unavailable phone health as HTTP 503 after receipt-storage failure.
  Callers still have no native-agent tools or private context.

## 0.1.0-beta.5

- Add an audio-only inbound Twilio Media Streams POC connected directly to
  GPT-Live, with signed ingress, bounded calls and private usage receipts.
- Add explicit preview, voice-route readback and restoration commands. No native
  tools are exposed to phone callers. Live audible acceptance remains required.
- Await provider finalization and receipt storage during phone service shutdown;
  reconcile an unapplied routing attempt from canonical readback.

## 0.1.0-beta.4

- Requires Ez core 0.1.0-beta.50 or newer for the manifest example.
  Older cores refuse the update and retain the installed version.
- Add a representative manifest example for tool discovery.

- Add short-lived browser conversation links for explicitly granted restricted discussions, retaining each task’s context and tool permissions.
- Add five-minute single-use owner-bound HTTPS browser launch links, preview-safe
  manual redemption and owner-epoch revocation checks.
- Keep scoped native delegation by default; explicitly approved private
  followOwner configuration can reuse the core shared-owner conversation.
- No deployment access, credential, identity or network changes are automatic.
- Issue tickets atomically, sweep expired and leftover files without deleting
  unparseable tickets, cap outstanding links under concurrent issue, and refuse
  to hand out a link while the web service is not running (heartbeat check).
- Discussion sessions report the generic `Ez` agent, redeeming a discussion link
  never reads the owner, and expired discussion tickets (with their stored bearer)
  are swept on redeem and bind.

## 0.1.0-beta.3

- Prepare the reviewed GPT-Live native-agent implementation for exact-artifact
  OIDC publication to npm latest. The public beta.2 GitHub artifact is preserved;
  beta.2 was not delivered to npm. No voice behavior or dependency change.
- Derive CLI/help/doctor version reporting from package metadata and check it
  during release validation.
- Human microphone, playback, interruption and device acceptance remain pending.

## 0.1.0-beta.2

- Replace the Realtime API session with the GPT-Live WebRTC contract and fixed
  `gpt-live-1` voice model.
- Use Live client delegation to send tasks through the owning Ez application
  channel and native agent through the shared beta.29 application client instead
  of exposing plugin tools to a second model.
- Seed resumed sessions with bounded retained text, wait for `session.started`,
  and confirm graceful close with `session.closed` before releasing media.
- Require a separately authorized native-agent endpoint and token; provider and
  application credentials remain private container state.

## 0.1.0-beta.1

- Add Dockerized OpenAI Realtime WebRTC sessions with private API-key
  configuration, bounded calls and direct installed Ez plugin/native task tools.
- Preserve the native engine boundary: Voice performs no second reasoning call,
  OCR pipeline, application-specific tool routing or replacement execution queue.
- Retain bounded private conversation text for Resume and New conversation while
  never storing raw audio or replaying old tool calls.
- Serve the bundled client through core's loopback-only web connection, with
  single-use local login or Telegram-signed paired-owner authentication.
- Recheck owner authority, session expiry, Host/Origin and active-tab controls;
  stop pending work and active media on hangup, revocation or connection loss.
- Ship a compact mobile call screen with microphone, mute, End call, New
  conversation, accessible focus/status handling and reduced-motion support.
- Document explicit HTTPS ingress, the optional Telegram Mini App launcher,
  workspace identity binding, install verification and release limits.

Phone/SIP adapters, native CLI-chat inheritance and older-history search are not
included. Real microphone, playback, interruption and device compatibility remain
human acceptance gates and are reported separately from automated checks.
