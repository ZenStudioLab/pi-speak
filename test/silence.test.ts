import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import speak from "../index.ts";

/**
 * Loads the real default export with fetch and spawn rigged to count use. The one file read is the
 * configuration, for the shortcut; `config` is its text, or undefined for a file that cannot be read.
 */
async function load(config?: string) {
  const commands: string[] = [];
  const shortcuts: string[] = [];
  const events = new Map<string, (event?: unknown, ctx?: unknown) => void>();
  const used: string[] = [];
  const fetchFn = (async () => {
    used.push("fetch");
    throw new Error("network forbidden");
  }) as typeof fetch;
  const spawnFn = (() => {
    used.push("spawn");
    throw new Error("process forbidden");
  }) as never;
  const webSocketFn = (() => {
    used.push("websocket");
    throw new Error("connection forbidden");
  }) as never;
  const readFile = async () => {
    used.push("readFile");
    if (config === undefined) throw new Error("no configuration file");
    return config;
  };
  // SAFETY: The entry may use only these members; anything else throws and fails the test. A tool is registered
  // inactive, so the active set stays empty, and any `setActiveTools` call is recorded as use.
  const api = {
    registerCommand: (name: string) => commands.push(name),
    registerShortcut: (key: string) => shortcuts.push(key),
    registerTool: () => undefined,
    getActiveTools: () => [],
    setActiveTools: () => used.push("setActiveTools"),
    on: (event: string, handler: (event?: unknown, ctx?: unknown) => void) => {
      events.set(event, handler);
      return () => undefined;
    },
  } as unknown as ExtensionAPI;
  await speak(api, { fetchFn, spawnFn, webSocketFn, readFile, env: {} });
  return { commands, shortcuts, events, used };
}

test("loading registers /speak, /talk, all four shortcuts, four cancel-only lifecycle handlers, three compaction-state handlers, and the agent-run tool handler, starting no process or request and changing no active tool", async () => {
  const realFetch = globalThis.fetch;
  let globalFetches = 0;
  globalThis.fetch = (async () => {
    globalFetches++;
    throw new Error("network forbidden");
  }) as typeof fetch;
  try {
    const { commands, shortcuts, events, used } = await load();
    assert.deepEqual(commands, ["speak", "talk"]);
    assert.deepEqual(shortcuts, ["alt+t", "alt+shift+t", "alt+m", "alt+i"]);
    assert.deepEqual([...events.keys()].sort(), [
      "before_agent_start",
      "session_before_compact",
      "session_before_fork",
      "session_before_switch",
      "session_compact",
      "session_compact_failed",
      "session_shutdown",
      "session_tree",
    ]);
    assert.deepEqual(used, ["readFile"]);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(globalFetches, 0);
});

const DEFAULT_KEYS = ["alt+t", "alt+shift+t", "alt+m", "alt+i"];
for (const [name, input, expected] of [
  ["all four come from the configuration", { shortcut: "ctrl+alt+m", transcribeShortcut: "ctrl+alt+n", commandShortcut: "ctrl+alt+o", skillShortcut: "ctrl+alt+p" }, ["ctrl+alt+m", "ctrl+alt+n", "ctrl+alt+o", "ctrl+alt+p"]],
  ["one set key keeps the others' defaults", { shortcut: "ctrl+alt+m" }, ["ctrl+alt+m", "alt+shift+t", "alt+m", "alt+i"]],
  ["the command and skill keys alone", { commandShortcut: "ctrl+alt+o", skillShortcut: ["ctrl+alt+p", "ctrl+alt+q"] }, ["alt+t", "alt+shift+t", "ctrl+alt+o", "ctrl+alt+p", "ctrl+alt+q"]],
  ["equal keys register the four defaults", { shortcut: "alt+x", transcribeShortcut: "alt+x" }, DEFAULT_KEYS],
  [
    "every key of the first two lists is registered",
    { shortcut: ["alt+t", "alt+y"], transcribeShortcut: ["alt+shift+t", "alt+shift+y"] },
    ["alt+t", "alt+y", "alt+shift+t", "alt+shift+y", "alt+m", "alt+i"],
  ],
  ["a key repeated across the lists registers the four defaults", { shortcut: ["alt+t", "alt+y"], transcribeShortcut: ["alt+shift+t", "Alt+Y"] }, DEFAULT_KEYS],
  ["a send key equal to the command default registers the four defaults", { shortcut: "alt+m" }, DEFAULT_KEYS],
  ["a skill key equal to a send key registers the four defaults", { skillShortcut: "alt+t" }, DEFAULT_KEYS],
  ["a list with five keys registers the four defaults", { shortcut: ["alt+a", "alt+b", "alt+c", "alt+d", "alt+e"] }, DEFAULT_KEYS],
  ["a bad alias registers the four defaults", { shortcut: "ctrl+alt+m", commandAliases: { "": "/model" } }, DEFAULT_KEYS],
] as const)
  test(`the shortcuts at load: ${name}`, async () => {
    const { shortcuts, used } = await load(JSON.stringify({ input }));
    assert.deepEqual(shortcuts, expected);
    assert.deepEqual(used, ["readFile"]);
  });

test("a configuration that cannot be read at load registers the four default shortcuts", async () => {
  const { shortcuts } = await load("{ not json");
  assert.deepEqual(shortcuts, DEFAULT_KEYS);
});

test("the extension subscribes to no agent, turn, tool, or message event except before_agent_start, whose handler only removes speak_aloud", async () => {
  const { events } = await load();
  for (const event of [
    "session_start",
    "agent_start",
    "agent_end",
    "turn_start",
    "turn_end",
    "message_end",
    "tool_call",
    "tool_result",
  ])
    assert.ok(!events.has(event), event);
});

test("firing every lifecycle handler with nothing active starts no request, process, or file read", async () => {
  const { events, used } = await load();
  const afterLoad = [...used];
  for (const handler of events.values()) handler();
  assert.deepEqual(used, afterLoad);
  assert.ok(!used.includes("spawn") && !used.includes("fetch"));
});

test("a reload rebuilds the extension and still starts no recorder or request", async () => {
  for (const reload of [await load(), await load()]) {
    for (const handler of reload.events.values()) handler();
    assert.deepEqual(reload.used, ["readFile"]);
  }
});

test("loading with the stop phrase on, then firing every lifecycle handler, opens no connection", async () => {
  const RealWebSocket = globalThis.WebSocket;
  let globalSockets = 0;
  globalThis.WebSocket = class {
    constructor() {
      globalSockets++;
      throw new Error("connection forbidden");
    }
  } as never;
  try {
    const { shortcuts, events, used } = await load(
      JSON.stringify({ input: { provider: "elevenlabs", stopOnPhrase: true, stopPhrases: ["send it"] } }),
    );
    assert.deepEqual(shortcuts, DEFAULT_KEYS);
    for (const handler of events.values()) handler();
    assert.deepEqual(used, ["readFile"]);
  } finally {
    globalThis.WebSocket = RealWebSocket;
  }
  assert.equal(globalSockets, 0);
});

test("loading with input.holdSpace on subscribes to session_start only, and starts nothing until a hold is recognized", async () => {
  const { events, used } = await load(JSON.stringify({ input: { holdSpace: true } }));
  assert.ok(events.has("session_start"));
  assert.deepEqual(used, ["readFile"]);
  const listeners: unknown[] = [];
  // SAFETY: The handler uses only the run mode and ui.onTerminalInput.
  const ctx = { mode: "tui", ui: { onTerminalInput: (listener: unknown) => listeners.push(listener) } };
  for (const [name, handler] of events) handler(undefined, name === "session_start" ? ctx : undefined);
  assert.equal(listeners.length, 1);
  assert.deepEqual(used, ["readFile"]);
});

for (const [name, config] of [
  ["a configuration error", JSON.stringify({ input: { holdSpace: true, shortcut: "alt+m" } })],
  ["an unreadable file", undefined],
  ["a non-boolean holdSpace", JSON.stringify({ input: { holdSpace: "yes" } })],
  ["holdSpace left out", JSON.stringify({ input: {} })],
] as const)
  test(`hold Space is off after ${name}: no session_start subscription`, async () => {
    const { events } = await load(config);
    assert.ok(!events.has("session_start"));
  });
