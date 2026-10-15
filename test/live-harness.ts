import assert from "node:assert/strict";
import type { CtxOptions, FetchCall } from "./harness.ts";
import type { Harness } from "./talk-harness.ts";

/** Runs `/talk live` to the end of its start and returns the one recorder and the one connection it opened. */
export async function startLive(h: Harness, context: CtxOptions = {}) {
  await h.runTalk("live", context);
  assert.equal(h.sockets.length, 1, "one connection");
  assert.equal(h.recorderChildren().length, 1, "one recorder");
  return { child: h.recorderChildren()[0]!, socket: h.sockets[0]! };
}

/** Lets already queued work and fake-process exits run before an assertion that nothing happened. */
export const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

/** Messages shown other than the start message. */
export const afterStart = (h: Harness) =>
  h.notices.map((notice) => notice.message).filter((message) => !message.startsWith("Live mode is on. It uses"));

/** What the model sees of a `speak_aloud` call: the tool the extension registered, run as the host would. */
export async function speakAloud(h: Harness, text: string): Promise<string> {
  const tool = h.host.tools.get("speak_aloud")!;
  const result = await tool.execute("call", { text }, undefined, undefined, undefined as never);
  return (result.content[0] as { text: string }).text;
}

/** The audio players started so far, in order; the recorder and these are the only processes. */
export const players = (h: Harness) => h.children.filter((_, i) => h.spawnCalls[i]!.command === "fakeplayer");

/** The text of each speech synthesis request so far, in order. */
export const spokenTexts = (h: Harness) => h.fetchCalls.map((call) => JSON.parse(String(call.init.body)).text as string);

/** A synthesis request that stays open until it is aborted, as a slow provider's does. */
export const pendingFetch = (call: FetchCall) =>
  new Promise<Response>((_resolve, reject) =>
    call.init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
  );
