# Speak

Hear a Pi answer in a configurable language (default `vi`), or speak text you type, through the selected speech provider. Dictate a prompt by push-to-talk: one key sends it to the agent as soon as it is transcribed, and a second key only adds the text to the composer for you to review. **The default key `alt+t` now sends; use `alt+shift+t` to review first.** Nothing is translated, spoken, recorded, or sent anywhere unless you run `/speak`, run `/talk`, or press a push-to-talk shortcut. Loading, reloading, prompts, tools, and agent completion are silent.

This extension is local to this repository. It is loaded explicitly with `pi -e` and is not part of the published package.

## Setup

1. **Voice.** For speech output, create or choose a voice you have the right to use: your own, or a licensed ElevenLabs voice, or a Deepgram Aura voice. Keep any recordings of voices out of this repository. Nothing here substitutes a voice for you.
2. **API keys.** Create dedicated keys for the providers you intend to use, restrict them to what you need, and give each an account or key limit. Export them in the environment that starts Pi:

   ```bash
   export ELEVENLABS_API_KEY="..."
   export DEEPGRAM_API_KEY="..."
   ```

   Keys are read only from these variables, and only the one for the selected provider is needed. They are never written to configuration, cache, logs, notifications, process arguments, or the environment of the player or the recorder.
3. **Player.** Any local player that can play MP3 and accepts a file path. The default is `ffplay` from ffmpeg; `mpv` should work with `"command": "mpv"` and `"args": ["--no-config", "--no-video", "--really-quiet", "{file}"]`. The player is started without a shell, and `player.args` must contain `{file}` exactly once.
4. **Recording tool** (only for voice input; see [Voice input](#voice-input)). Install `rec` (SoX), `arecord` (ALSA), or `ffmpeg`.
5. **Configuration.** Create `~/.config/pi-speak/config.json` (or `$XDG_CONFIG_HOME/pi-speak/config.json`). This complete example shows the shape. The voices are the placeholder `SET_YOUR_AUTHORIZED_VOICE_ID`, which is refused until you replace it with a voice you are authorized to use; the translation provider and model are illustrative choices, not defaults:

   ```json
   {
     "provider": "elevenlabs",
     "providers": {
       "elevenlabs": {
         "voiceId": "SET_YOUR_AUTHORIZED_VOICE_ID",
         "modelId": "eleven_flash_v2_5",
         "outputFormat": "mp3_44100_128",
         "voiceRevision": 1,
         "sttModel": "scribe_v2"
       },
       "deepgram": {
         "voice": "SET_YOUR_AUTHORIZED_VOICE_ID",
         "sttModel": "nova-3"
       }
     },
     "input": {
       "provider": "deepgram",
       "language": "vi",
       "maxSeconds": 120,
       "shortcut": "alt+t",
       "transcribeShortcut": "alt+shift+t",
       "sendWhenBusy": "interrupt"
     },
     "locale": "vi",
     "translation": {
       "provider": "YOUR_SELECTED_PI_PROVIDER",
       "model": "YOUR_SELECTED_PI_MODEL",
       "thinking": "medium"
     },
     "hardLimitChars": 10000,
     "requestTimeoutMs": 45000,
     "player": {
       "command": "ffplay",
       "args": ["-nodisp", "-autoexit", "-loglevel", "quiet", "{file}"]
     },
     "cache": { "maxBytes": 104857600, "ttlDays": 7 }
   }
   ```

   **What is required.** Only the selected provider's voice settings are needed: `providers.elevenlabs.voiceId` and `modelId`, or `providers.deepgram.voice` (an Aura voice whose last segment is its language, such as `aura-2-thalia-en`). Everything else has a default, and `translation` is unconfigured by default.

   **Defaults.** `provider` is `elevenlabs`. The ElevenLabs `outputFormat` is `mp3_44100_128`, `voiceRevision` is `1`, and `sttModel` is `scribe_v2`; the Deepgram `sttModel` is `nova-3`. `input.provider` is `deepgram`, `input.maxSeconds` is `120` (range 1–300), `input.shortcut` (the key that sends) is `alt+t`, `input.transcribeShortcut` (the key that only transcribes) is `alt+shift+t`, `input.sendWhenBusy` is `interrupt` (or `wait`), and `input.language` is unset, so the provider detects the language. The two shortcuts must differ. `locale` is `vi`, `hardLimitChars` is `10000` (it may lower, never raise, a provider's limit), `requestTimeoutMs` is `45000`, and the player and cache are as shown. Unknown keys are rejected, so a pasted secret is refused rather than stored.

   **Voice revision.** Raise `providers.elevenlabs.voiceRevision` whenever you change or re-clone the voice behind the same ID, so older cached clips are not reused.

   **Translation is optional.** Without a `translation` block, `/speak original`, `/speak text`, and replay work; bare `/speak` (which translates to `locale`) needs it. Choose a model that Pi already authenticates: select it in Pi's model picker, then put its provider and model in `translation`. Authenticate through Pi, never this file. Choosing a translation model accepts its separate inference cost and that the cleaned answer is sent to it. The optional `translation.thinking` accepts `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; it affects only the isolated translation request and its cache identity, never Pi's coding model. Omit it to keep the host default. `locale` and `input.language` accept canonical BCP-47 tags such as `vi`, `vi-VN`, or `en`; a valid tag does not prove that a model or voice supports the language.

   **Hand migration:** the old flat keys `voiceId`, `modelId`, `outputFormat`, and `voiceRevision` are rejected. Move them to `providers.elevenlabs.voiceId`, `providers.elevenlabs.modelId`, `providers.elevenlabs.outputFormat`, and `providers.elevenlabs.voiceRevision`. The file is never rewritten automatically.

6. **Load the extension:**

   ```bash
   pi -e /absolute/path/to/pi-toolset/extensions/speak/index.ts
   ```

Invalid configuration is reported when you use `/speak`, `/speak status`, or voice input, and does not stop Pi from starting. Loading reads the configuration file once, only to learn the two shortcuts.

## Commands

`/<name>` may refer to either a registered command or a loaded skill, depending on the active toolset.

| Command | Action |
| --- | --- |
| `/speak` | Clean and translate the latest completed answer to `locale`, then speak it. |
| `/speak original` | Speak the latest completed answer without translation. |
| `/speak in <tag>` | Speak the latest completed answer in the locale `<tag>`, for this command only. |
| `/speak text <text>` | Speak exactly the supplied text. |
| `/speak stop` | Stop this extension's generation or playback. |
| `/speak replay` | Replay the last cached clip; it never regenerates. |
| `/speak status` | Show redacted settings, key presence, job state, and cache size. It makes no provider request. |
| `/speak quota` | Perform the read-only ElevenLabs account quota lookup. It is not speech. |
| `/speak provider [elevenlabs\|deepgram\|reset]` | Report or select the speech provider for this session. |
| `/speak locale [<tag>\|reset]` | Report or set the speech locale for this session (`reset` returns to `locale` in the file). |
| `/speak help` or `/speak ?` | Show the combined help. |
| `/talk` | Start recording; run it again to stop and transcribe only. Nothing is sent. Same as `alt+shift+t`. |
| `/talk send` | Start recording; run it again to stop, transcribe, and **send** the composer. Same as `alt+t`. |
| `/talk provider [deepgram\|elevenlabs\|reset]` | Report or select the voice-input provider for this session. |
| `/talk help` or `/talk ?` | Show the same combined help as `/speak help`. |
| `alt+t` (`input.shortcut`) | Push-to-talk that sends: the same as `/talk send`. |
| `alt+shift+t` (`input.transcribeShortcut`) | Push-to-talk that only transcribes: the same as `/talk`. |

Provider and locale commands never write the configuration file. A selection stays in force across session switching, forking, and tree navigation, and ends on restart, reload, or `reset`, which returns to the value in the file. A running speech job or recording keeps the provider and locale captured when it started. Speech and voice input work only in the interactive terminal.

**Help.** `/speak help`, `/talk help`, and `?` in place of `help` print the same text: every form above, the two shortcuts registered at load and which one sends, what `Esc` does, and the effective speech locale. Any unknown argument to `/speak` or `/talk` prints it too. It reads the configuration file (for the locale) but makes no request and works in every run mode; a shortcut you edited but have not reloaded is not shown, and if the file has an error, it still shows the registered shortcuts and says so.

**Speech locale.** The locale used for a `/speak` is, in order, the tag in `/speak in <tag>`, the session locale from `/speak locale <tag>`, then `locale` in the file (default `vi`). Tags are checked and canonicalized (`en-us` becomes `en-US`); a malformed tag changes nothing and makes no request. The same locale drives the Deepgram voice-language check, the translation, and the translation and audio cache keys. `/speak original` and `/speak text` never translate.

## Voice input

Dictate a prompt: press a shortcut, speak, press a shortcut again. **The key that stops the recording decides what happens.** `alt+t` (or `/talk send`) transcribes and then sends the whole composer, your draft plus the transcript, as one ordinary message, as if you had pressed Enter. `alt+shift+t` (or `/talk`) only appends the transcript to the composer, so you review the text and send it yourself.

> **Warning: the default `alt+t` now sends.** A misheard phrase reaches the agent without review, and with the default `input.sendWhenBusy` of `interrupt` it can redirect a turn that is already running. Use `alt+shift+t` or `/talk` to review first, or set `input.sendWhenBusy` to `wait`.

**Setup.** Install one of `rec`, `arecord`, or `ffmpeg` (tried in that order; `ffmpeg` records from PulseAudio's default source). Export the key for the input provider (`DEEPGRAM_API_KEY` for `deepgram`, `ELEVENLABS_API_KEY` for `elevenlabs`). The optional `input` block selects the provider, a language, the length cap (default 120 seconds, at most 300), the two shortcuts, and `sendWhenBusy` as shown above. `input.language` is independent of the speech `locale`; omit it and the provider detects the language. If you only dictate, you may leave out `providers.elevenlabs.voiceId`; a placeholder left in it is still refused. Changed shortcuts take effect after `/reload`. `/speak status` shows the recording tool it found, key presence, and the effective input provider, model, and language.

**Controls.** Either shortcut, `/talk`, or `/talk send` starts a recording; starting carries no decision.

| Key | State | Action |
| --- | --- | --- |
| `alt+t`, `alt+shift+t`, `/talk`, or `/talk send` | idle | Start recording. This first stops this extension's own speech so the microphone does not capture it. |
| `alt+t`, `alt+shift+t`, `/talk`, or `/talk send` | starting (waiting for this extension's speech to stop) | Cancel the attempt. Nothing is recorded or sent. |
| `Esc` | starting | Cancel the attempt. Nothing is recorded or sent, and the editor does not receive the key. |
| `alt+t` or `/talk send` | recording | Stop, transcribe, and send. A recording shorter than 0.5 seconds is discarded with a message. |
| `alt+shift+t` or `/talk` | recording | Stop and transcribe only; the text is added to the composer. |
| `alt+t` or `/talk send` | held at the time cap | Transcribe the held recording and send. |
| `alt+shift+t` or `/talk` | held at the time cap | Transcribe the held recording and add the text to the composer only. |
| `Esc` | recording or held | Discard the audio. Nothing is sent, and the editor does not receive the key. |
| any push-to-talk key | transcribing | Refused with a message; one recording or transcription is active at a time. |

While recording, a status line shows the elapsed time, a coarse input level, and both stop keys (which one sends); a flat level means the microphone may be muted or the wrong input. At `input.maxSeconds` the recorder stops and the audio is **held, unsent**: the status line names the send, transcribe-only, and discard keys, and nothing leaves the machine until you press one of the first two. Session switching, forking, tree navigation, reload, and shutdown also discard a recording or held audio. While a recording is starting, in progress, or held, `/speak` refuses to start new audio. Only `Esc` is intercepted, and only in those states; every other key, including Enter, reaches the editor as usual.

**What sending does.** The transcript is appended to the composer, and then the whole composer is sent as plain text: a slash command, prompt template, or skill command in it is **not** run, it is sent as words. If no model is selected, or Pi is compacting the conversation, nothing is sent: your draft and the transcript stay in the composer and a message says why (during compaction, press Enter to queue the message). The composer is cleared only after Pi accepts the send call; if the call itself fails, the text stays and the error is shown. A refusal Pi reports only after accepting the call, such as missing model credentials, is shown by Pi as an error after the composer was cleared. An empty or dropped transcript sends nothing. When the agent is already working, `input.sendWhenBusy` decides: `interrupt` (default) delivers the message to the running turn at once, `wait` queues it until the turn ends. The setting is read when the message is sent. There are no spoken commands, no open microphone, and no automatic send at the time cap.

**Provider and language are fixed when a recording starts.** `/talk provider ...` or a configuration edit made mid-recording applies to the next recording only.

**Privacy.** Audio is kept in memory, never written to disk, logged, or cached, and released when the request ends or the recording is discarded. A recording you send (by stopping it, or by sending one held at the time cap) goes as one upload to the fixed production endpoint of the selected provider, with no redirects, retries, or fallback to the other provider. Neither Deepgram's nor ElevenLabs' standard tier is a zero-retention guarantee, and sent audio cannot be recalled. A recording you discard, or one held at the time cap and not sent, never leaves the machine. The transcript exists only in the composer or in the message you chose to send. Transcription is billed per audio second; after a timeout it is unknown whether the attempt was billed. The recorder runs without either API key in its environment, but it inherits audio variables such as `PULSE_SERVER`, so audio routing is your setting.

## Provider behavior and limits

ElevenLabs uses the configured voice, model, and output format. Deepgram uses `/v1/speak` with the configured Aura voice and MP3. Deepgram accepts at most 2,000 characters per request; ElevenLabs accepts at most 10,000, or a lower configured `hardLimitChars`. Text is refused rather than truncated, split, retried, or sent to another provider.

For localized `/speak`, a Deepgram Aura voice speaks only its own language. The language is the final segment of the voice ID: `aura-2-thalia-en` is `en`. It must match the primary language of the canonical locale. Use `/speak original` or another provider when it does not. `/speak original` and `/speak text` are not language-checked.

## Translation, progress, and cache

Localized speech sends only the cleaned answer to the configured, isolated translation model. Reasoning and tool content are never spoken. Translation has one bounded request, no retry, and no original-language fallback. A failure identifies the observed validation or provider evidence and says that no text was sent to the selected speech provider.

A temporary line shows `Preparing`, `Translating`, `ElevenLabs` or `Deepgram`, and `Playing` only for phases actually entered. It clears on completion, refusal, failure, stop, and session cleanup without changing Pi's native working indicator.

Generated clips are stored under `$XDG_CACHE_HOME/pi-speak` (or `~/.cache/pi-speak`) with owner-only permissions. Cache keys include the final text, provider, voice, model, format, voice revision, normalizer, and locale. Changing provider never reuses the other provider's clip. Replay uses only the existing clip and keeps only its player and cache checks.

## Privacy and cost

Prepared text is sent to the selected speech provider on every audio-cache miss. Neither ElevenLabs' nor Deepgram's standard tier is a zero-retention guarantee. Translation may also be separately billed. After a timeout it is unknown whether an attempt was billed; there are no automatic retries or fallbacks. Cached audio can be sensitive even with private file permissions.

Each recording you send goes to the selected voice-input provider; see [Voice input](#voice-input).

The provider keys remain in the Pi process environment. Same-user processes and other Pi extensions run with Pi's permissions and may read that environment, this configuration, or the cache. Do not speak credentials or confidential text.

## Not in this version

`/speak summary`, confirmation prompts, secret-pattern blocking, cache clearing, and local usage accounting are not available. Voice input has no silence detection, no streaming partial text, no spoken commands, and no open microphone.

## Development

```bash
npm run check
```

Tests use mocked HTTP and player processes; they need no key, network, or audio device.
