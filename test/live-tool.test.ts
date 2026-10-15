import assert from "node:assert/strict";
import { test } from "node:test";
import { audioResponse } from "./harness.ts";
import { afterStart, pendingFetch, players, settle, speakAloud, spokenTexts, startLive } from "./live-harness.ts";
import { baseConfig, sessionEvent, useTalkHarness } from "./talk-harness.ts";

const harness = useTalkHarness();
const OTHER_TOOLS = ["read", "bash", "mcp__docs__search"];
const beforeAgentStart = (h: Awaited<ReturnType<typeof harness>>) => h.events.get("before_agent_start")!();

test("loading registers speak_aloud inactive and, with live mode off, never changes the active tools", async () => {
  const h = await harness({ activeTools: OTHER_TOOLS });
  const tool = h.host.tools.get("speak_aloud")!;
  assert.equal(tool.defaultActive, false);
  assert.deepEqual(h.host.activeTools, OTHER_TOOLS);
  for (const event of h.events.keys()) if (event !== "session_start") sessionEvent(h, event);
  beforeAgentStart(h);
  assert.equal(h.host.setActiveToolsCalls.length, 0, "no setActiveTools call at all");
});

test("the tool's description and guidance tell the model what the spoken-update requirement lists", async () => {
  const h = await harness();
  const tool = h.host.tools.get("speak_aloud")!;
  const guidance = (tool.promptGuidelines ?? []).join("\n");
  assert.match(guidance, /talking to you by voice/);
  assert.match(guidance, /acknowledgement.*start.*progress.*long work/is);
  assert.doesNotMatch(guidance, /summary when you finish|short summary/i, "no end summary is asked for");
  assert.match(guidance, /final written answer is read aloud automatically.*do not repeat or summarize it with speak_aloud/is);
  assert.match(guidance, /language of the user's latest spoken message/);
  assert.match(guidance, /short and speakable.*no code blocks, tables, or long paths/is);
  assert.match(guidance, /written answer.*full record/is);
  assert.match(tool.description, /exactly as written/);
});

test("an agent run that starts with the tool already active and live mode off removes only that name", async () => {
  const h = await harness({ activeTools: [...OTHER_TOOLS, "speak_aloud"] });
  beforeAgentStart(h);
  assert.deepEqual(h.host.setActiveToolsCalls, [OTHER_TOOLS]);
  beforeAgentStart(h);
  assert.equal(h.host.setActiveToolsCalls.length, 1, "nothing left to remove, so no second call");
});

test("live start adds only that name, and every way of ending live mode removes only that name", async () => {
  for (const [name, end] of [
    ["/talk live", (h: Awaited<ReturnType<typeof harness>>) => h.runTalk("live")],
    ["a lost connection", (h: Awaited<ReturnType<typeof harness>>) => h.sockets[0]!.emit("close")],
    ["a session switch", (h: Awaited<ReturnType<typeof harness>>) => sessionEvent(h, "session_before_switch")],
  ] as const) {
    const h = await harness({ activeTools: OTHER_TOOLS });
    await startLive(h);
    assert.deepEqual(h.host.setActiveToolsCalls, [[...OTHER_TOOLS, "speak_aloud"]], `${name}: start adds it`);
    beforeAgentStart(h);
    assert.equal(h.host.setActiveToolsCalls.length, 1, `${name}: a run during live mode keeps it`);
    await end(h);
    assert.deepEqual(h.host.setActiveToolsCalls.at(-1), OTHER_TOOLS, `${name}: end removes it`);
    assert.equal(h.host.setActiveToolsCalls.length, 2);
    assert.deepEqual(h.host.activeTools, OTHER_TOOLS);
  }
});

test("live start with the tool already active, and live end after a restore that left it inactive, change nothing", async () => {
  const active = await harness({ activeTools: [...OTHER_TOOLS, "speak_aloud"] });
  await startLive(active);
  assert.equal(active.host.setActiveToolsCalls.length, 0, "already active: no add call");
  const inactive = await harness({ activeTools: OTHER_TOOLS });
  await startLive(inactive);
  inactive.host.api.setActiveTools(OTHER_TOOLS);
  const before = inactive.host.setActiveToolsCalls.length;
  await inactive.runTalk("live");
  assert.equal(inactive.host.setActiveToolsCalls.length, before, "not active at the end: no remove call");
});

test("a failure while the recorder is starting never leaves the tool active", async () => {
  const h = await harness({ activeTools: OTHER_TOOLS, holdSockets: true });
  const starting = h.runTalk("live");
  await h.until(() => h.sockets.length === 1);
  h.sockets[0]!.emit("open");
  h.sockets[0]!.emit("close");
  await starting;
  assert.deepEqual(h.host.activeTools, OTHER_TOOLS);
});

test("an agent run removes a restored tool while live mode is still starting, and keeps it once live mode is on", async () => {
  const h = await harness({ activeTools: [...OTHER_TOOLS, "speak_aloud"], holdSockets: true });
  const starting = h.runTalk("live");
  await h.until(() => h.sockets.length === 1);
  beforeAgentStart(h);
  assert.deepEqual(h.host.activeTools, OTHER_TOOLS, "starting is not live mode");
  h.sockets[0]!.emit("open");
  await starting;
  assert.deepEqual(h.host.activeTools, [...OTHER_TOOLS, "speak_aloud"], "live start adds it");
  beforeAgentStart(h);
  assert.deepEqual(h.host.activeTools, [...OTHER_TOOLS, "speak_aloud"], "a run during live mode keeps it");
});

test("the tool says why nothing will be spoken when live mode is off, the text is empty, or it is too long", async () => {
  const h = await harness({ config: baseConfig({}) });
  assert.match(await speakAloud(h, "Đang kiểm tra."), /live mode is off/);
  await startLive(h);
  assert.match(await speakAloud(h, "  \n "), /text is empty/);
  assert.match(await speakAloud(h, "x".repeat(10_001)), /10001 characters and the speech limit is 10000/);
  assert.equal(h.fetchCalls.length, 0, "nothing was synthesized");
  assert.equal(players(h).length, 0);
  await h.runTalk("live");
  assert.match(await speakAloud(h, "Xong rồi."), /live mode is off/);
  await settle();
  assert.equal(h.fetchCalls.length, 0);
});

test("the too-long result uses the configured limit when it is below the provider ceiling", async () => {
  const h = await harness({ config: { ...baseConfig(), hardLimitChars: 20 } });
  await startLive(h);
  assert.match(await speakAloud(h, "x".repeat(21)), /21 characters and the speech limit is 20/);
  assert.match(await speakAloud(h, "x".repeat(20)), /Queued/);
});

test("a queued update returns at once, is spoken exactly as written with ElevenLabs, and plays", async () => {
  const h = await harness({ config: { ...baseConfig({ provider: "deepgram" }), provider: "deepgram" } });
  h.setFetch(pendingFetch);
  await startLive(h);
  const text = " Đang kiểm tra các bài test. ";
  assert.match(await speakAloud(h, text), /Queued/);
  await h.until(() => h.fetchCalls.length === 1);
  assert.match(h.fetchCalls[0]!.url, /^https:\/\/api\.elevenlabs\.io\/v1\/text-to-speech\//);
  assert.deepEqual(spokenTexts(h), [text]);
  assert.equal(players(h).length, 0, "the call did not wait for synthesis");
});

test("updates play in the order the tool received them, each starting only after the one before it ends", async () => {
  const h = await harness();
  h.setFetch(async () => audioResponse());
  await startLive(h);
  await speakAloud(h, "Đã nhận yêu cầu.");
  await speakAloud(h, "Đang chạy các bài test.");
  await speakAloud(h, "Xong.");
  await h.until(() => players(h).length === 1);
  await settle();
  assert.equal(players(h).length, 1, "the later updates wait");
  assert.deepEqual(spokenTexts(h), ["Đã nhận yêu cầu."]);
  players(h)[0]!.finish(0);
  await h.until(() => players(h).length === 2);
  players(h)[1]!.finish(0);
  await h.until(() => players(h).length === 3);
  players(h)[2]!.finish(0);
  await settle();
  assert.deepEqual(spokenTexts(h), ["Đã nhận yêu cầu.", "Đang chạy các bài test.", "Xong."]);
  assert.equal(afterStart(h).length, 0);
});

test("a failed update shows a sanitized message, is not retried, and the waiting update is spoken", async () => {
  const h = await harness();
  let calls = 0;
  h.setFetch(async () => (++calls === 1 ? new Response("quota key=test-secret-key-123", { status: 500 }) : audioResponse()));
  await startLive(h);
  await speakAloud(h, "Cập nhật một.");
  await speakAloud(h, "Cập nhật hai.");
  await h.until(() => players(h).length === 1);
  assert.deepEqual(spokenTexts(h), ["Cập nhật một.", "Cập nhật hai."], "each update is requested once");
  assert.match(afterStart(h).join("\n"), /ElevenLabs had a server error \(HTTP 500\)\. Nothing was retried/);
  assert.ok(!h.messages().includes("test-secret-key-123"));
  assert.equal(h.liveStatuses.at(-1)?.includes("Pi speaking"), true, "live mode stays on and the next update is being spoken");
});
