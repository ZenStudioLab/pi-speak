import { formatKeys, loadConfig, type Shortcuts } from "./config.ts";
import type { SpeakDeps } from "./speech-job.ts";

/**
 * The help shown by `/speak help`, `/talk help`, and every unknown argument of either command.
 * It names the shortcuts registered at load and reads the local configuration file only for the
 * locale and the error line, so it makes no request and works in every run mode.
 */
export async function buildHelp(
  deps: Pick<SpeakDeps, "env" | "readFile" | "home">,
  sessionLocale: string | undefined,
  { send, transcribe, command, skill, holdSpace }: Shortcuts,
): Promise<string> {
  const loaded = await loadConfig(deps.env, deps.readFile, deps.home);
  let locale: string;
  if (sessionLocale) locale = `${sessionLocale} (session override)`;
  else locale = loaded.ok ? `${loaded.config.locale} (configured)` : "unknown";
  let stopPhrase = "unknown";
  if (loaded.ok) {
    const { stopOnPhrase, stopPhrases } = loaded.config.input;
    stopPhrase = `${stopOnPhrase ? "on" : "off"} (${stopPhrases.map((phrase) => `"${phrase}"`).join(", ")})`;
  }
  const lines = [
    "Speak and voice input",
    "",
    "/speak                 speak the latest answer in the speech locale",
    "/speak original        speak the latest answer without translation",
    "/speak in <tag>        speak the latest answer in <tag>, for this command only",
    "/speak text <text>     speak the supplied text",
    "/speak stop            stop speech started by this extension",
    "/speak replay          replay the last clip without regenerating it",
    "/speak status          show configuration and state",
    "/speak quota           show ElevenLabs account quota and billing figures",
    "/speak provider [elevenlabs|deepgram|reset]  report or select the speech provider for this session",
    "/speak locale [<tag>|reset]  report or set the speech locale for this session",
    "/speak help | ?        show this help",
    "/talk                  start recording; run it again to stop and transcribe only (nothing is sent)",
    "/talk send             start recording; run it again to stop, transcribe, and send the composer",
    "/talk command          start recording; run it again to stop and put the spoken command into the editor (nothing runs)",
    "/talk skill            start recording; run it again to stop and put the spoken skill into the editor (nothing runs)",
    "/talk live             start live mode, or end it: ElevenLabs listens, each pause sends what you said to Pi as a message",
    "/talk provider [deepgram|elevenlabs|reset]  report or select the voice input provider for this session",
    "/talk help | ?         show this help",
    "",
    `${formatKeys(send)} sends: it stops a recording, transcribes it, and sends the composer (same as /talk send).`,
    `${formatKeys(transcribe)} transcribes only: it stops a recording and adds the text to the composer (same as /talk).`,
    `${formatKeys(command)} command: it stops a recording and matches the first words to a Pi command or prompt template (same as /talk command).`,
    `${formatKeys(skill)} skill: it stops a recording and matches the first words to a skill (same as /talk skill).`,
    "Any of these keys or commands starts a recording; the one that stops it decides what happens to the text.",
    "Command and skill keys: the result goes into the editor and nothing runs until you press Enter. The words after the name become the arguments, and your draft follows them as part of the arguments. Pi's own interactive commands, such as /model, need an alias in input.commandAliases and an empty editor. These recordings never stream, even with the stop phrase on.",
    "Escape: while a recording is starting it cancels the attempt; while recording or held at the time cap it discards the audio. Nothing is sent.",
    ...(holdSpace
      ? ["Space (input.holdSpace): hold Space to record and let go to send, as with the send key. Typing another key during a hold discards the recording; Escape does too."]
      : []),
    "Live mode (/talk live): it uses ElevenLabs for listening and for speaking, whatever input.provider and the speech provider say. While it is on, everything the microphone hears streams to ElevenLabs and each pause sends one plain message to Pi (slash commands in it do not run; a draft in the composer is left alone). It ends on /talk live again, on an error, or after input.liveIdleMinutes (default 5) minutes of agent idleness. Push-to-talk keys, Space holds, and the /speak forms that speak are refused while it is on.",
    `Speech locale: ${locale}`,
    `Stop phrase: ${stopPhrase}`,
    "Stop phrase (input.stopOnPhrase, ElevenLabs only): say a phrase from input.stopPhrases as the last words before a pause of about 1 second to stop and send. While on, audio streams to ElevenLabs as you speak; Escape sends nothing but cannot recall audio already sent. A key or /talk still stops the recording and decides whether the text is sent.",
  ];
  if (!loaded.ok)
    lines.push(
      `The configuration has an error (${loaded.problem}); the shortcuts shown are the ones registered at load.`,
    );
  return lines.join("\n");
}
