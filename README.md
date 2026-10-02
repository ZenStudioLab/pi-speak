# Speak

Hear a Pi answer, or text you type, in your own authorized ElevenLabs voice. **Nothing is spoken, summarized, or sent anywhere unless you run `/speak`.** Loading, reloading, prompts, tools, and agent completion are silent.

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

   Only `voiceId` and `modelId` are required. Everything else has the default shown here:

   ```json
   {
     "voiceId": "YOUR_VOICE_ID",
     "modelId": "eleven_flash_v2_5",
     "outputFormat": "mp3_44100_128",
     "voiceRevision": 1,
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

| Command | What it does |
| --- | --- |
| `/speak` | Speak the latest completed assistant answer, after cleanup. |
| `/speak text <text>` | Speak exactly the text you supply. |
| `/speak stop` | Stop this extension's generation or playback. Other audio and the coding agent are untouched. |
| `/speak replay` | Play the last clip again from the cache. Never regenerates. |
| `/speak status` | Show redacted configuration, key presence, job state, and cache size. Makes no request. |

Speech works only in the interactive terminal. In other Pi modes the command says so and does nothing. One speech job runs at a time; a second request is refused rather than queued.

`/speak` needs the agent to be idle. It speaks the final answer of the latest turn on the active branch, only when that answer finished normally; it never falls back to an older answer.

### What is spoken

- **Answers:** code blocks, images, HTML, link addresses, and bare URLs are removed; link labels, inline identifiers, numbers, negations, and qualifications are kept; a table becomes one sentence saying it is in the text response. Nothing is summarized or reinterpreted.
- **`/speak text`:** your wording is sent as typed. Only terminal escape sequences and control characters are removed, and runs of whitespace become one space.
- **Length:** at most 4000 characters (Unicode code points). Longer text is refused with its length; nothing is truncated or split.

## Cache

Generated clips are stored in `$XDG_CACHE_HOME/pi-speak` (default `~/.cache/pi-speak`), in an owner-only directory with owner-only files. File names are hashes of everything that affects the audio (text, voice, model, format, voice revision), so no source text is stored. A repeat of the same request, and `/speak replay`, make no provider request.

Clips are kept for 7 days from their last use and the cache is capped at 100 MiB; the oldest are removed first and a clip that is playing is never removed. To clear the cache by hand, delete that directory.

## Cost, privacy, and limits

- Each cache miss is one billable ElevenLabs request. There are no automatic retries and no fallback to another model, voice, or provider. After a timeout or network failure it is unknown whether the attempt was billed, and cancelling a request is not known to restore any allowance.
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
