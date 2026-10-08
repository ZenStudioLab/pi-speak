# Speak

Hear a Pi answer in a configurable language (default `vi`), or speak text you type, through the selected speech provider. Dictate a prompt by push-to-talk and find the transcript in the composer, ready for you to review and send. Nothing is translated, spoken, recorded, or sent anywhere unless you run `/speak`, run `/talk`, or press the push-to-talk shortcut. Loading, reloading, prompts, tools, and agent completion are silent.

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
       "maxSeconds": 60,
       "shortcut": "alt+t"
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

   **Defaults.** `provider` is `elevenlabs`. The ElevenLabs `outputFormat` is `mp3_44100_128`, `voiceRevision` is `1`, and `sttModel` is `scribe_v2`; the Deepgram `sttModel` is `nova-3`. `input.provider` is `deepgram`, `input.maxSeconds` is `60` (range 1–300), `input.shortcut` is `alt+t`, and `input.language` is unset, so the provider detects the language. `locale` is `vi`, `hardLimitChars` is `10000` (it may lower, never raise, a provider's limit), `requestTimeoutMs` is `45000`, and the player and cache are as shown. Unknown keys are rejected, so a pasted secret is refused rather than stored.

   **Voice revision.** Raise `providers.elevenlabs.voiceRevision` whenever you change or re-clone the voice behind the same ID, so older cached clips are not reused.

   **Translation is optional.** Without a `translation` block, `/speak original`, `/speak text`, and replay work; bare `/speak` (which translates to `locale`) needs it. Choose a model that Pi already authenticates: select it in Pi's model picker, then put its provider and model in `translation`. Authenticate through Pi, never this file. Choosing a translation model accepts its separate inference cost and that the cleaned answer is sent to it. The optional `translation.thinking` accepts `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; it affects only the isolated translation request and its cache identity, never Pi's coding model. Omit it to keep the host default. `locale` and `input.language` accept canonical BCP-47 tags such as `vi`, `vi-VN`, or `en`; a valid tag does not prove that a model or voice supports the language.

   **Hand migration:** the old flat keys `voiceId`, `modelId`, `outputFormat`, and `voiceRevision` are rejected. Move them to `providers.elevenlabs.voiceId`, `providers.elevenlabs.modelId`, `providers.elevenlabs.outputFormat`, and `providers.elevenlabs.voiceRevision`. The file is never rewritten automatically.

6. **Load the extension:**

   ```bash
   pi -e /absolute/path/to/pi-toolset/extensions/speak/index.ts
   ```

Invalid configuration is reported when you use `/speak`, `/speak status`, or voice input, and does not stop Pi from starting. Loading reads the configuration file once, only to learn the shortcut.

## Commands

`/<name>` may refer to either a registered command or a loaded skill, depending on the active toolset.

| Command | Action |
| --- | --- |
| `/speak` | Clean and translate the latest completed answer to `locale`, then speak it. |
| `/speak original` | Speak the latest completed answer without translation. |
| `/speak text <text>` | Speak exactly the supplied text. |
| `/speak stop` | Stop this extension's generation or playback. |
| `/speak replay` | Replay the last cached clip; it never regenerates. |
| `/speak status` | Show redacted settings, key presence, job state, and cache size. It makes no provider request. |
| `/speak quota` | Perform the read-only ElevenLabs account quota lookup. It is not speech. |
| `/speak provider [elevenlabs\|deepgram\|reset]` | Select the speech provider for this session. |
| `/talk` | Start recording; run it again to stop and transcribe; or transcribe a recording held at the time cap. Same as the shortcut. |
| `/talk provider [deepgram\|elevenlabs\|reset]` | Report or select the voice-input provider for this session. |
| `alt+t` (`input.shortcut`) | Push-to-talk, the same as `/talk` with no argument. |

Provider commands never write the configuration file. A selection stays in force across session switching, forking, and tree navigation, and ends on restart, reload, or `reset`, which returns to the provider in the file. A running speech job or recording keeps the provider captured when it started. Speech and voice input work only in the interactive terminal.

## Voice input

Dictate a prompt: press the shortcut, speak, press it again, and the transcript is appended to the composer. The extension never submits the composer, replaces its text, or runs anything you said; you review the text and send it yourself.

**Setup.** Install one of `rec`, `arecord`, or `ffmpeg` (tried in that order; `ffmpeg` records from PulseAudio's default source). Export the key for the input provider (`DEEPGRAM_API_KEY` for `deepgram`, `ELEVENLABS_API_KEY` for `elevenlabs`). The optional `input` block selects the provider, a language, the length cap, and the shortcut as shown above. `input.language` is independent of the speech `locale`; omit it and the provider detects the language. A changed `input.shortcut` takes effect after `/reload`. `/speak status` shows the recording tool it found, key presence, and the effective input provider, model, and language.

**Controls.**

| Key | State | Action |
| --- | --- | --- |
| `alt+t` or `/talk` | idle | Start recording. This first stops this extension's own speech so the microphone does not capture it. |
| `alt+t` or `/talk` | recording | Stop and transcribe. A recording shorter than 0.5 seconds is discarded with a message. |
| `alt+t` or `/talk` | held at the time cap | Transcribe the held recording. |
| `Esc` | recording or held | Discard the audio. Nothing is sent, and the editor does not receive the key. |
| `alt+t` or `/talk` | transcribing | Refused with a message; one recording or transcription is active at a time. |

While recording, a status line shows the elapsed time, a coarse input level, and these keys; a flat level means the microphone may be muted or the wrong input. At `input.maxSeconds` the recorder stops and the audio is **held, unsent**: it waits for the next press to transcribe it, or `Esc` to discard it. Session switching, forking, tree navigation, reload, and shutdown also discard a recording or held audio. While a recording is in progress or held, `/speak` refuses to start new audio. Only `Esc` is intercepted, and only while a recording is in progress or held; every other key, including Enter, reaches the editor as usual.

**Provider and language are fixed when a recording starts.** `/talk provider ...` or a configuration edit made mid-recording applies to the next recording only.

**Privacy.** Audio is kept in memory, never written to disk, logged, or cached, and released when the request ends or the recording is discarded. A recording you send (by stopping it, or by sending one held at the time cap) goes as one upload to the fixed production endpoint of the selected provider, with no redirects, retries, or fallback to the other provider. Neither Deepgram's nor ElevenLabs' standard tier is a zero-retention guarantee, and sent audio cannot be recalled. A recording you discard, or one held at the time cap and not sent, never leaves the machine. The transcript exists only in the composer. Transcription is billed per audio second; after a timeout it is unknown whether the attempt was billed. The recorder runs without either API key in its environment, but it inherits audio variables such as `PULSE_SERVER`, so audio routing is your setting.

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
