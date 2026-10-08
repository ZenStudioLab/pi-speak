# Speak

Hear a Pi answer in a configurable language (default `vi`), or speak text you type, through the selected speech provider. Nothing is translated, spoken, or sent anywhere unless you run `/speak`. Loading, reloading, prompts, tools, and agent completion are silent.

This extension is local to this repository. It is loaded explicitly with `pi -e` and is not part of the published package.

## Setup

1. Export the key for the provider you intend to use. Keys are read only from the environment and are never written to configuration, cache, logs, notifications, process arguments, or the player's environment.

   ```bash
   export ELEVENLABS_API_KEY="..."
   export DEEPGRAM_API_KEY="..."
   ```

2. Install a local MP3 player. The default is `ffplay` from ffmpeg. The configured player is started without a shell.
3. Create `~/.config/pi-speak/config.json` (or the equivalent `$XDG_CONFIG_HOME` path). This complete example shows the configuration shape and defaults:

   ```json
   {
     "provider": "elevenlabs",
     "providers": {
       "elevenlabs": {
         "voiceId": "YOUR_VOICE_ID",
         "modelId": "eleven_flash_v2_5",
         "outputFormat": "mp3_44100_128",
         "voiceRevision": 1,
         "sttModel": "scribe_v2"
       },
       "deepgram": {
         "voice": "aura-2-thalia-en",
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
       "provider": "openai-codex",
       "model": "gpt-6-luna",
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

   `provider` defaults to `elevenlabs`. The ElevenLabs block contains `voiceId`, `modelId`, `outputFormat`, `voiceRevision`, and `sttModel`; its defaults are `mp3_44100_128`, `1`, and `scribe_v2` for the fields with defaults. The Deepgram block contains `voice` and defaults `sttModel` to `nova-3`. `input.provider` defaults to `deepgram`, `input.maxSeconds` to `60` (range 1–300), and `input.shortcut` to `alt+t`; `input.language` is optional. `hardLimitChars` may lower, but never raise, provider limits.

   **Hand migration:** the old flat keys `voiceId`, `modelId`, `outputFormat`, and `voiceRevision` are rejected. Move them to `providers.elevenlabs.voiceId`, `providers.elevenlabs.modelId`, `providers.elevenlabs.outputFormat`, and `providers.elevenlabs.voiceRevision`. The file is never rewritten automatically.

4. Load the extension:

   ```bash
   pi -e /absolute/path/to/pi-toolset/extensions/speak/index.ts
   ```

Invalid configuration is reported when `/speak` or `/speak status` is used and does not stop Pi from starting.

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
| `/talk provider [deepgram\|elevenlabs\|reset]` | Select the voice-input provider for this session. Recording is not documented or enabled yet. |

Provider commands change only the current session and never write the configuration file. A running speech job keeps the provider captured when it started. `reset` returns to the provider in the file. Speech commands work only in the interactive terminal.

## Provider behavior and limits

ElevenLabs uses the configured voice, model, and output format. Deepgram uses `/v1/speak` with the configured Aura voice and MP3. Deepgram accepts at most 2,000 characters per request; ElevenLabs accepts at most 10,000, or a lower configured `hardLimitChars`. Text is refused rather than truncated, split, retried, or sent to another provider.

For localized `/speak`, a Deepgram Aura voice speaks only its own language. The language is the final segment of the voice ID: `aura-2-thalia-en` is `en`. It must match the primary language of the canonical locale. Use `/speak original` or another provider when it does not. `/speak original` and `/speak text` are not language-checked.

## Translation, progress, and cache

Localized speech sends only the cleaned answer to the configured, isolated translation model. Reasoning and tool content are never spoken. Translation has one bounded request, no retry, and no original-language fallback. A failure identifies the observed validation or provider evidence and says that no text was sent to the selected speech provider.

A temporary line shows `Preparing`, `Translating`, `ElevenLabs` or `Deepgram`, and `Playing` only for phases actually entered. It clears on completion, refusal, failure, stop, and session cleanup without changing Pi's native working indicator.

Generated clips are stored under `$XDG_CACHE_HOME/pi-speak` (or `~/.cache/pi-speak`) with owner-only permissions. Cache keys include the final text, provider, voice, model, format, voice revision, normalizer, and locale. Changing provider never reuses the other provider's clip. Replay uses only the existing clip and keeps only its player and cache checks.

## Privacy and cost

Prepared text is sent to the selected speech provider on every audio-cache miss. Neither ElevenLabs' nor Deepgram's standard tier is a zero-retention guarantee. Translation may also be separately billed. After a timeout it is unknown whether an attempt was billed; there are no automatic retries or fallbacks. Cached audio can be sensitive even with private file permissions.

The provider keys remain in the Pi process environment. Same-user processes and other Pi extensions run with Pi's permissions and may read that environment, this configuration, or the cache. Do not speak credentials or confidential text.

## Not in this version

Voice recording and `/talk` recording controls are intentionally not documented yet. Push-to-talk recording is a later wave. `/speak summary`, confirmation prompts, secret-pattern blocking, cache clearing, and local usage accounting are also not available.

## Development

```bash
npm run check
```

Tests use mocked HTTP and player processes; they need no key, network, or audio device.
