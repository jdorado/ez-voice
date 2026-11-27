---
name: voice
description: Owner-authenticated GPT-Live conversation delegated to the owning native Ez agent.
---

Use the owning agent's bound `ez voice --help` and read the packaged README.
Resolve the agent name, purpose, application endpoint, private network and
application credential from the authorized deployment; never infer them from the
shell cwd or browser input. Configure both credentials through private stdin.

GPT-Live owns only the spoken frontend. Requests needing facts, files, planning,
tools, permissions or actions delegate through the existing Ez application
channel to the native agent. That native engine follows its workspace
instructions, installed plugin skills, authority and confirmation rules. Treat
voice transcripts as fallible fragments. Never claim an external action succeeded
without its authoritative receipt, and do not retry an uncertain mutation.

For local QA, give the owner the one-time localhost link from `ez tools serve`.
For Telegram, follow the README HTTPS and paired-owner setup. Verify the bound
identity, `gpt-live-1` session start, one real native delegation result, graceful
End and Resume. Text transcripts are privately retained; raw audio and native tool
calls are not. Do not claim microphone, playback, interruption or audible quality
from automated tests.

End requests cancellation of admitted backend work and waits for provider
finalization. `ez plugins stop voice` stops the runtime. Stop `tools serve` when
finished. Uninstall preserves private data. Do not redial or replay uncertain work.

For a verified private installation-owner chat, `ez tools connect voice launch`
issues a five-minute single-use HTTPS browser link after the approved web service
is running. The bearer link is a credential: deliver only to that exact authorized
owner chat with previews disabled; never to business contributors or logs.
The owner explicitly redeems, then starts the microphone. This command creates
no owner grants, application credentials, shared history or HTTPS routes.

Restricted WhatsApp discussions use the core-provided `browser_link` tool, not
`ez tools connect voice launch`. It returns a five-minute single-use link for
that exact discussion. Deliver it as text in the same chat; a voice note cannot
carry a tappable link. The browser call delegates into that discussion’s existing
restricted task and notes. It cannot use owner history or general owner tools.
The owner must explicitly grant the installed `launch --task` command through
core application administration; installation alone grants no task access.
One browser call can be active per Voice runtime. End it before another begins.

`ez voice phone --help` describes the separate inbound/outbound Twilio audio channel. It
connects directly to a speech provider (GPT-Live by default; ElevenLabs Realtime, Gemini Live or Deepgram Voice Agent by `provider` in its private configuration) and has no native-agent delegation, owner history,
workspace access or action tools: its tools are `end_call` and, on a deepgram or elevenlabs line with `transferBinding`, `transfer_call`. Its private configuration needs the provider key, Twilio Account SID and account Auth Token, voice-capable
number(s) and HTTPS origin; `lines` serves several numbers from one install, `maxCalls` calls at once. A line's persona is
`instructions` (a string) or `instructionsFiles` (1..8 relative paths) with `instructionsRoot` (an absolute folder, top level or per
line), never both: the files are read fresh at the start of every call, and a missing, empty, oversized or out-of-root file
refuses the call (an outbound `phone call` names the file and does not dial). Each receipt keeps `instructionsSha256`;
`phone doctor` reports which files are readable, never their text. Number routing
requires deployment-owner authority. Preview/readback and restore affect voice routing only (the first line's number).
The phone listener stays available until stopped, with a per-call limit (three minutes unless `maxCallSeconds` is set),
and a call ends after `idleSeconds` with nobody speaking. An inbound call rings on until the model's first words
(`answerTone`: `ringback` or `none`), then the model greets. Keep the installed `tools serve` command under the
deployment supervisor. Restore the previous route before decommissioning its endpoint.
Every phone call is recorded at Twilio (dual-channel, retrievable by Call SID through the
account); the plugin stores no audio. The private call receipt (`phone receipt --call-sid CA...`, also shown by
`call-status` for its Call SID) reports `recording` as `started` with the Recording SID or `failed` with a code, and
keeps the call's transcript as the provider heard it. The operator is responsible for any recording notice to callers.
`contextBinding {url, token, deadlineMs}` asks the operator's backend what it knows of an inbound caller as the call arrives
(see docs/phone.md, "Caller context"). The caller ID it is asked about can be spoofed.
`transferBinding {url, token, deadlineMs <= 5000}` names the backend that decides who a caller is handed to: a deepgram or elevenlabs line's
model then has `transfer_call({whisper})` (1..300 characters the colleague reads on their panel before joining; their phone says only "Quarre call for you. Press 1 to join."; the call's words stream to the backend as `words` posts). It returns at once; the caller
moves into a conference with the person only after the 1 and the model's handover sentence, and the call ends `transferred`
(`call-status` reports it with `transfer {person, personCallSid, at}`). `phone connect --to NUMBER --from LINE --request-id ID
--whisper - < whisper.txt` rings that person, then dials NUMBER on their 1; exit 3 means the backend refused the claim;
`call-status` reports `ringing_person`, `joined`, `completed`, `no_answer`, `declined` or `failed`. A person on another call can be
`queued` for: the caller waits with the model while the backend is polled, and the person may take them (the current owner held)
or go back to a held owner. See docs/phone.md, "Live transfer and connect".


For an explicitly authorized recipient, `ez voice phone call --to E.164 --request-id ID [--from LINE]
[--instructions - < brief.txt]` places one call from that line (the first by default), with an optional brief for that
call only, through the running phone service.
`call-status --request-id ID` reads its provider state; `hangup --request-id ID`
cancels ringing or ends an answered call. Reuse the original request ID to inspect
an attempt without redialing. An uncertain creation is not permission for a new
request ID or retry. The command's private receipt and provider readback own the
outcome. Outbound calls share the existing audio-only context and call limits.
