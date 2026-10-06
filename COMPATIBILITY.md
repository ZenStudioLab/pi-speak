# Speak extension: compatibility record

Recorded 2026-10-02 during `add-manual-speak-extension` tasks 1.2-1.4 and 4.4. Everything under "Verified" was checked by command or by reading the cited source in this session. Everything under "Unverified" is an assumption that must not be treated as fact.

## Host: Pi

Checked against the repo dev dependency (0.87.1) and the installed launcher release (0.99.2): `~/.pi/agent/install/releases/<version>/node_modules/@earendil-works/`. The declarations are identical for every symbol listed.

| Symbol | Declaration (both versions) |
| --- | --- |
| `pi.registerCommand(name, { description?, getArgumentCompletions?, handler })` | `handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>` |
| `ctx.mode` | `"tui" \| "rpc" \| "json" \| "print"` |
| `ctx.isIdle()`, `ctx.hasPendingMessages()` | `boolean` |
| `ctx.sessionManager.buildSessionProjection()` | `SessionProjection { entries, messages: AgentMessage[], thinkingLevel, model }`; model context honors compaction/context edits and is not the speech selector input |
| `ctx.sessionManager.getBranch(fromId?: string)` | `SessionEntry[]`; without an argument, the current leaf's ancestor path, in transcript order; exposed in `ReadonlySessionManager` |
| `ctx.sessionManager.getHeader()` | `SessionHeader \| null`; header contains persisted `cwd`; exposed in `ReadonlySessionManager` |
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
- Speech reads only original `message` entries from `getBranch()` after matching header `cwd` with `ctx.cwd` by absolute-path normalization. Model-context summaries/replacements and non-message entries are not answer text.
- The eligible answer is the last assistant message after the last user message, and only when its `stopReason` is `"stop"`. `"length"` (truncated), `"error"`, `"aborted"`, `"toolUse"`, `"pending"`, and `"deferred"` are not eligible, and an earlier assistant message is never used instead.
- The spoken text is the in-order `text` blocks of that message; `thinking` and `toolCall` blocks are ignored.
- Cancel the extension's own work on `session_shutdown`, `session_before_switch`, `session_before_fork`, and `session_tree`.

## Transcript selection after compaction and resume (Wave 11)

Verified declarations and implementation in both repo Pi 0.87.1 and installed Pi 0.99.2: `dist/core/session-manager.d.ts` exposes `getBranch(fromId?: string): SessionEntry[]` and `getHeader(): SessionHeader | null` through `ReadonlySessionManager`; `dist/core/session-manager.js` walks only the current leaf's ancestors and returns the stored header. The extension uses the command context's manager on every invocation, not `getEntries()`, a remembered answer, or saved-session scanning. The type is taken from `ExtensionCommandContext["sessionManager"]` because `ReadonlySessionManager` is not re-exported by the package root.

Offline tests exercise the production selector and router with real SessionManager instances: compaction retaining a full turn, only the assistant suffix, or nothing; hidden latest aborted/error/length/tool-use/pending/deferred/unanswered turns; active-branch navigation; model-context replacement and omission; empty/no-user history; normalized matching, missing and foreign project identity. Original and localized commands pass selected text through the real speech controller with mocked inference, HTTP and player dependencies.

Disposable test-owned sessions are persisted with `SessionManager.create(cwd, sessionDir)` and reopened via `SessionManager.open(path, sessionDir, cwdOverride?)` before another prompt. Compacted success selects the restored active branch's original answer, a compacted latest failure refuses without fallback, and a cwd override cannot bypass the saved header's project identity. SessionManager writes synchronously and has no close method; reopening uses a new manager. Session replacement clears replay/translation memory even when resumed transcript selection succeeds. No new persistence is added for branch state; speech follows the active manager supplied by Pi.

The focused session/command/resume suites passed against both versions; installed-version checks redirected only test SessionManager imports to that release's native module while leaving production selection/router/controller unchanged. Restoring the pre-Wave-11 router solely in a subprocess loader made all four new compacted-command success cases fail with `no-turn`, confirming regression sensitivity without altering repository files.

These checks qualify transcript selection and native persistence with controlled dependencies, not a live model-produced TUI answer, translation fidelity, cloned-voice quality or billing. The user's saved sessions and live configuration were not read or altered. Replay starts empty after process restart; translation memory also starts empty, so a new explicit localized request may infer before audio lookup. Working-directory equality is normalized path identity, not symlink equivalence or repository-root discovery. Reload activates the change; no paid call was made.

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

## Locale/translation amendment (Wave 5)

The deployed base release has been extended with a speech-only `locale` default `vi`. Written Pi answers remain unchanged. Translation needs an explicit provider/model; original/text modes retain untranslated behavior. No live translation or new paid TTS request was made during this wave. The earlier authorized 123-character Vietnamese TTS check returned HTTP 200, `audio/mpeg`, stopped ffplay with exit 123, and replayed with exit 0 using zero additional provider calls. That technical result does not establish user-confirmed clone quality or provider-visible charges, so task 4.5 stays open.

Verified interface evidence for both repo Pi 0.87.1 and installed Pi 0.99.2:

| Interface | Evidence |
| --- | --- |
| `ctx.modelRegistry` | `pi-coding-agent/dist/core/extensions/types.d.ts`: registry available on extension context |
| `find(provider, modelId): Model<Api> \| undefined`, `hasConfiguredAuth(model): boolean` | `dist/core/model-registry.d.ts` in both releases |
| `getApiKeyAndHeaders(model): Promise<ResolvedRequestAuth>` | same declarations; discriminated `ok` result; returned credentials are never logged or persisted |
| `streamSimple(model, context, options): AssistantMessageEventStream` | same declarations; `result(): Promise<AssistantMessage>` from pi-ai's `dist/utils/event-stream.d.ts` |
| `Context { systemPrompt?, messages, tools? }` | pi-ai `dist/types.d.ts`; fresh answer-only transcript and omitted tools are supported |
| `ModelsSimpleStreamOptions` | pi-ai `dist/models.d.ts`, provider-neutral options; `signal`, `timeoutMs`, `maxRetries`, `maxTokens`, `toolChoice`, `cacheRetention`, `transport` are supported in both releases |
| Request-time auth | `pi-coding-agent/dist/core/model-runtime.js`: `streamSimple` prepares configured provider auth, not the main conversation |

No runtime import of a second Pi or AI client is added: the adapter calls the command context's registry, with type-only imports. The reference example `host/pi/packages/coding-agent/examples/extensions/summarize.ts` demonstrates registry isolation but its hardcoded model, whole-conversation prompt, high reasoning, and UI are deliberately not copied. `host/pi/packages/coding-agent/docs/extensions.md` documents registry `streamSimple` for provider-neutral nested calls.

The adapter sets `maxRetries: 0`, `transport: sse`, tool choice none, cache retention none, and no session identifier. Wave 6 passes the optional configured thinking level as `reasoning`; omission preserves the host default. It calls `streamSimple` once per translation miss with an 8192-token cap (or model maximum if lower) and a 45-second signal/deadline. SDK retry behavior depends on provider support; no application retry is implemented. Raw provider errors are not displayed or forwarded to TTS. Wave 6 allows normally completed text accompanied by thinking blocks, discarding all thinking/signatures and using only text; thinking-only, tool-call, incomplete, or unsupported content still fails without TTS. Virtual models (`api: pi-virtual`) are rejected because the inspected 0.99.2 runtime can route them to a different model/provider, violating this feature's explicit-model/no-substitution boundary.

Offline real-terminal qualification on installed Pi 0.99.2: `/tmp/pi-speak-wave5-terminal.ts` loaded the production extension with a controlled registry and selected-answer fixture. Ephemeral XDG config/cache, a dummy TTS key, and a pre-seeded locally generated MP3 ensured zero billable requests. The first mocked translation stayed pending until stop; the second returned Vietnamese text. This qualifies host command responsiveness and production job/router integration, not live translation accuracy or a genuine model-produced answer.

| Check | Result |
| --- | --- |
| `/speak status` during translation | `job: translating`, responsive |
| Duplicate `/speak` during translation | refused; no extra inference |
| `/speak stop` during translation | signal aborted and job released |
| Next `/speak` | second mock call, cached audio played by real ffplay |
| Status/stop during playback | `job: playing`, responsive stop, no playback failure |
| Replay then stop | cached audio, no third translation and no TTS request |
| Host shutdown | Pi exit 0; no remaining ffplay for this scratch path |

## Translation thinking setup (Wave 6)

The user selected `openai-codex/gpt-6-luna` at `medium`, with speech locale `vi`, and explicitly approved updating their non-secret speech config. Pi 0.87.1 and 0.99.2 `pi-ai/dist/types.d.ts` both expose `SimpleStreamOptions.reasoning?: ThinkingLevel`, where the request levels are minimal/low/medium/high/xhigh/max. The extension passes this setting through the existing registry, includes it in the memory-cache key, and shows it in status; Pi's coding-model settings remain untouched.

Installed Pi 0.99.2 `pi --no-extensions --offline --list-models gpt-6-luna` lists the exact selected provider/model. The installed `openaiCodexProvider().getModels()` static metadata confirms API `openai-codex-responses` (not virtual), reasoning support including medium, and max output 128000 tokens; the extension still applies its own 8192-token cap. This is offline metadata evidence, not a live authentication or inference test. An initial metadata lookup incorrectly assumed an exported `getModel` function; inspection corrected it to the provider factory's static model list without making a request.

Remaining unverified: the user-selected translation model's live language fidelity, auth and billing, actual voice quality, translated-answer narration from a real model turn, non-Linux platforms, and provider-specific transport/retry behavior. Type declarations and mocks alone do not establish those outcomes.

## Translation failure diagnostics (Wave 7)

Verified `ExtensionAPI.appendEntry<T>(customType: string, data?: T): void` in Pi 0.87.1 and installed 0.99.2 declarations. Both versions' `dist/core/agent-session.js` bind it to `sessionManager.appendCustomEntry`. The extension writes `speak-translation-failure` metadata only after a current localized job fails; it does not use `sendMessage` or `sendUserMessage`.

Offline integration tests exercise the real router/controller/translator with controlled provider responses. They verify one notification and matching diagnostic ID, specific stop-reason categories, structural counts, unknown exceptions without guessed HTTP/auth/transport causes, zero TTS/player calls on translation failure, identifier bounds, private-text/reasoning/credential exclusion, and persistence errors preserving the original failure. Existing cancellation/navigation/late-result tests now also verify zero failure entries; original/literal/replay and silence regressions remain passing.

The real Pi 0.87.1 SessionManager test routes the production failure sink into native `appendCustomEntry`, checks the persisted JSONL record, reopens it, and confirms model-context messages are unchanged. A separate offline check against installed Pi 0.99.2's native SessionManager repeats this with a mocked truncated translation: one correlated custom entry persisted/reopened, unchanged model context, one mock inference, zero TTS and player calls. An initial check incorrectly compared a JSON record with an in-memory object containing an optional `undefined` thinking field; comparison was corrected to JSON serialization semantics. No product behavior was changed for that check.

`AssistantMessage` exposes stop reason and content blocks, but no verified structured HTTP status field. HTTP status and raw provider errors are therefore not logged. Session persistence follows Pi settings (`--no-session` is memory-only). These checks qualify the diagnostic path and native session storage, not a new live TUI/provider run or the cause of the earlier intermittent failure. No model, thinking, locale, voice, user config, packaging or whimsical-activity settings were changed, and no paid call was made.

## Idle-visible progress (Wave 8)

Verified `setWidget(key: string, content: string[] | undefined, options?: ExtensionWidgetOptions): void` in the repo Pi 0.87.1 and installed Pi 0.99.2 declarations. Both interactive-mode implementations route it to `setExtensionWidget`; the existing `widget-placement.ts` example shows default above-editor placement. Unlike the native Working surface, the widget does not require agent streaming. The production extension uses only this string-array API, keeps its existing footer status, and never changes Working setters, Whimsical, or the host.

Offline installed Pi 0.99.2 qualification used a 100x32 pseudo-terminal, `--no-extensions --no-skills --no-prompt-templates --offline --no-session`, a scratch-only extension wrapper around the production router/controller, controlled translation/TTS responses, and a fake tracked player. Ephemeral cache/config inputs and a dummy key supplied no live service credentials. ANSI captures were decoded with the host's already-installed test terminal emulator. All four phases rendered as a separate row above the editor while every widget update reported the real `ctx.isIdle() === true`: Preparing, Translating, ElevenLabs, Playing. Status answered `job: playing`; stop reported `Stopped.`, terminated the fake player, cleared the widget, and left no speech row in the final screen. Pi exited 0. Scratch evidence: `/tmp/pi-speak-progress-UXwow8/` (not repository artifacts).

`progress.test.ts` checks actual-phase ordering, both-cache hits, original/literal and replay skips, completion/refusal/translation/provider/player failure cleanup, duplicate preservation, stop and all four lifecycle cancellations, late-result isolation, and cosmetic widget failures. These checks qualify native terminal rendering and command responsiveness with controlled dependencies; they do not verify real provider latency, acoustic playback, language fidelity, or billing. No paid call, real player process, user configuration change, or Whimsical change was made.

## Provider quota and billing (Wave 9)

Official [Get user subscription documentation](https://elevenlabs.io/docs/api-reference/user/subscription/get), checked 2026-10-03, verifies `GET https://api.elevenlabs.io/v1/user/subscription`, the `xi-api-key` header, `character_count`/`character_limit` allowance fields, optional `next_character_count_reset_unix`, `current_overage.amount`/currency and optional `next_invoice.amount_due_cents` with subscription `currency` (USD/EUR/INR/PLN/GBP). The API retains character field names; [billing documentation](https://elevenlabs.io/docs/overview/administration/billing) calls the units credits and explains that product/model/plan affects consumption. No fixed conversion to speech characters or price is asserted.

The registered `/speak quota` subcommand uses the existing notification API, a separate request identity and session cleanup, no new host API or dependency. Offline mocked HTTP/controller tests cover exact GET/auth/redirect behavior, derived remaining/percentage/reset, zero and exceeded allowance, missing or invalid optional billing data, invalid required fields/JSON/size, safe HTTP/unknown/timeout failures, missing key, prompt handler return, duplicate suppression, non-TUI routing, coexistence with speech/stop and stale-session isolation. No speech, model, cache or diagnostic-entry side effects are produced by the query.

Actual account quota, key permission/entitlement, invoice accuracy and live transport behavior remain unverified; no agent-originated user-key lookup or paid service call was made. The user subsequently reported HTTP 401 from their own `/speak quota` invocation; the original handler discarded its error body, so the specific cause cannot be recovered from that notification.

Quota diagnostic correction: official [Errors](https://elevenlabs.io/docs/eleven-api/resources/errors) documentation checked 2026-10-03 specifies `detail.type`, `detail.code` and legacy `detail.status`; [API key documentation](https://elevenlabs.io/docs/overview/administration/workspaces/api-keys) confirms endpoint scope restrictions and expiring keys. The correction reads at most 4 KiB of error JSON and displays only bounded token-shaped identifiers, never provider message/request fields or credentials. HTTP 401 without reliable structured detail remains unconfirmed. Offline fixtures verify modern authorization/authentication codes, legacy missing-permissions status, unsafe/key-shaped identifiers and oversized/unreadable bodies preserving HTTP evidence. These fixtures qualify the classifier, not the cause of the user's actual 401. Provider overage and next invoice are separate reported figures, not a per-speech estimate, PAYG balance/total, local usage counter, or translation-cost analysis. `/<name>` may refer to either a registered command or a loaded skill, depending on the active toolset; `/speak` here is the extension command.
