import { afterEach } from "node:test";
import { VALID_CONFIG, createHarness, type FakeChild } from "./harness.ts";

export type Harness = Awaited<ReturnType<typeof createHarness>>;

export const baseConfig = (input: Record<string, unknown> = {}) => ({
  ...VALID_CONFIG,
  providers: {
    elevenlabs: { ...VALID_CONFIG.providers.elevenlabs, sttModel: "scribe_v2" },
    deepgram: { sttModel: "nova-3" },
  },
  input: { provider: "deepgram", language: "vi", ...input },
});

/** Returns a harness factory whose harnesses are cleaned up after each test of the calling file. */
export function useTalkHarness() {
  const open: Harness[] = [];
  afterEach(async () => {
    while (open.length > 0) await open.pop()!.cleanup();
  });
  return async function harness(options: Parameters<typeof createHarness>[0] = {}) {
    const h = await createHarness({
      config: baseConfig(),
      deepgramKey: "deepgram-test-key",
      recorders: ["rec"],
      ...options,
    });
    open.push(h);
    respond(h, "xin chào");
    return h;
  };
}


export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Answers each provider in its own response shape. */
export function respond(h: Harness, transcript: string) {
  h.setFetch(async (call) =>
    call.url.includes("deepgram")
      ? json({ results: { channels: [{ alternatives: [{ transcript }] }] } })
      : json({ text: transcript }),
  );
}

export type PressKey = "pressShortcut" | "pressTranscribeShortcut" | "pressCommandShortcut" | "pressSkillShortcut";

/** Starts a recording with a shortcut (the send key by default) and waits for the recorder process. */
export async function startRecording(h: Harness, press: PressKey = "pressShortcut"): Promise<FakeChild> {
  const wanted = h.recorderChildren().length + 1;
  await h[press]();
  await h.until(() => h.recorderChildren().length === wanted);
  return h.recorderChildren()[wanted - 1]!;
}

/**
 * Stops a recording longer than the 0.5 s minimum and waits for the transcript outcome. The default
 * stops with the transcribe-only shortcut, so the composer is not sent.
 */
export async function stopAndSettle(h: Harness, stop: PressKey = "pressTranscribeShortcut") {
  h.advance(2000);
  await h[stop]();
  await h.until(() => h.talkStatuses.length > 0 && h.talkStatuses.at(-1) === undefined);
}

export const audio = (child: FakeChild, bytes = 3200) => child.emitAudio(new Uint8Array(bytes).fill(1));
export const sessionEvent = (h: Harness, name = "session_before_switch") => h.events.get(name)!();
export const mixed = (statuses: (string | undefined)[]) => statuses.filter(Boolean).join("\n");

export type Stop = PressKey | "send" | "talk" | "command" | "skill";
export const stopWith = async (h: Harness, stop: Stop) => {
  if (stop === "send") await h.runTalk("send");
  else if (stop === "talk") await h.runTalk("");
  else if (stop === "command" || stop === "skill") await h.runTalk(stop);
  else await h[stop]();
};
