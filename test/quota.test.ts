import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fetchQuota } from "../quota.ts";
import { API_KEY, audioResponse, createHarness } from "./harness.ts";

const subscription = {
  character_count: 1000,
  character_limit: 10000,
  next_character_count_reset_unix: 1738356858,
  current_overage: { amount: "0.50", currency: "usd" },
  currency: "usd",
  next_invoice: { amount_due_cents: 1234 },
};

const lookup = (response: Response) =>
  fetchQuota(
    API_KEY,
    (async () => response) as typeof fetch,
    new AbortController().signal,
  );

// The provider boundary owns field validation and safe output, not live pricing assumptions.
test("quota calculates allowance and shows provider billing without adding costs", async () => {
  const result = await lookup(Response.json(subscription));
  assert.equal(result.ok, true);
  assert.equal(
    result.message,
    [
      "ElevenLabs quota (account-wide, not just /speak):",
      "credits used: 1,000 / 10,000",
      "credits remaining: 9,000",
      "usage: 10.0%",
      "next reset (UTC): 2025-01-31T20:54:18.000Z",
      "current overage (provider-reported): 0.50 USD",
      "next invoice (provider-reported): 12.34 USD",
      "Per-speech cost and PAYG balance/total spend: unavailable from this lookup.",
      "Credits are not a guaranteed number of speech characters. Invoice and overage are not added together.",
    ].join("\n"),
  );
});

for (const [used, limit, percent, excess] of [
  [120, 100, "120.0%", 20],
  [5, 0, "unavailable (zero allowance)", 5],
  [0, 0, "unavailable (zero allowance)", 0],
] as const) {
  test(`quota handles ${used}/${limit} and unavailable optional values`, async () => {
    const result = await lookup(
      Response.json({ character_count: used, character_limit: limit }),
    );
    assert.equal(result.ok, true);
    assert.match(result.message, /credits remaining: 0\n/);
    assert.ok(result.message.includes(`usage: ${percent}\n`));
    assert.equal(
      result.message.includes(`over allowance: ${excess} credits\n`),
      excess > 0,
    );
    for (const field of [
      "next reset (UTC)",
      "current overage (provider-reported)",
      "next invoice (provider-reported)",
    ])
      assert.ok(result.message.includes(`${field}: unavailable`));
  });
}

test("quota rejects malformed allowance, JSON and oversized responses", async () => {
  for (const data of [
    null,
    {},
    { character_count: -1, character_limit: 10 },
    { character_count: 1, character_limit: "10" },
    { character_count: 1.5, character_limit: 10 },
    { character_count: Number.MAX_SAFE_INTEGER + 1, character_limit: 10 },
  ]) {
    const result = await lookup(Response.json(data));
    assert.equal(result.ok, false);
    assert.match(result.message, /invalid quota response/);
  }
  for (const body of ["not json", "x".repeat(64 * 1024 + 1)]) {
    assert.equal((await lookup(new Response(body))).ok, false);
  }
});

test("invalid optional values are unavailable, not echoed or invented", async () => {
  const result = await lookup(
    Response.json({
      ...subscription,
      next_character_count_reset_unix: Number.MAX_SAFE_INTEGER,
      current_overage: { amount: API_KEY, currency: "usd" },
      currency: API_KEY,
      next_invoice: { amount_due_cents: 999 },
    }),
  );
  assert.equal(result.ok, true);
  assert.doesNotMatch(result.message, new RegExp(API_KEY));
  assert.match(result.message, /next reset \(UTC\): unavailable/);
  assert.match(
    result.message,
    /current overage \(provider-reported\): unavailable/,
  );
  assert.match(
    result.message,
    /next invoice \(provider-reported\): unavailable/,
  );
});

for (const [status, message] of [
  [301, "redirect"],
  [401, "HTTP 401"],
  [403, "subscription access"],
  [429, "rate-limited"],
  [503, "server error"],
  [400, "HTTP 400"],
] as const) {
  test(`quota HTTP ${status} omits raw response and does not retry`, async () => {
    let calls = 0;
    const result = await fetchQuota(
      API_KEY,
      (async () => {
        calls++;
        return new Response(`private ${API_KEY}`, { status });
      }) as typeof fetch,
      new AbortController().signal,
    );
    assert.equal(result.ok, false);
    assert.ok(result.message.includes(message));
    assert.doesNotMatch(result.message, /private|test-secret/);
    assert.equal(calls, 1);
  });
}

for (const [detail, evidence, guidance] of [
  [
    { type: "authorization_error", code: "missing_permissions" },
    "type=authorization_error; code=missing_permissions",
    "subscription-read permissions",
  ],
  [
    { status: "missing_permissions" },
    "status=missing_permissions",
    "subscription-read permissions",
  ],
  [
    { type: "authentication_error", code: "invalid_api_key" },
    "type=authentication_error; code=invalid_api_key",
    "key's validity",
  ],
] as const) {
  test(`quota 401 reports structured ${evidence} rather than guessing from HTTP`, async () => {
    const result = await lookup(
      Response.json(
        { detail: { ...detail, message: `private ${API_KEY}` } },
        { status: 401 },
      ),
    );
    assert.equal(result.ok, false);
    assert.ok(result.message.includes(`HTTP 401; ${evidence}`));
    assert.ok(result.message.includes(guidance));
    assert.doesNotMatch(
      result.message,
      /private|test-secret|rejected the API key/,
    );
    if (guidance === "subscription-read permissions")
      assert.doesNotMatch(
        result.message,
        /authentication failure|key's validity/,
      );
  });
}

test("quota error identifiers are bounded and omit key-shaped or arbitrary values", async () => {
  const key = "secret_key";
  for (const detail of [
    {
      type: "authentication_error",
      code: `invalid_${key}`,
      status: key,
      message: key,
    },
    { type: "x".repeat(65), code: "unsafe\ncode", status: { token: key } },
  ]) {
    const result = await fetchQuota(
      key,
      (async () => Response.json({ detail }, { status: 401 })) as typeof fetch,
      new AbortController().signal,
    );
    assert.equal(result.ok, false);
    assert.doesNotMatch(result.message, /secret_key|unsafe|xxxxxxxx|\[object/);
    assert.ok(
      !result.message.includes("; code=") &&
        !result.message.includes("; status="),
    );
  }
  const unknown = await lookup(
    Response.json({ detail: { code: "unknown_auth_reason" } }, { status: 401 }),
  );
  assert.match(unknown.message, /code=unknown_auth_reason/);
  assert.match(unknown.message, /specific authentication\/access cause/);
  assert.doesNotMatch(unknown.message, /Check|invalid API key|missing access/);
});

test("quota preserves HTTP evidence when the error body is oversized or unreadable", async () => {
  const body = JSON.stringify({
    detail: { code: "missing_permissions", message: "x".repeat(4096) },
  });
  const oversized = await lookup(new Response(body, { status: 401 }));
  assert.match(oversized.message, /HTTP 401/);
  assert.match(oversized.message, /could not be read/);
  assert.doesNotMatch(
    oversized.message,
    /missing_permissions|subscription-read/,
  );
  const unreadable = new Response(
    new ReadableStream({
      start(controller) {
        controller.error(new Error(`private ${API_KEY}`));
      },
    }),
    { status: 401 },
  );
  const result = await lookup(unreadable);
  assert.match(result.message, /HTTP 401/);
  assert.match(result.message, /could not be read/);
  assert.doesNotMatch(result.message, /private|test-secret|cause is unknown/);
});

test("quota unknown request errors and deadline omit arbitrary error text", async () => {
  const failure = await fetchQuota(
    API_KEY,
    (async () => {
      throw new Error(`private ${API_KEY}`);
    }) as typeof fetch,
    new AbortController().signal,
  );
  assert.equal(failure.ok, false);
  assert.match(failure.message, /cause is unknown/);
  assert.doesNotMatch(failure.message, /private|test-secret/);
  let observedSignal: AbortSignal | undefined;
  const task = fetchQuota(
    API_KEY,
    (async (_url, init) => {
      observedSignal = init?.signal as AbortSignal;
      await delay(30);
      observedSignal.throwIfAborted();
      return Response.json(subscription);
    }) as typeof fetch,
    new AbortController().signal,
    5,
  );
  const timeout = await task;
  assert.equal(observedSignal?.aborted, true);
  assert.equal(timeout.ok, false);
  assert.match(timeout.message, /timed out/);
});

test("quota command uses key only, returns promptly and works outside TUI with no speech effects", async () => {
  const h = await createHarness({ config: null });
  try {
    let resolve!: (value: Response) => void;
    h.setFetch(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await h.run("quota", { mode: "rpc", idle: false, pending: true });
    assert.equal(h.fetchCalls.length, 1);
    const call = h.fetchCalls[0]!;
    assert.equal(call.url, "https://api.elevenlabs.io/v1/user/subscription");
    assert.equal(call.init.method, "GET");
    assert.equal(call.init.redirect, "manual");
    assert.equal(call.init.body, undefined);
    assert.deepEqual(call.init.headers, {
      "xi-api-key": API_KEY,
      accept: "application/json",
    });
    await h.run("quota");
    assert.equal(h.fetchCalls.length, 1);
    assert.match(h.messages(), /already pending/);
    resolve(Response.json(subscription));
    await h.controller.whenIdle();
    assert.match(h.messages(), /credits remaining: 9,000/);
    assert.equal(h.spawnCalls.length, 0);
    assert.deepEqual(await h.cacheFiles(), []);
    assert.deepEqual(h.statuses, []);
    assert.deepEqual(h.widgets, []);
    assert.deepEqual(h.entries, []);
  } finally {
    await h.cleanup();
  }
});

test("quota missing key makes no request", async () => {
  const h = await createHarness({ apiKey: null, config: null });
  try {
    await h.run("quota");
    assert.match(h.messages(), /ELEVENLABS_API_KEY is not set/);
    assert.equal(h.fetchCalls.length, 0);
  } finally {
    await h.cleanup();
  }
});

test("quota leaves speech state, progress and responsive stop untouched", async () => {
  const h = await createHarness();
  try {
    let resolve!: (value: Response) => void;
    h.setFetch((call) =>
      call.init.method === "GET"
        ? new Promise((done) => {
            resolve = done;
          })
        : Promise.resolve(audioResponse()),
    );
    await h.run("text Hello");
    await h.until(() => h.children.length === 1);
    const widgets = [...h.widgets];
    const statuses = [...h.statuses];
    await h.run("quota");
    assert.deepEqual(h.widgets, widgets);
    assert.deepEqual(h.statuses, statuses);
    await h.run("stop");
    assert.equal(h.children[0]!.signals[0], "SIGTERM");
    resolve(Response.json(subscription));
    await h.controller.whenIdle();
    assert.match(h.messages(), /Stopped/);
    assert.match(h.messages(), /credits remaining: 9,000/);
    assert.equal(h.aborts, 0);
  } finally {
    await h.cleanup();
  }
});

test("session cleanup aborts quota and old completion cannot clear a replacement lookup", async () => {
  const h = await createHarness();
  try {
    const resolvers: ((response: Response) => void)[] = [];
    h.setFetch(
      () =>
        new Promise((done) => {
          resolvers.push(done);
        }),
    );
    await h.run("quota");
    const oldSignal = h.fetchCalls[0]!.init.signal!;
    h.events.get("session_before_switch")!();
    assert.equal(oldSignal.aborted, true);
    await h.run("quota");
    resolvers[0]!(Response.json(subscription));
    await delay(5);
    assert.doesNotMatch(h.messages(), /credits remaining/);
    await h.run("quota");
    assert.equal(h.fetchCalls.length, 2);
    resolvers[1]!(Response.json({ character_count: 2, character_limit: 5 }));
    await h.controller.whenIdle();
    assert.match(h.messages(), /credits remaining: 3\n/);
    assert.doesNotMatch(h.messages(), /credits remaining: 9,000/);
  } finally {
    await h.cleanup();
  }
});
