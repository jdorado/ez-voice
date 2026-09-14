---
name: voice
description: Local-owner realtime voice with agent identity and Markdown context.
---

Use the owning agent's bound ez voice --help and read the packaged README. Resolve
workspace, name and purpose from existing agent configuration. Bind the workspace
read-only; never infer it from the shell cwd. Configure credentials through private
stdin. The container loads SOUL.md/USER.md and owns context search/read execution.

The bundled web client uses core's persistent tools connect transport. Core supplies
dynamic plugins_list, plugin_help, plugin_skill and native plugin_run calls; no
Library profile is needed. Read each plugin's own instructions before invocation.
Discover native commands with core_tools and read their --help through core_run.
For scanned sources that need native image/PDF tools, use the native schedule
command and Library intake instructions. Request processing of
the verified original into source-linked searchable text, then check task status
and search/read back the stored result. Do not add a voice-specific OCR pipeline.
For explicitly requested message/file delivery, use the discovered native message
command directly through core_run. For a Library original, read its CLI help,
retrieve it with get --raw and a simple plugin_run output_name, then after code 0
pass artifact.path to message --document. Use an empty output_name for ordinary text
commands. Do not ask for repeat confirmation; verify the delivery receipt before
reporting sent. Respect command availability and do not retry uncertain delivery.
Give the owner the private localhost link. Verify identity, Markdown lookup, native
plugin discovery/use, then End and Resume talking. Text transcripts are privately
retained; resume restores a bounded recent window, never old tool calls. Native CLI
chat and older-history search are not exposed. Do not claim audio quality from tests.

End stops calls; ez plugins stop voice stops the runtime. Stop the temporary bridge
when finished. Uninstall preserves private data. Do not redial or replay uncertain work.
