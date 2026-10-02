# Speak extension: compatibility record

Recorded 2026-10-02 during `add-manual-speak-extension` tasks 1.2-1.4 and 4.4. Everything under "Verified" was checked by command or by reading the cited source in this session. Everything under "Unverified" is an assumption that must not be treated as fact.

## Host: Pi

Checked against the repo dev dependency (0.87.1) and the installed launcher release (0.99.2): `~/.pi/agent/install/releases/<version>/node_modules/@earendil-works/`. The declarations are identical for every symbol listed.

| Symbol | Declaration (both versions) |
| --- | --- |
| `pi.registerCommand(name, { description?, getArgumentCompletions?, handler })` | `handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>` |
| `ctx.mode` | `"tui" \| "rpc" \| "json" \| "print"` |
| `ctx.isIdle()`, `ctx.hasPendingMessages()` | `boolean` |
| `ctx.sessionManager.buildSessionProjection()` | `SessionProjection { entries, messages: AgentMessage[], thinkingLevel, model }`; `buildSessionProjection` is in `ReadonlySessionManager` |
| `session_start` | `reason: "startup" \| "reload" \| "new" \| "resume" \| "fork"` |
| `session_shutdown` | `reason: "quit" \| "reload" \| "new" \| "resume" \| "fork"` |
| `session_before_switch` | `reason: "new" \| "resume"` |
| `session_before_fork` | `entryId`, `position` |
| `session_tree` | `newLeafId`, `oldLeafId` (branch navigation) |
| `UserMessage` | `role: "user"`, `content: string \| (TextContent \| ImageContent)[]` |
| `AssistantMessage` | `role: "assistant"`, `content: (TextContent \| ThinkingContent \| ToolCall)[]`, `stopReason` |
| `StopReason` | `"pending" \| "stop" \| "length" \| "toolUse" \| "error" \| "aborted" \| "deferred"` |

Not documented by Pi: whether an awaited command handler blocks other commands in the terminal. The design returns from the handler immediately, and the real-terminal check below confirmed that `/speak status` and `/speak stop` are accepted while a clip is playing.

Decisions derived from the declarations:

- `AgentMessage` also includes custom message roles. Answer selection looks only at `role === "user"` and `role === "assistant"` messages.
- The eligible answer is the last assistant message after the last user message, and only when its `stopReason` is `"stop"`. `"length"` (truncated), `"error"`, `"aborted"`, `"toolUse"`, `"pending"`, and `"deferred"` are not eligible, and an earlier assistant message is never used instead.
- The spoken text is the in-order `text` blocks of that message; `thinking` and `toolCall` blocks are ignored.
- Cancel the extension's own work on `session_shutdown`, `session_before_switch`, `session_before_fork`, and `session_tree`.

## Provider: ElevenLabs

Source: `https://elevenlabs.io/docs/api-reference/text-to-speech/convert` and `https://elevenlabs.io/docs/overview/models`, fetched 2026-10-02.

Verified from those pages:

- `POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}` with an `xi-api-key` header and a JSON body containing `text` and `model_id`.
- Query parameter `output_format` defaults to `mp3_44100_128`; MP3 at 192 kbps needs Creator tier or above; 44.1 kHz PCM/WAV needs Pro or above.
- `optimize_streaming_latency` is deprecated.
- `enable_logging=false` (zero-retention mode) is enterprise-only, so the default request is retained by the provider.
- `eleven_flash_v2_5` is described as the fastest model, supports 32 languages including Vietnamese, and its quoted latency excludes application and network time.
- A 422 validation error is documented.

Unverified (the pages do not state them):

- The response `Content-Type` for a successful MP3 response. The design accepts a successful response only if its content type is `audio/*` and the body is nonempty; if the real value differs, the live check (task 4.5) will show it and the artifacts must be amended rather than the check silently loosened.
- The exact error body shape for 401, 403, 404, 429, and 5xx.
- Redirect behavior of the production origin. The extension rejects redirects regardless.
- Pricing, the allowance that API calls consume, and whether the user's subscription covers API use of a cloned voice. None of this is used by the code.
- The user's voice ID and key. Both are supplied by the user outside the repository.

## Player: ffplay (the only MP3-capable player confirmed on this machine)

Environment: `mpv` absent; `ffplay`, `ffmpeg`, `pw-play`, `aplay` present; ffplay 6.1.1; Node v22.19.0; `ffplay` opened an audio output and ran a 1 s tone to completion with exit code 0 (that audible output was heard was not confirmed by a person).

Spike (`/tmp/speak-spike`, scratch, not part of the repository), launched with `child_process.spawn("ffplay", ["-nodisp", "-autoexit", "-loglevel", "quiet", file], { shell: false, stdio: ["ignore", "ignore", "pipe"] })` and `ELEVENLABS_API_KEY` removed from the environment:

| Case | Result |
| --- | --- |
| 1 s MP3 played to the end | exit code 0 after about 1.3-1.5 s |
| 30 s MP3 killed with `SIGTERM` after 0.8 s | process ended after about 0.8 s with exit code 123 and no signal reported |
| Processes remaining afterwards | none |

Findings that change the implementation:

- `ffplay` handles `SIGTERM` and exits with code 123, not with a signal. A job that has been asked to stop must treat any exit as a cancellation and never report it as a playback failure.
- `-nostdin` is not a valid `ffplay` 6.1.1 option; it makes the player exit with code 1 immediately. Standard input is ignored through `spawn` stdio instead, and the documented argument list does not include `-nostdin`.
- `pw-play` accepted an MP3 file and exited 0, but audibility was not verified, so it is not a documented default.

This spike does not prove behavior inside the Pi terminal; the real-host checks below do.

## Real-host checks on the installed Pi 0.99.2 (2026-10-02)

Both checks loaded only this extension (`--no-extensions -e .../extensions/speak/index.ts`, `--offline`, `--no-session`, ephemeral XDG config and cache directories, no `ELEVENLABS_API_KEY`). Neither made a provider or model request.

**RPC mode** (`pi --mode rpc`): `get_commands` listed `speak` with source `extension`. `/speak status` reported `not configured: no configuration file at ...`; `/speak text ...` reported that speech works only in the interactive terminal (so `ctx.mode` is `"rpc"` there); `/speak frobnicate` showed usage; `/speak summary` reported it is unavailable; `/speak stop` reported nothing active. No agent, turn, or message events occurred, nothing was written to the configuration or cache directories, and Pi exited on SIGTERM.

**Interactive terminal** (Pi's TUI in a 120x40 pseudo-terminal), with a valid configuration and a locally generated 30 s tone placed in the cache under the exact key for the text `hello there`, so the request was a cache hit and no network or key was involved:

| Step | Observed |
| --- | --- |
| `/speak status` | redacted configuration (`voice: ...7890`), `ELEVENLABS_API_KEY: missing`, cache of 1 clip, `job: idle` |
| `/speak text hello there` | the real `ffplay` started; Pi's status line showed `speak: playing` |
| `/speak status` while playing | answered immediately with `job: playing`, so the command handler returns promptly and the terminal stays responsive |
| `/speak text second request` while playing | `Speech is already active. Use /speak stop to end it.`; no second player started |
| `/speak stop` | `Stopped.`; the player ended; no `Playback failed` message; the status line cleared |
| `/speak replay` then `/speak stop` | replayed from the cache without any request, then stopped |
| Pi terminated by SIGTERM | no `ffplay` process remained |

The captured screen contained no player output (no SDL, stream, or libav text) over Pi's interface.

Not covered by these checks: speaking a real assistant answer in the terminal (needs a model turn), a real ElevenLabs response (content type, error bodies, voice and model acceptance, billing), and whether the tone was audible to a person. The live provider check is task 4.5.
