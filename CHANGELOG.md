# Changelog

## Unreleased

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
