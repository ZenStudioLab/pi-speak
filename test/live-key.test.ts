import assert from "node:assert/strict";
import { test } from "node:test";
import { audioResponse } from "./harness.ts";
import { afterStart, players, settle, speakAloud, startLive } from "./live-harness.ts";
import { useTalkHarness, type Harness } from "./talk-harness.ts";

const harness = useTalkHarness();
const OTHER_TOOLS = ["read", "bash"];

const liveOn = async (h: Harness) => {
  await h.run("status");
  return /live mode: on/.test(h.notices.at(-1)!.message);
};

test("the live key starts live mode and a second press ends it, as /talk live does", async () => {
  const h = await harness({ activeTools: OTHER_TOOLS });
  await h.pressLiveShortcut();
  assert.equal(h.sockets.length, 1);
  assert.equal(h.recorderChildren().length, 1);
  assert.equal(await liveOn(h), true);
  assert.deepEqual(h.host.activeTools, [...OTHER_TOOLS, "speak_aloud"]);
  const child = h.recorderChildren()[0]!;
  await h.pressLiveShortcut();
  assert.deepEqual(child.signals, ["SIGINT"]);
  assert.ok(h.sockets[0]!.closes.length >= 1);
  assert.equal(h.liveStatuses.at(-1), undefined);
  assert.deepEqual(h.host.activeTools, OTHER_TOOLS);
  assert.equal(afterStart(h).at(-1), "Live mode ended. The microphone is closed.");
  assert.equal(await liveOn(h), false);
});

test("the live key outside the interactive terminal is refused exactly as /talk live is", async () => {
  const h = await harness();
  await h.pressLiveShortcut({ mode: "rpc" });
  await h.runTalk("live", { mode: "rpc" });
  const [byKey, byCommand] = h.notices.map((notice) => notice.message);
  assert.match(byKey!, /works only in the interactive terminal/);
  assert.equal(byKey, byCommand);
  assert.equal(h.sockets.length, 0);
});

test("the live key never starts push-to-talk, and the push-to-talk keys keep their meaning beside it", async () => {
  const h = await harness();
  await h.pressLiveShortcut();
  assert.equal(h.talkStatuses.length, 0, "no recording status");
  assert.equal(h.recorderChildren().length, 1, "only the live recorder");
  await h.pressLiveShortcut();
  await h.pressShortcut();
  await h.until(() => h.recorderChildren().length === 2);
  assert.match(h.talkStatuses.at(-1)!, /Recording/);
  assert.equal(h.sockets.length, 1, "push-to-talk opened no live connection");
});

test("a second live key press while the start is waiting for the connection cancels it", async () => {
  const h = await harness({ holdSockets: true });
  const starting = h.pressLiveShortcut();
  await h.until(() => h.sockets.length === 1);
  await h.pressLiveShortcut();
  await starting;
  assert.match(h.messages(), /Live mode start cancelled\. Nothing was recorded\./);
  assert.equal(h.recorderChildren().length, 0);
  assert.equal(await liveOn(h), false);
});

test("the live key ends live mode while a reply plays, drops the waiting one, and leaves the agent running", async () => {
  const h = await harness({ activeTools: OTHER_TOOLS });
  h.setFetch(async () => audioResponse());
  await startLive(h);
  await speakAloud(h, "Đang chạy các bài test.");
  await speakAloud(h, "Xong rồi.");
  await h.until(() => players(h).length === 1);
  await h.pressLiveShortcut({ idle: false });
  assert.deepEqual(players(h)[0]!.signals, ["SIGTERM"]);
  await settle();
  assert.equal(h.fetchCalls.length, 1, "the waiting update is dropped");
  assert.equal(h.aborts, 0, "the agent is not aborted");
  assert.equal(await liveOn(h), false);
  assert.deepEqual(h.host.activeTools, OTHER_TOOLS);
});
