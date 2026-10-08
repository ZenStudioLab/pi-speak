# Speak

Hear a Pi answer in a configurable speech language (default Vietnamese), or text you type, in your authorized ElevenLabs voice. Pi's written answers remain unchanged. **Nothing is translated, spoken, summarized, or sent anywhere unless you run `/speak`.** Loading, reloading, prompts, tools, and agent completion are silent.

This extension is local to this repository. It is not part of the published `@zenstudiolab/pi-toolset` package and is loaded explicitly with `pi -e`.

## Setup

1. **Voice.** In ElevenLabs, create or choose a voice you have the right to use (your own voice, or a licensed one) and copy its voice ID. Keep any recordings out of this repository.
2. **API key.** Create a dedicated key in ElevenLabs, restrict it to what you need, and give it an account or key limit. Export it in the environment that starts Pi:

   ```bash
   export ELEVENLABS_API_KEY="..."
   ```

   The key is read only from this variable. It is never written to the configuration, the cache, logs, notifications, process arguments, or the player's environment.
3. **Player.** Any local player that can play MP3 and accepts a file path. The default is `ffplay` (part of ffmpeg); `mpv` should work with the arguments shown below, but it was not available to test with.
4. **Configuration.** Create `~/.config/pi-speak/config.json` (or `$XDG_CONFIG_HOME/pi-speak/config.json`):

   ```json
   {
     "voiceId": "YOUR_VOICE_ID",
     "modelId": "eleven_flash_v2_5"
   }
   ```

   This minimal config supports `/speak original`, `/speak text`, and replay. For localized `/speak`, explicitly select an authenticated model from Pi's model picker/registry and add:

   ```json
   {
     "voiceId": "YOUR_VOICE_ID",
     "modelId": "eleven_flash_v2_5",
     "locale": "vi",
     "translation": {
       "provider": "YOUR_SELECTED_PI_PROVIDER",
       "model": "YOUR_SELECTED_PI_MODEL",
       "thinking": "medium"
     }
   }
   ```

   Optional `translation.thinking` accepts `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; it controls only the isolated translation request and its cache identity, never Pi's coding-model thinking. Omit it to retain the host/provider default. For this user's setup, the selected pair is `openai-codex` / `gpt-6-luna` with `medium` thinking.

   Choosing the translation provider/model accepts its separate inference cost and disclosure of the cleaned answer. These placeholders are examples, not automatic model choices. Authenticate through Pi, never this config. `locale` accepts canonical BCP-47 tags such as `vi`, `vi-VN`, or `en`; omitting it defaults to `vi`. Check that both the translation model and ElevenLabs model/voice support your intended language; a valid tag does not establish that support. No voice or model is substituted on failure.

   **Existing-config migration:** old configs still load, but bare `/speak` now targets Vietnamese and requires translation setup. Use `/speak original` to retain the previous untranslated-answer behavior. No file is automatically rewritten.

   Only `voiceId` and `modelId` are required for the literal/original paths. Base defaults are shown here (`translation` is unconfigured):

   ```json
   {
     "voiceId": "YOUR_VOICE_ID",
     "modelId": "eleven_flash_v2_5",
     "outputFormat": "mp3_44100_128",
     "voiceRevision": 1,
     "locale": "vi",
     "hardLimitChars": 4000,
     "requestTimeoutMs": 45000,
     "player": { "command": "ffplay", "args": ["-nodisp", "-autoexit", "-loglevel", "quiet", "{file}"] },
     "cache": { "maxBytes": 104857600, "ttlDays": 7 }
   }
   ```

   `player.args` must contain the element `{file}` exactly once; it is replaced by the audio path and stays a single argument. For `mpv`, use `"command": "mpv"` and `"args": ["--no-config", "--no-video", "--really-quiet", "{file}"]`. Unknown keys are rejected, so a pasted secret is refused rather than stored. Raise `voiceRevision` whenever you change or re-clone the voice behind the same ID, so older cached clips are not reused. `hardLimitChars` can be lowered but never raised above 4000.
5. **Load it.**

   ```bash
   pi -e /absolute/path/to/pi-toolset/extensions/speak/index.ts
   ```

Missing or invalid configuration never stops Pi from starting. It is reported when you run `/speak` or `/speak status`.

## Commands

`/speak` is this extension's registered command. In general, `/<name>` may refer to either a registered command or a loaded skill, depending on the active toolset.

| Command | What it does |
| --- | --- |
| `/speak` | Clean the latest completed answer, translate faithfully to `locale` (default `vi`), then speak. |
| `/speak original` | Clean and speak the latest answer without translation. |
| `/speak text <text>` | Speak exactly the text you supply. |
| `/speak stop` | Stop this extension's generation or playback. Other audio and the coding agent are untouched. |
| `/speak replay` | Play the last clip again from the cache. Never regenerates. |
| `/speak status` | Show redacted configuration, key presence, job state, and cache size. Makes no request. |
| `/speak quota` | Fetch account-wide ElevenLabs credits remaining and provider-reported billing figures. No speech. |

Speech works only in the interactive terminal. In other Pi modes speech subcommands say so and do nothing; `status` and `quota` are separate informational commands. One speech job runs at a time; a second request is refused rather than queued.

### Compaction and resumed sessions

Both `/speak` and `/speak original` need the agent to be idle with no queued work. They select the final answer of the latest user turn from the **current session's active transcript branch**, only when that answer finished normally. Compaction may remove the user turn or answer from model context; the original transcript entries remain eligible, including immediately after resuming the saved session before a new prompt. Summaries and context-only replacements are never spoken.

The saved session's project working directory must match the command's current directory after absolute-path normalization. Missing project identity or another project's session is refused before translation or speech. No other session files or abandoned branches are searched. A latest unanswered, failed, aborted, truncated, or tool-only turn is reported rather than skipped—even when compaction has hidden it from model context. There is no fallback to an older successful answer.

Resuming restores answer history, not the extension's memory. After restart there is nothing to replay until a clip is played in that process, and a localized request may need fresh translation before checking cached audio. Run Pi's `/reload` after updating to activate this selection change.

### Quota and cost analysis

`/speak quota` makes one live, read-only account lookup using `ELEVENLABS_API_KEY`. It needs no voice/player/translation configuration and does not require the main agent to be idle. If a restricted key is denied access, check its subscription-read permissions yourself; the extension never expands them. It immediately reports `Checking ElevenLabs quota...` and returns control so `/speak stop` remains usable. A duplicate pending lookup is refused; session cleanup cancels it and suppresses stale results.

The result shows account-wide credits used/allowance, remaining credits, usage percentage, and the next reset in UTC. Usage beyond the allowance is shown separately; a zero allowance has no defined percentage. Credits are not a guaranteed number of speech characters: consumption depends on product/model/plan, and this account view includes other usage too.

Cost analysis shows **provider-reported current overage** and **next invoice** in their reported currencies when available. Missing or invalid optional data is labeled unavailable, never zero. These figures are not added together, attributed to this extension, or converted into a per-speech price. PAYG balance/total spend and translation-model costs are not available from this endpoint. Check the ElevenLabs billing dashboard for the complete account picture.

Only this explicit command queries `GET /v1/user/subscription`; there is no polling, speech, billing mutation, audio-cache access, or account-data persistence. The request has a 10-second deadline, 64 KiB response cap, no redirects and no retry. HTTP failures show the HTTP status and safe structured provider `type`, `code`, and legacy `status` identifiers when available (error JSON is capped at 4 KiB). For example, a reported `missing_permissions` directs you to subscription-read access, while `invalid_api_key` directs you to key validity. A 401 without reliable provider detail does not claim your key is invalid. Invalid/oversized/unreadable error bodies retain the HTTP status with an unconfirmed cause. Provider message text, request data, raw payloads/errors and credentials are never displayed or saved. Quota and invoice output is private account information; avoid sharing it publicly. `/speak status` remains local and network-free. After updating, run Pi's `/reload`, then `/speak quota`.

### Progress while waiting

An active speech job shows a separate line **above the editor**, including when Pi's main agent is idle: `Speech: Preparing...`, `Speech: Translating...`, `Speech: ElevenLabs...`, then `Speech: Playing...`. It shows the current phase, not a percentage. Original/literal speech skips translation; cache hits and replay skip work they do not perform. Fast phases may pass too quickly to notice.

The line clears on completion, refusal, failure, `/speak stop`, or session/branch cleanup. Commands remain usable while it is visible. The existing footer status is retained; native Working/Whimsical is not changed. Progress is temporary UI only, not a conversation message or diagnostic log. Run Pi's `/reload` command after updating this extension to activate it.

### Translation is not summarization

Localized `/speak` sends only the cleaned selected answer to a separate, tool-free model call. It does not send repository files, conversation history, tool logs, or hidden reasoning, and does not change Pi's coding model, prompts, tools, or conversation. Instructions require faithful meaning, numbers, negation, identifiers, and qualifications, not a summary. Already-target-language answers still use one rendering call on a cache miss; the instruction asks to preserve suitable wording.

Preflight checks TTS config/key, player, locale, source length, and translation model/authentication before inference. Translation has a 45-second deadline and up to 8192 output tokens (or the model's lower limit), no automatic retry/fallback, and incomplete/tool-call/unsupported-content/code-block results are refused. A completed answer may include thinking blocks; only its text blocks are used, while reasoning and signatures are discarded without logging, caching, or speech. Thinking-only results are refused. Translated output must also fit `hardLimitChars`. Failure never sends the original-language answer as a fallback. Structural checks do not prove linguistic accuracy; verify bilingual quality yourself.

`/speak stop` also cancels translation. A canceled or late result cannot trigger TTS or playback. Translation errors suppress raw provider payloads to avoid logging credentials or source text.

### Diagnosing translation failures

The next failure reports what was observed: setup/authentication, deadline, provider-reported error or abort, token-limit truncation, incomplete output, unsupported/tool content, no usable text (including thinking-only), code markup, or output length. A thrown exception without a reliable cause stays **unknown**; it is not guessed to be offline, an authentication problem, or rate limiting. No failure triggers an automatic retry, fallback, or configuration change, and none sends text to ElevenLabs. Inference billing may still be uncertain after a request starts.

When recording succeeds, the existing failure notification ends with `[diagnostic <id>]`. Search the current Pi session's JSONL file for that ID or `"customType":"speak-translation-failure"` (normal sessions are under `~/.pi/agent/sessions/`). The matching entry has `type: "custom"` and a metadata-only `data` object:

- `version`, `diagnosticId`, `code`, `stage`, timestamp and elapsed milliseconds.
- Configured provider/model/locale/thinking identifiers (bounded to 128 characters), whether inference started, billing uncertainty, and the configured output-token cap when known.
- The observed stop reason and counts of text/thinking/tool/other blocks when a result exists; unknown values are mapped to `unknown` or `other`.

No source/translated text, source hashes, reasoning/signatures, credentials, headers, raw error messages, or provider payloads are recorded. HTTP status is not available through the inspected result interface, so it is omitted rather than extracted from error strings. These entries do not enter model context or start an agent turn. They follow Pi's session storage and retention; `--no-session` keeps them in memory only. Do not share entire session files as diagnostic logs: ordinary conversation entries can contain private text.

Recording is best effort. If it throws, the original failure is still shown once, without a diagnostic reference. Stopped, cancelled, late, and replaced-session jobs produce no failure record. Successful speech does not produce diagnostic entries. This makes the next intermittent failure inspectable; it does not establish the cause of an earlier failure that lacked this evidence.

### What is spoken

- **Answer cleanup (both modes, before translation):** code blocks, unfenced command output (shell prompt lines, diffs, stack frames, one-line JSON), commit hashes, images, HTML, link addresses, and bare URLs are removed; link labels, inline identifiers, numbers, negations, and qualifications are kept; a table becomes one sentence saying it is in the text response. Nothing is summarized or reinterpreted.
- **`/speak text`:** your wording is sent as typed. Only terminal escape sequences and control characters are removed, and runs of whitespace become one space.
- **Length:** at most 4000 characters (Unicode code points), or the configured lower limit. Localized speech checks both cleaned source and translated output. Longer text is refused with its length; nothing is truncated or split.

## Cache

Generated clips are stored in `$XDG_CACHE_HOME/pi-speak` (default `~/.cache/pi-speak`), in an owner-only directory with owner-only files. File names are hashes of everything that affects the audio (text, voice, model, format, voice revision), so no source text is stored. An audio cache hit makes no ElevenLabs request. Locale is part of the audio key (`original` for original/literal modes), so changing speech locale does not reuse another locale's audio. Adding this discriminator changes keys from the base release: older clips may miss once on a new explicit request; they are not automatically deleted or regenerated.

Up to 32 valid translations are cached in session memory by source hash, locale, translation model/settings, and prompt/normalizer versions; source and translated text are not persisted. Oldest entries are evicted, and session/branch navigation clears them. A valid translation can be reused after TTS failure. With both caches available, a repeated localized request makes no model or TTS call. After restart or memory eviction, a new translation call may be needed before audio lookup. `/speak replay` always makes zero model/TTS calls and plays the previous clip unchanged even if locale was edited.

Clips are kept for 7 days from their last use and the cache is capped at 100 MiB; the oldest are removed first and a clip that is playing is never removed. To clear the cache by hand, delete that directory.

## Cost, privacy, and limits

- Each translation miss may incur separately billed inference on the explicitly selected provider; local usage accounting and integration with Pi's core totals are not claimed. Each audio cache miss is one billable ElevenLabs request. There are no automatic retries and no fallback to another model, voice, or provider. After a timeout or network failure it is unknown whether the attempt was billed, and cancelling a request is not known to restore any allowance.
- The prepared text is sent to ElevenLabs on every cache miss. According to ElevenLabs' documentation (checked 2026-10-02), zero-retention mode is available only to enterprise customers, so assume standard requests are retained by the provider.
- Cached audio on disk can be sensitive. Permissions limit access to your user; they are not encryption.
- Other processes you run, and other Pi extensions, run with your permissions and can read the environment, this configuration, and the cache. This extension does not defend against them.
- This version does **not** scan text for secrets before sending it. Do not speak credentials or confidential text.
- Usage is not tracked locally. Use the limits on your ElevenLabs account or key.

## Not in this version

These are intentionally absent and documented in `openspec/changes/add-manual-speak-extension/design.md` under "Deferred Capabilities", so each can become its own specification:

- `/speak summary` (running it says it is unavailable)
- confirmation prompts for long text
- secret-pattern blocking before sending
- `/speak cache-clear` (running it says it is unavailable)
- local usage accounting

## Removal

Stop passing `-e .../extensions/speak/index.ts`, delete `~/.config/pi-speak` and `~/.cache/pi-speak`, and revoke the API key in ElevenLabs.

## Development

```bash
npm run check   # typecheck and all tests, using mocked HTTP and mocked player processes
```

The tests need no key, network, or audio device. `COMPATIBILITY.md` records what was checked against Pi 0.87.1 and 0.99.2, the ElevenLabs documentation, and the `ffplay` player, and what remains unverified.
