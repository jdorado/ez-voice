# Ez Voice

Local-owner voice for an Ez agent. The installed Docker plugin owns the live model,
agent identity, Markdown search/read and retained voice conversation. Core provides
one persistent `ez tools connect voice connect` connection and generic installed-plugin
dispatch. The temporary web client handles audio and captions.
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

## Temporary QA client

```sh
node /absolute/installed/package/examples/local-bridge.mjs --ez /absolute/agent/tools/bin/ez --port 8791
```

Open the printed private link in Chrome and select Start talking. The bearer token
survives refresh within the tab; restarting the bridge changes it. The plugin contract
currently has no public web-port exposure. This bridge is an explicit temporary client
transport, not a production webapp channel. Docker owns the actual voice runtime.
Requires a core build providing tools connect and the shared workspace writer guard;
the host worker must also run that build. One connection container is started for
the client lifetime. Session events flow over that connection without polling CLI
containers. Actual plugin CLI operations still use the standard command containers.

Ask who the agent is, then ask about a known Markdown file. Confirm search/read activity
and compare its answer with the original. Audio quality needs owner QA, not just tests.

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
plugin's own usage. plugin_run accepts an alias and a JSON array of literal arguments.
No Library-specific bindings or per-plugin voice schemas exist. Registry changes are
visible on the next discovery request. Core checks alias/revision again at execution.
The connected plugin itself is excluded. The trusted owner connection uses the agent's
existing plugin permissions without a second voice approval prompt. The agent follows
the owner's request and each plugin's own authorization rules. End cancels pending commands; an
already-started external operation may still have an uncertain outcome. Core rejects
invocation when the owning native workspace has pending/running work.

agent_tasks exposes the owning agent's existing native task CLI. It can request
image/PDF processing through that agent's native tools and the installed Library
intake instructions, then search the source-linked text. It reuses Ez's scheduler
and native executor; voice does not implement OCR or another execution queue.
Submission returns a task receipt. Check native task status and indexed source
readback before reporting completion. The native task may finish after the call ends.

Completed text transcripts are atomically stored in the private plugin volume under
conversations/, with latest-conversation.json selecting the current conversation.
Resume talking restores up to 30 recent messages/12,000 characters into a new live
session. It restores text with original user/assistant roles, never old tool calls.
Each retained conversation is bounded to its latest 500 message items. New conversation
starts a new retained file and preserves the prior file. Interrupted assistant
transcripts are removed because the provider cannot align the text to played audio.
Raw audio is not stored. UI captions can include generated words the owner did not hear.

This is the owning agent's identity/workspace in a distinct live-model context. Native
CLI chat is not inherited. Older-history search is not exposed in this increment.

End stops the call. Stopping the bridge requests hangup; a 60-second lease closes
abandoned sessions. Calls are capped at 20 minutes and 100 tool calls. Uncertain hangup
is reported without automatic redial. ez plugins stop voice stops the runtime;
uninstall preserves the private data volume.

Development: pnpm install --frozen-lockfile; pnpm verify; npm run release:check.
Build Docker test/runtime targets from the packed artifact and run docker/smoke.mjs.
See CONTRIBUTING.md and SECURITY.md. MIT licensed; provider usage is paid.
