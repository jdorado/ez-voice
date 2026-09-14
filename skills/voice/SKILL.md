---
name: voice
description: Enable and inspect owner-only realtime voice with direct installed-plugin lookups.
---

# Voice

Use the bound `ez voice --help` and `ez voice doctor`. This plugin uses an OpenAI Realtime model with
direct function calling; GPT-Live's backend delegation is a different API and is not supported here.

Install a reviewed source through `ez plugins inspect voice --source PATH`, then
`ez plugins install voice --source PATH --revision HASH` and `ez plugins start voice`.
The installed agent completes onboarding through usable voice, not merely container health.

Required input: an OpenAI project API key with access to the configured Realtime model. Reuse a
connection only when authorized. Send JSON `{ "apiKey": "..." }` to `ez voice configure` over private
stdin, never argv or chat output. Model and voice are optional configuration fields. The provider key
is atomically persisted at 0600 in the private volume. `doctor` reports configured, not live verified.

Read the packaged README for the temporary local web transport. Select the correct agent-bound
launcher and write a private tool profile from the example. Inspect installed tools with
`ez tools list --details` and their own help. Bind explicit read operations; do not expose shell,
raw arbitrary argv, administrative operations, or an entire plugin just because it is installed.
The operator owns these grants. For the pilot use Library search/read/list. API schemas stay with
this plugin; business instructions stay in the owner's prepared brief and existing plugin skills.

Share the private localhost launch link with the owner, open the page, and verify microphone input,
audible model output, one actual Library lookup, interruptions and clean hangup. Do not claim audible
quality from a transcript or build. Return the installed version, tool latency and any remaining QA.

Stop with the page End button and `ez plugins stop voice` when requested. The temporary bridge has its
own process lifetime; stop it too. Uninstall preserves the private data volume. Back up that volume
privately; revoking the OpenAI key is separate from removal. State schema is 1; no migration is needed
for this first beta. Do not automatically redial, restart calls, or replay uncertain operations.
