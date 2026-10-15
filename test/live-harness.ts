import assert from "node:assert/strict";
import type { CtxOptions } from "./harness.ts";
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
