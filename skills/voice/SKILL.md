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
