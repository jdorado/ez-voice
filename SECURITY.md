# Security

Report vulnerabilities privately through GitHub's Security tab. Do not include keys or private transcripts.

This beta is an owner-only local voice interface. It is not a public or multi-tenant agent service.
The local bridge listens only on 127.0.0.1, checks Host/Origin and requires a random bearer token.
The launch link contains that token in its fragment. Anyone with the token and local access can use
the configured voice tools. Treat bridge logs containing the link as private. Do not expose the port
through a tunnel or reverse proxy. Local host administrators and installed plugin code are trusted.

The operator supplies explicit tool schemas and literal argv templates. `effect: read` is a declaration
to review, not proof that a CLI is read-only. Inspect the actual operation before binding it. The model
cannot select another executable or append free-form argv. No general shell, write tools, arbitrary
workspace mount, Docker socket mount, or main-agent session is exposed to the voice container.
The host bridge invokes the existing agent-bound Ez dispatcher. Subprocess environments are filtered.

OpenAI receives voice, startup context and returned tool data. Credentials stay in the plugin's private
volume and are never sent as context. The browser can observe its own session events and tool results.
Provider-generated completed tool calls are executed by the server connection only. Browser event
messages are never accepted as host tool requests. Retrieval results can contain malicious instructions;
tool argument validation and reviewed bindings remain necessary even with prompt guidance.

Calls are limited to one active session, 20 minutes and 100 tool calls. Closing the bridge stops its
session; an uncertain provider hangup is reported and never silently retried. Recording and durable
conversation memory are not implemented. Uninstall preserves private volume data; revoke API access
separately in the provider account.
