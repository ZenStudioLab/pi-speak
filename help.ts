import { loadConfig, type Shortcuts } from "./config.ts";
import type { SpeakDeps } from "./speech-job.ts";

/**
 * The help shown by `/speak help`, `/talk help`, and every unknown argument of either command.
 * It names the shortcuts registered at load and reads the local configuration file only for the
 * locale and the error line, so it makes no request and works in every run mode.
 */
export async function buildHelp(
  deps: Pick<SpeakDeps, "env" | "readFile" | "home">,
  sessionLocale: string | undefined,
  { send, transcribe }: Shortcuts,
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
    "/talk provider [deepgram|elevenlabs|reset]  report or select the voice input provider for this session",
    "/talk help | ?         show this help",
    "",
    `${send} sends: it stops a recording, transcribes it, and sends the composer (same as /talk send).`,
    `${transcribe} transcribes only: it stops a recording and adds the text to the composer (same as /talk).`,
    "Either key or command starts a recording; the one that stops it decides whether the message is sent.",
    "Escape: while a recording is starting it cancels the attempt; while recording or held at the time cap it discards the audio. Nothing is sent.",
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
