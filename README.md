# Speak

Hear a Pi answer in a configurable language (default `vi`), or speak text you type, through the selected speech provider. Dictate a prompt by push-to-talk: one key sends it to the agent as soon as it is transcribed, and a second key only adds the text to the composer for you to review. **The default key `alt+t` now sends; use `alt+shift+t` to review first.** Two more keys turn a spoken command or skill name into text in the editor (`alt+m`, `alt+i`), and an optional setting lets you hold Space to dictate. `/talk live` opens a hands-free voice conversation with ElevenLabs: each pause in your speech is sent to Pi as a message, and Pi answers aloud in your voice. Nothing is translated, spoken, recorded, or sent anywhere unless you run `/speak`, run `/talk`, run `/talk live`, press a push-to-talk shortcut, or, with `input.holdSpace` on, hold Space; while live mode is on, Pi also speaks what it passes to its `speak_aloud` tool. Loading, reloading, prompts, tools, and agent completion are silent.

`pi-speak` is a standalone Pi extension by ZenStudioLab. It is also included in [pi-toolset](https://github.com/ZenStudioLab/pi-toolset) as a submodule at `extensions/speak`. It is not published to npm: load it explicitly with `pi -e`, or install it from git with `pi install git:github.com/ZenStudioLab/pi-speak`. Design records (ADRs 0002–0008) and the OpenSpec changes behind it live in the [pi-toolset repository](https://github.com/ZenStudioLab/pi-toolset/tree/main/docs/adr).

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
       "commandShortcut": "alt+m",
       "skillShortcut": "alt+i",
       "commandAliases": { "model": "/model", "apply loop": "/opsx-apply-loop" },
       "holdSpace": false,
       "sendWhenBusy": "interrupt",
       "stopOnPhrase": false,
       "stopPhrases": ["let's go"],
       "liveIdleMinutes": 5,
       "liveListenWhileSpeaking": false,
       "liveStopPhrases": ["Dừng cuộc hội thoại", "Stop the conversation"]
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

   **Defaults.** `provider` is `elevenlabs`. The ElevenLabs `outputFormat` is `mp3_44100_128`, `voiceRevision` is `1`, and `sttModel` is `scribe_v2`; the Deepgram `sttModel` is `nova-3`. `input.provider` is `deepgram`, `input.maxSeconds` is `120` (range 1–300), `input.shortcut` (the key that sends) is `alt+t`, `input.transcribeShortcut` (the key that only transcribes) is `alt+shift+t`, `input.commandShortcut` is `alt+m`, `input.skillShortcut` is `alt+i`, `input.commandAliases` is empty (see [Voice commands and skills](#voice-commands-and-skills)), `input.holdSpace` is `false` (see [Hold Space to talk](#hold-space-to-talk)), `input.sendWhenBusy` is `interrupt` (or `wait`), `input.stopOnPhrase` is `false` and `input.stopPhrases` is `["let's go"]` (see [Spoken stop phrase](#spoken-stop-phrase)), `input.liveIdleMinutes` is `5` (range 1–60) and `input.liveListenWhileSpeaking` is `false`, and `input.liveStopPhrases` is `["Dừng cuộc hội thoại", "Stop the conversation"]` (`[]` turns it off; see [Live conversation](#live-conversation)), and `input.language` is unset, so the provider detects the language. Each shortcut setting also accepts a list of 1 to 4 keys (see [Extra shortcut keys](#extra-shortcut-keys)), and no key may appear twice across all four shortcut settings, ignoring case. `locale` is `vi`, `hardLimitChars` is `10000` (it may lower, never raise, a provider's limit), `requestTimeoutMs` is `45000`, and the player and cache are as shown. Unknown keys are rejected, so a pasted secret is refused rather than stored.

   **Voice revision.** Raise `providers.elevenlabs.voiceRevision` whenever you change or re-clone the voice behind the same ID, so older cached clips are not reused.

   **Translation is optional.** Without a `translation` block, `/speak original`, `/speak text`, and replay work; bare `/speak` (which translates to `locale`) needs it. Choose a model that Pi already authenticates: select it in Pi's model picker, then put its provider and model in `translation`. Authenticate through Pi, never this file. Choosing a translation model accepts its separate inference cost and that the cleaned answer is sent to it. The optional `translation.thinking` accepts `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; it affects only the isolated translation request and its cache identity, never Pi's coding model. Omit it to keep the host default. `locale` and `input.language` accept canonical BCP-47 tags such as `vi`, `vi-VN`, or `en`; a valid tag does not prove that a model or voice supports the language.

   **Hand migration:** the old flat keys `voiceId`, `modelId`, `outputFormat`, and `voiceRevision` are rejected. Move them to `providers.elevenlabs.voiceId`, `providers.elevenlabs.modelId`, `providers.elevenlabs.outputFormat`, and `providers.elevenlabs.voiceRevision`. The file is never rewritten automatically.

6. **Load the extension:**

   ```bash
   pi -e /absolute/path/to/pi-speak/index.ts
   ```

Invalid configuration is reported when you use `/speak`, `/speak status`, or voice input, and does not stop Pi from starting. Loading reads the configuration file once, only to learn the shortcuts.

## Commands

`/<name>` may refer to either a registered command or a loaded skill, depending on the active toolset.

| Command | Action |
| --- | --- |
| `/speak` | Clean and translate the latest completed answer to `locale`, then speak it. |
| `/speak original` | Speak the latest completed answer without translation. |
| `/speak in <tag>` | Speak the latest completed answer in the locale `<tag>`, for this command only. |
| `/speak text <text>` | Speak exactly the supplied text. |
| `/speak stop` | Stop this extension's generation or playback. In live mode it also drops the live updates still waiting. |
| `/speak replay` | Replay the last cached clip; it never regenerates. |
| `/speak status` | Show redacted settings, key presence, job state, and cache size. It makes no provider request. |
| `/speak quota` | Perform the read-only ElevenLabs account quota lookup. It is not speech. |
| `/speak provider [elevenlabs\|deepgram\|reset]` | Report or select the speech provider for this session. |
| `/speak locale [<tag>\|reset]` | Report or set the speech locale for this session (`reset` returns to `locale` in the file). |
| `/speak help` or `/speak ?` | Show the combined help. |
| `/talk` | Start recording; run it again to stop and transcribe only. Nothing is sent. Same as `alt+shift+t`. |
| `/talk send` | Start recording; run it again to stop, transcribe, and **send** the composer. Same as `alt+t`. |
| `/talk live` | Start live mode, or end it. See [Live conversation](#live-conversation). |
| `/talk provider [deepgram\|elevenlabs\|reset]` | Report or select the voice-input provider for this session. |
| `/talk help` or `/talk ?` | Show the same combined help as `/speak help`. |
| `/talk command` | Start recording; run it again to stop and put the spoken command into the editor. Nothing runs. Same as `alt+m`. |
| `/talk skill` | Start recording; run it again to stop and put the spoken skill into the editor. Nothing runs. Same as `alt+i`. |
| `alt+t` (`input.shortcut`, one key or a list) | Push-to-talk that sends: the same as `/talk send`. While live mode is on it cuts Pi off instead. |
| `alt+shift+t` (`input.transcribeShortcut`, one key or a list) | Push-to-talk that only transcribes: the same as `/talk`. |
| `alt+m` (`input.commandShortcut`, one key or a list) | Push-to-talk for a spoken command: the same as `/talk command`. |
| `alt+i` (`input.skillShortcut`, one key or a list) | Push-to-talk for a spoken skill: the same as `/talk skill`. |
| Space, held (`input.holdSpace`, off by default) | Hold to record, let go to send. See [Hold Space to talk](#hold-space-to-talk). |

Provider and locale commands never write the configuration file. A selection stays in force across session switching, forking, and tree navigation, and ends on restart, reload, or `reset`, which returns to the value in the file. A running speech job or recording keeps the provider and locale captured when it started. Speech and voice input work only in the interactive terminal.

**Help.** `/speak help`, `/talk help`, and `?` in place of `help` print the same text: every form above, every shortcut key registered at load and which keys send, Space when `input.holdSpace` is on, what a spoken command does with the editor and the draft, what `Esc` does, and the effective speech locale. Any unknown argument to `/speak` or `/talk` prints it too. It reads the configuration file (for the locale) but makes no request and works in every run mode; a shortcut you edited but have not reloaded is not shown, and if the file has an error, it still shows the registered shortcuts and says so.

**Speech locale.** The locale used for a `/speak` is, in order, the tag in `/speak in <tag>`, the session locale from `/speak locale <tag>`, then `locale` in the file (default `vi`). Tags are checked and canonicalized (`en-us` becomes `en-US`); a malformed tag changes nothing and makes no request. The same locale drives the Deepgram voice-language check, the translation, and the translation and audio cache keys. `/speak original` and `/speak text` never translate.

## Voice input

Dictate a prompt: press a shortcut, speak, press a shortcut again. **The key that stops the recording decides what happens.** `alt+t` (or `/talk send`) transcribes and then sends the whole composer, your draft plus the transcript, as one ordinary message, as if you had pressed Enter. `alt+shift+t` (or `/talk`) only appends the transcript to the composer, so you review the text and send it yourself.

> **Warning: the default `alt+t` now sends.** A misheard phrase reaches the agent without review, and with the default `input.sendWhenBusy` of `interrupt` it can redirect a turn that is already running. Use `alt+shift+t` or `/talk` to review first, or set `input.sendWhenBusy` to `wait`.

**Setup.** Install one of `rec`, `arecord`, or `ffmpeg` (tried in that order; `ffmpeg` records from PulseAudio's default source). Export the key for the input provider (`DEEPGRAM_API_KEY` for `deepgram`, `ELEVENLABS_API_KEY` for `elevenlabs`). The optional `input` block selects the provider, a language, the length cap (default 120 seconds, at most 300), the four shortcuts, the command aliases, `holdSpace`, and `sendWhenBusy` as shown above. `input.language` is independent of the speech `locale`; omit it and the provider detects the language. If you only dictate, you may leave out `providers.elevenlabs.voiceId`; a placeholder left in it is still refused. Changed shortcuts take effect after `/reload`. Loading reads the configuration once for the shortcuts; if it cannot be read, only the four defaults are registered. `/speak status` shows the recording tool it found, key presence, and the effective input provider, model, and language.

**Extra shortcut keys.** `input.shortcut`, `input.transcribeShortcut`, `input.commandShortcut`, and `input.skillShortcut` each accept one key or a list of 1 to 4 keys, so you can bind more than one key to a mode:

```json
"shortcut": ["alt+t", "alt+y"],
"transcribeShortcut": ["alt+shift+t", "alt+shift+y"]
```

Every listed key works like the first: the `shortcut` keys send, the `transcribeShortcut` keys only transcribe, the `commandShortcut` keys fill in a command, the `skillShortcut` keys fill in a skill, and any key can start a recording. A key repeated anywhere across the four settings, ignoring case, is a configuration error, and then only the four defaults are registered. Help and the recording status lines name every key of each mode, for example `alt+t / alt+y`. Note that `alt+y` is Pi's editor yank-pop (paste an earlier deleted text after `Ctrl+Y`); binding it here replaces yank-pop, and Pi shows a shortcut conflict notice at startup. The defaults `alt+t` and `alt+shift+t` have no such conflict.

**Controls.** Either shortcut, `/talk`, or `/talk send` starts a recording; starting carries no decision.

| Key | State | Action |
| --- | --- | --- |
| `alt+t`, `alt+shift+t`, `alt+m`, `alt+i`, `/talk`, `/talk send`, `/talk command`, or `/talk skill` | idle | Start recording. This first stops this extension's own speech so the microphone does not capture it. |
| `alt+t`, `alt+shift+t`, `alt+m`, `alt+i`, `/talk`, `/talk send`, `/talk command`, or `/talk skill` | starting (waiting for this extension's speech to stop) | Cancel the attempt. Nothing is recorded or sent. |
| `Esc` | starting | Cancel the attempt. Nothing is recorded or sent, and the editor does not receive the key. |
| `alt+t` or `/talk send` | recording | Stop, transcribe, and send. A recording shorter than 0.5 seconds is discarded with a message. |
| `alt+shift+t` or `/talk` | recording | Stop and transcribe only; the text is added to the composer. |
| `alt+m` or `/talk command` | recording | Stop, transcribe, and put the spoken command into the editor. Nothing is sent. |
| `alt+i` or `/talk skill` | recording | Stop, transcribe, and put the spoken skill into the editor. Nothing is sent. |
| `alt+t` or `/talk send` | held at the time cap | Transcribe the held recording and send. |
| `alt+shift+t` or `/talk` | held at the time cap | Transcribe the held recording and add the text to the composer only. |
| `alt+m` or `/talk command`, `alt+i` or `/talk skill` | held at the time cap | Transcribe the held recording and put the spoken command, or skill, into the editor. |
| `Esc` | recording or held | Discard the audio. Nothing is sent, and the editor does not receive the key. |
| any push-to-talk key | transcribing | Refused with a message; one recording or transcription is active at a time. |

While recording, a status line shows the elapsed time, a coarse input level, and the stop keys of each mode (which ones send); a flat level means the microphone may be muted or the wrong input. At `input.maxSeconds` the recorder stops and the audio is **held, unsent**: the status line names the send, transcribe-only, command, skill, and discard keys, and nothing leaves the machine until you press one of the first four. Session switching, forking, tree navigation, reload, and shutdown also discard a recording or held audio. While a recording is starting, in progress, or held, `/speak` refuses to start new audio. Only `Esc` is intercepted, and only in those states; every other key, including Enter, reaches the editor as usual.

**What sending does.** The transcript is appended to the composer, and then the whole composer is sent as plain text: a slash command, prompt template, or skill command in it is **not** run, it is sent as words. If no model is selected, or Pi is compacting the conversation, nothing is sent: your draft and the transcript stay in the composer and a message says why (during compaction, press Enter to queue the message). The composer is cleared only after Pi accepts the send call; if the call itself fails, the text stays and the error is shown. A refusal Pi reports only after accepting the call, such as missing model credentials, is shown by Pi as an error after the composer was cleared. An empty or dropped transcript sends nothing. When the agent is already working, `input.sendWhenBusy` decides: `interrupt` (default) delivers the message to the running turn at once, `wait` queues it until the turn ends. The setting is read when the message is sent. Unless you turn on the [spoken stop phrase](#spoken-stop-phrase), the microphone is never open without you starting a recording, and nothing is ever sent automatically at the time cap. A spoken command or skill never sends anything either (see [Voice commands and skills](#voice-commands-and-skills)).

**Spoken stop phrase.** See [below](#spoken-stop-phrase).

**Provider and language are fixed when a recording starts.** `/talk provider ...` or a configuration edit made mid-recording applies to the next recording only.

**Privacy.** Audio is kept in memory, never written to disk, logged, or cached, and released when the request ends or the recording is discarded. A recording you send (by stopping it, by releasing one held at the time cap, or by letting go of a Space hold) goes as one upload to the fixed production endpoint of the selected provider, with no redirects, retries, or fallback to the other provider. Neither Deepgram's nor ElevenLabs' standard tier is a zero-retention guarantee, and sent audio cannot be recalled. While the stop phrase is off, a recording you discard, or one held at the time cap and not sent, never leaves the machine; with it on, audio is streamed as you speak (see below). The transcript exists only in the composer or in the message you chose to send. Transcription is billed per audio second; after a timeout it is unknown whether the attempt was billed. The recorder runs without either API key in its environment, but it inherits audio variables such as `PULSE_SERVER`, so audio routing is your setting.

### Voice commands and skills

`alt+m` (or `/talk command`) and `alt+i` (or `/talk skill`) start a recording like the other keys. Press the same key again to stop: the words are transcribed exactly as with the transcribe-only key, then matched against Pi's commands (`alt+m`: extension commands and prompt templates) or Pi's skills (`alt+i`). **The result goes into the editor and nothing runs.** You look at it and press Enter, and Pi runs it exactly as if you had typed it.

**What lands in the editor.** The matched name becomes `/<name>` (or `/skill:<name>`) at the start of the editor, followed by the words you said after the name, and then by the draft that was already there. So **the draft becomes part of the command's arguments**. For example, with "fix the login bug" in the editor, saying "op sx apply loop, add speak voice input." and pressing `alt+m` leaves `/opsx-apply-loop add speak voice input fix the login bug`.

**How names are matched.** Case, punctuation, spaces, hyphens, and colons are ignored, and Vietnamese letters match whether they arrive precomposed or with separate accent marks, so "op sx apply loop" finds `opsx-apply-loop`. The longest name that your first words (up to eight) spell wins. Duplicates that Pi lists as `name:2` match "name 2". An alias beats a name of the same spelling. Punctuation at the start or end of the arguments is dropped, so a full stop, question mark, or ellipsis after the last word does not appear.

**Words in another order.** Only when no name matches in order, the same runs of first words (longest first, up to eight) are compared with each name's words regardless of order, so "LLM online interactive" finds `online-llm-interactive`. Repeats count ("go go stop" is not "stop go"), an alias still beats a name, and two names made of the same words are ambiguous. A name that matches in order always wins over one that matches only in another order. A word you say in parts, such as "op sx" for `opsx`, matches only in order. Only exact words are compared: nothing is guessed, and there is no fuzzy matching.

**When nothing is matched.** If no name matches, or two different names match equally, the words are added to the editor unchanged, as with the transcribe-only key, and a warning says so (it names the competing commands, and never repeats what you said). An empty transcript changes nothing.

**Aliases.** `input.commandAliases` maps a spoken phrase to a target, for names that are hard to say or that transcription mishears, and to reach Pi's own interactive commands:

```json
"commandAliases": {
  "model": "/model",
  "new session": "/new",
  "apply loop": "/opsx-apply-loop"
}
```

A phrase is 1 to 40 characters and at most eight words, and needs at least one letter or digit; two phrases that spell the same once punctuation and spaces are ignored are an error. A target is one line of 2 to 200 characters starting with `/`; a target starting with `/skill:` is a skill alias and is used with `alt+i`, any other target with `alt+m`. There can be at most 50 aliases. A target may carry fixed words, such as `/opsx-apply-loop now`.

**Interactive commands such as `/model` and `/new`.** Pi handles these in its editor screen and does not list them, so only an alias can reach them. Pi recognizes them by the whole editor text, so an alias to one is placed **alone**, and only into an **empty editor** with nothing said after it. With a draft in the editor, or words after the alias, the words are added as dictation instead, with a warning that the command needs an empty editor. An alias to a name Pi does list (such as `/opsx-apply-loop`) behaves like the name itself, with the draft following as arguments.

**Editor only; no streaming.** Nothing is sent and no command is run by the key, whatever you say. A recording started with `alt+m` or `alt+i` is never streamed, even with the stop phrase on, so a spoken stop phrase cannot send it; it is uploaded once when you stop it, and it works with either provider. The mode is decided by the key that stops the recording: starting with `alt+t` and stopping with `alt+i` matches a skill.

### Hold Space to talk

Optionally, hold Space to record and let go to send, as in Claude Code's voice mode. It is off by default and changes nothing when off. Turn it on in the `input` block and run `/reload`:

```json
"input": { "holdSpace": true }
```

**How it feels.** A tap types a space as usual. When you hold Space, your terminal starts repeating it; the fourth Space (about half a second after you press) is recognized as a hold. The Spaces typed so far are removed from the end of the editor text as soon as the recorder runs, and the recording starts as if you had pressed `alt+t`. The status line says "release Space to send". Letting go sends it, exactly as the send key does: the same checks, `input.sendWhenBusy`, and the stop-phrase rules. Your terminal does not report the release, so it is noticed when no Space has arrived for 300 ms. If you let go while the recording is still starting, the attempt is cancelled and nothing is sent.

**Typing another key discards the recording.** Once you press another key, the key repeat of Space stops, so a release could no longer be told from the typing. The key reaches the editor as usual, and the hold's recording is discarded, just as `Esc` discards it; nothing is sent, and with the stop phrase off nothing was uploaded. With the stop phrase on, audio already streamed to ElevenLabs is not recalled. `Esc` and the push-to-talk keys work as usual (the send key during a hold sends it once, and letting go then does nothing). Letting go only ever acts on the recording that hold started.

**When it does nothing.** If a recording, a held recording, or a transcription already exists when the hold is recognized, the hold is busy: Spaces keep typing and nothing starts. If the recording cannot start (a missing key, for instance), the reason is shown once, the typed Spaces stay, and the rest of the hold is ignored.

**Limits.**

- **Key repeat must be on and faster than 120 ms** in your desktop settings, or a hold is never recognized. Terminals that encode repeated Spaces differently, and input methods that commit text together with a Space, do not count as a hold.
- **Focus loss counts as letting go.** If the window loses focus while you hold Space, the repeats stop and the recording is sent.
- **Keys Pi's fullscreen mode takes first.** Pi's default fullscreen mode handles some input before extensions see it: PageUp, PageDown, `ctrl+shift+up`, `ctrl+shift+down`, `ctrl+shift+f`, `ctrl+home`, `ctrl+end`, mouse and focus events, and a right-click paste. During a hold they are not seen as typing, so they end the hold and send the recording instead of discarding it. Starting Pi with `--tui-mode regular` avoids this.
- **Dialogs.** Pi's input listener sees keys while a selector or dialog is open, so holding Space there can start a recording. `Esc` discards it before you let go.
- **The cursor in the middle of the text.** The typed Spaces stay where they are and are sent with the draft.
- **A merge within 300 ms.** On a terminal that reports no release, pressing Space again within 300 ms of letting go continues the same hold.
- **Accidental holds.** Three Spaces typed by hand within 120 ms of each other, or Spaces typed during a pause in Pi (they arrive together), count as a hold: they are removed, `/speak` playback stops, and a recording starts. Letting go within half a second sends nothing, and with the stop phrase off nothing is uploaded either.
- **Streaming.** With the stop phrase on, a hold-started recording streams to ElevenLabs as you speak, so audio from a hold you then abandon may already have left the machine.

### Spoken stop phrase

Optionally, end a dictation by voice: say a phrase such as "let's go" as the last words, pause, and the recording stops and is sent, without the phrase. It is off by default. To turn it on, set two values in the `input` block (`input.stopPhrases` is used only while `input.stopOnPhrase` is `true`):

```json
"input": {
  "provider": "elevenlabs",
  "stopOnPhrase": true,
  "stopPhrases": ["let's go", "send it"]
}
```

`input.stopPhrases` holds 1 to 10 phrases of 1 to 40 characters each (default `["let's go"]`). Choose phrases you do not say in ordinary sentences.

**How detection works.** While you record, the audio streams to ElevenLabs live transcription (model `scribe_v2_realtime`), which settles a stretch of speech after a pause of about 1 second. The phrase counts only when it is the last words of that settled text, ignoring case, punctuation, and apostrophe style, so "let's go through the loader" does not stop the recording. When it matches, the recorder stops, the phrase is removed, and the rest is sent as with the send key: appended to the composer, then sent as one plain message, following `input.sendWhenBusy` and the same pre-send checks (no model, compaction). If nothing remains after the phrase, nothing is sent and the composer is unchanged.

**ElevenLabs only.** It needs `ELEVENLABS_API_KEY` and the input provider ElevenLabs when the recording starts. With Deepgram selected, the press reports that the stop phrase needs ElevenLabs and records nothing; the extension never switches provider for you. `/talk provider elevenlabs` selects it for the session.

**Privacy.** While the stop phrase is on, audio is sent to ElevenLabs as you speak, not after you stop. Escape stops the recording and sends no message, but it cannot recall audio ElevenLabs has already received. This is not a zero-retention guarantee. The streamed audio is not uploaded a second time. `/speak status` and help show whether the stop phrase is on and which phrases count.

**Keys and Escape while streaming.** Either shortcut, `/talk`, or `/talk send` still stops the recording: the extension asks for the last text, waits up to `requestTimeoutMs` for it, and delivers it in that key's mode (send or transcribe only), without removing any phrase. Escape closes the stream at once and sends nothing. At `input.maxSeconds` the recorder stops and the text is held, unsent, until your next key or command; Escape, a session change, or shutdown discards it. A shorter than 0.5 second recording is discarded as usual. Session changes and shutdown close the stream and ignore late messages.

**Failures.** An authentication error, quota or rate limit, size limit, session time limit, any other provider error, a connection that does not open within `requestTimeoutMs`, a final text that does not arrive in time, a recorder that fails while recording, or an unexpected close ends the recording with a sanitized message naming the class. Text already received is added to the composer without sending it. There is no retry, no reconnect, and no fallback to the one-shot upload.

### Live conversation

`/talk live` starts a hands-free conversation: it opens the microphone and keeps it open, and each pause in your speech is sent to Pi as a message, until you run `/talk live` again. Live mode starts only when you run `/talk live`. Loading, reloading, prompts, tools, and agent completion never start it, and it does not survive a reload, a restart, or a session change (new session, fork, tree navigation). It works only in the interactive terminal.

**ElevenLabs in both directions.** Live mode listens with ElevenLabs live transcription (model `scribe_v2_realtime`, the connection the stop phrase uses) and speaks with ElevenLabs in your configured voice, whatever `input.provider`, `provider`, and their session overrides select. Deepgram is not used. The start needs `ELEVENLABS_API_KEY`, a valid configuration (including `providers.elevenlabs.voiceId` and `modelId`), a recording tool, and the audio player; if a check fails the command names the problem and nothing opens. It also refuses to start while a push-to-talk recording, a recording held at the time cap, or a transcription is active, and it stops this extension's own speech before it opens the microphone. The recorder starts only after the connection opens, and a connection that does not open ends the start with a message and no retry. The start message says that live mode uses ElevenLabs, whether the spoken language is detected for each turn or fixed to `input.language`, the key that cuts Pi off, and that `/talk live` ends it.

**How turns are sent.** Each segment ElevenLabs settles after about one second of silence is one turn. A turn with no letter or digit, such as `...`, is dropped without a message. Every other turn, however short ("yes", "ừ"), is sent to Pi as one plain user message, saved in the session like a typed one. Slash commands, prompt templates, and skill commands in it are **not** run, and the push-to-talk stop phrases (`input.stopPhrases`) have no effect; the only spoken command is the live stop phrase below. The composer is never read, changed, or sent: a half-typed draft stays where it is. When the agent is idle the turn starts a run; when it is working, `input.sendWhenBusy`, read when the turn is sent, decides: `interrupt` (default) delivers it to the running turn at once, `wait` queues it until the run ends. If Pi would refuse the message (no model selected, or the conversation is being compacted), or the send call fails, the turn is added to the composer instead, a message says why, and live mode stays on. A pause longer than a second can split one thought into two turns; while Pi is working, the second turn steers the same run.

**Pi speaking.** While live mode is on, the extension gives Pi a `speak_aloud` tool with one `text` parameter. Its description tells Pi that you are talking by voice and that it should speak a short acknowledgement when it starts on a request, brief progress during long work, and a short summary when it finishes, in the language of your latest spoken message, short and speakable (no code blocks, tables, or long paths); the written answer stays the full record. The tool is declared to the model only while live mode is on: it is added when live mode starts and removed when it ends, the other tools are left as they are, and nothing changes the tool set when loading, reloading, or resuming a session without live mode. If a resumed session brings the tool back, it is removed when the next agent run starts with live mode off. The tool returns at once with a result that says the update was queued, or why nothing will be spoken: live mode is off, the text is empty, or it is longer than the speech limit (`hardLimitChars`, capped by ElevenLabs' own limit). The text is spoken exactly as written, never translated or summarized, with ElevenLabs in your configured voice, model, and format, using the same preflight, length limit, cache, player, and progress line as `/speak text`. Updates play in the order they were queued, one at a time; an update that fails shows a message, is not retried, and the next one still plays. Nothing is spoken unless Pi calls the tool: there is no automatic fallback speech.

**Cutting Pi off.** The send key (`alt+t` by default, `input.shortcut`) and `/speak stop` stop the update being synthesized or played, drop every waiting update, and go back to listening. Live mode stays on and the agent is not aborted. When nothing is being spoken, the send key changes nothing and says so.

**Muting.** With `input.liveListenWhileSpeaking` off, silence of the same length replaces the microphone audio from the moment the player starts until half a second after it exits, so Pi's own voice never reaches ElevenLabs while the connection stays open. Listening resumes after that tail. With the setting on, the microphone keeps streaming while Pi speaks, and the first non-empty partial transcript during synthesis or playback cuts Pi off like the key does; what you said is then sent as an ordinary turn once ElevenLabs commits it.

**Ending by voice.** Saying a phrase from `input.liveStopPhrases` ends live mode like `/talk live` does. The defaults are "Dừng cuộc hội thoại" and "Stop the conversation"; `[]` turns the feature off. It matches only when the whole turn is the phrase, word by word, so you say it on its own and pause. Case, punctuation, and accents are ignored, `đ` counts as `d`, and curly apostrophes count as straight ones: "stop the conversation!" and "dung cuoc hoi thoai" both match. A longer sentence that contains the phrase, such as "stop the conversation about tests and look at the loader", is not a match and is sent to Pi as a normal turn. A matched turn is never sent to Pi, added to the composer, or stored; turns said just before it are still sent first, speech after it is dropped, a message says live mode ended because of the stop phrase, and the agent keeps working. While `input.liveListenWhileSpeaking` is off the microphone is muted as Pi speaks, so the phrase is not heard then: cut Pi off with the send key first, or wait until Pi has finished. With the setting on, the phrase cuts Pi off first and then ends live mode. The phrases are read when live mode starts and are separate from the push-to-talk `input.stopPhrases`. A misheard turn that equals a phrase ends live mode early, which is harmless: run `/talk live` to start again.

**While live mode is on.** A status line shows whether the microphone is listening or Pi is speaking, the key that cuts Pi off, that `/talk live` ends it, and the first live stop phrase when one is configured. Push-to-talk is unavailable: the transcribe-only, command, and skill keys, `/talk`, `/talk send`, `/talk command`, and `/talk skill` are refused with a message that names `/talk live` (the send key too while live mode is starting; otherwise the send key is not refused but cuts Pi off), and Space holds are busy, so Spaces keep typing. `/speak`, `/speak original`, `/speak in`, `/speak text`, and `/speak replay` are refused and make no request. `/speak stop` (see Cutting Pi off), `/speak status`, `/speak quota`, `/speak provider`, `/speak locale`, `/talk provider`, and help keep working; a provider change applies to push-to-talk and `/speak` after live mode ends. Escape reaches Pi as usual. Running `/talk live` while it is starting cancels the start.

**Ending.** Live mode ends on `/talk live`, on a live stop phrase, on the idle limit, on a provider error or an unexpected close of the connection, when the recorder exits on its own, and on session replacement, fork, tree navigation, reload, and shutdown. Ending stops the recorder, closes the connection, stops the update being synthesized or played, drops the waiting ones, and removes `speak_aloud` from the active tools. Except on shutdown and session changes, a message says why. Nothing retries, reconnects, or falls back to another provider.

**Settings.** All three live in the `input` block and are checked when you run `/talk live`; an invalid value is a configuration error and live mode does not start.

| Setting | Default | Meaning |
| --- | --- | --- |
| `input.liveIdleMinutes` | `5` (integer 1–60) | Live mode ends, with a message, after this many minutes in a row in which the agent was idle, no update was synthesized or played, and no turn was sent. Agent work and speech do not count, and the limit is checked every 15 seconds, so it can end up to 15 seconds late. |
| `input.liveListenWhileSpeaking` | `false` | `false` mutes the microphone while Pi speaks. `true` keeps sending audio during playback, so speaking cuts Pi off; it needs headphones or system echo cancellation, because otherwise Pi's own voice can cut it off or be sent as a turn. |
| `input.liveStopPhrases` | `["Dừng cuộc hội thoại", "Stop the conversation"]` | 0 to 10 phrases of 1 to 40 characters, each with at least one letter or digit. A turn that equals one ends live mode (see Ending by voice). `[]` turns it off. |

`/speak status` shows whether live mode is on and the effective `input.liveIdleMinutes` and `input.liveListenWhileSpeaking`.

**Privacy and cost.** While live mode is on, everything the microphone hears, except during muted playback, streams to ElevenLabs. Each turn becomes a user message saved in the session like a typed one. The text Pi chooses to speak is sent to ElevenLabs for synthesis, and its audio is cached like `/speak` clips. This is not a zero-retention guarantee, and ending live mode is the way to stop streaming. The key is read only from the environment and never written to configuration, cache, logs, notifications, process arguments, or the recorder's or player's environment. Microphone audio is neither logged nor stored, transcripts are kept only in the messages sent and the composer fallback above, and warnings never repeat what you said. The connection stays open, and may be billed, for as long as live mode is on, so the idle limit and `/talk live` bound the cost; how ElevenLabs bills live transcription, by connection time or by audio sent, has not been checked, so assume it can be billed for as long as the connection is open. `/speak quota` is the only account view.

## Provider behavior and limits

ElevenLabs uses the configured voice, model, and output format. Deepgram uses `/v1/speak` with the configured Aura voice and MP3. Deepgram accepts at most 2,000 characters per request; ElevenLabs accepts at most 10,000, or a lower configured `hardLimitChars`. Text is refused rather than truncated, split, retried, or sent to another provider.

For localized `/speak`, a Deepgram Aura voice speaks only its own language. The language is the final segment of the voice ID: `aura-2-thalia-en` is `en`. It must match the primary language of the canonical locale. Use `/speak original` or another provider when it does not. `/speak original` and `/speak text` are not language-checked.

## Translation, progress, and cache

Localized speech sends only the cleaned answer to the configured, isolated translation model. Reasoning and tool content are never spoken. Translation has one bounded request, no retry, and no original-language fallback. A failure identifies the observed validation or provider evidence and says that no text was sent to the selected speech provider.

A temporary line shows `Preparing`, `Translating`, `ElevenLabs` or `Deepgram`, and `Playing` only for phases actually entered. It clears on completion, refusal, failure, stop, and session cleanup without changing Pi's native working indicator.

Generated clips are stored under `$XDG_CACHE_HOME/pi-speak` (or `~/.cache/pi-speak`) with owner-only permissions. Cache keys include the final text, provider, voice, model, format, voice revision, normalizer, and locale. Changing provider never reuses the other provider's clip. Replay uses only the existing clip and keeps only its player and cache checks.

## Privacy and cost

Prepared text is sent to the selected speech provider on every audio-cache miss. Neither ElevenLabs' nor Deepgram's standard tier is a zero-retention guarantee. Translation may also be separately billed. After a timeout it is unknown whether an attempt was billed; there are no automatic retries or fallbacks. Cached audio can be sensitive even with private file permissions.

Each recording you send goes to the selected voice-input provider; see [Voice input](#voice-input). In live mode the microphone streams to ElevenLabs for as long as it is on; see [Live conversation](#live-conversation).

The provider keys remain in the Pi process environment. Same-user processes and other Pi extensions run with Pi's permissions and may read that environment, this configuration, or the cache. Do not speak credentials or confidential text.

## Not in this version

`/speak summary`, confirmation prompts, secret-pattern blocking, cache clearing, and local usage accounting are not available. Push-to-talk voice input has no silence detection on this machine, no partial text, and no open microphone; only `/talk live` keeps the microphone open until you end it. A spoken command or skill goes into the editor and never runs by itself, and the only spoken actions are the optional stop phrase and live mode's turns, which work with ElevenLabs only; a live turn is sent as an ordinary message and never runs a command. Outside live mode nothing is spoken unless you run a `/speak` form that speaks; in live mode Pi speaks only what it passes to `speak_aloud`.

## Development

```bash
npm install
npm run check
```

Tests use mocked HTTP and player processes; they need no key, network, or audio device.
