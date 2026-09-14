# Changelog

## Unreleased

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
