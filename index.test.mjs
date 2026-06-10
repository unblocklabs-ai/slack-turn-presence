import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  createSharedState,
  handleMessageReceived,
  handleMessageSent,
  registerSlackTurnPresenceHandlers,
  resolveConfig,
  runPresenceCheck,
} from "./dist/plugin-handlers.js";

const SLACK_SESSION_KEY = "agent:main:slack:channel:C123:thread:1700000000.000100";

describe("manifest and config", () => {
  it("declares Slack startup hook activation", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
    );

    assert.deepEqual(manifest.activation, {
      onStartup: true,
      onChannels: ["slack"],
      onCapabilities: ["hook"],
    });
    assert.equal(manifest.configSchema.properties.initialDelayMs.default, 180000);
    assert.equal(manifest.configSchema.properties.maxNudgesPerTurn.default, 1);
    assert.equal(manifest.configSchema.properties.repeatMs.default, null);
  });

  it("normalizes config defaults and invalid values", () => {
    assert.deepEqual(resolveConfig(undefined), {
      enabled: true,
      channels: ["slack"],
      initialDelayMs: 180000,
      repeatMs: null,
      maxNudgesPerTurn: 1,
      minObservedActivityBeforeNudge: 1,
      nudgeText:
        "You are still running in Slack and the user has not seen an update for about 3 minutes. If work is continuing, send a brief user-facing progress update via the normal user-facing message path and keep working. Do not stop solely because of this nudge.",
    });

    assert.deepEqual(
      resolveConfig({
        enabled: false,
        channels: ["Slack", "", "discord"],
        initialDelayMs: -1,
        repeatMs: 5000,
        maxNudgesPerTurn: 2.8,
        minObservedActivityBeforeNudge: -1,
        nudgeText: " still here ",
      }),
      {
        enabled: false,
        channels: ["slack", "discord"],
        initialDelayMs: 180000,
        repeatMs: 5000,
        maxNudgesPerTurn: 2,
        minObservedActivityBeforeNudge: 0,
        nudgeText: "still here",
      },
    );
  });
});

describe("slack turn presence", () => {
  it("enqueues one nudge after the silence threshold for an active Slack-origin turn", async () => {
    const harness = createHarness({ initialDelayMs: 100 });
    await startSlackRun(harness);

    harness.clock.advance(99);
    await flushAsync();
    assert.equal(harness.queuedMessages.length, 0);

    harness.clock.advance(1);
    await flushAsync();
    assert.equal(harness.queuedMessages.length, 1);
    assert.deepEqual(harness.queuedMessages[0], {
      sessionId: "active-run-session",
      text: harness.api.pluginConfig.nudgeText ?? defaultNudgeText(),
      options: {
        steeringMode: "all",
        debounceMs: 0,
        deliveryTimeoutMs: 30000,
      },
    });
    assert.equal(harness.injections.length, 0);
  });

  it("falls back to next-turn injection when active-run steering declines", async () => {
    const harness = createHarness({ initialDelayMs: 100 }, { queueMessageResult: false });
    await startSlackRun(harness);

    harness.clock.advance(100);
    await flushAsync();

    assert.equal(harness.queuedMessages.length, 0);
    assert.equal(harness.injections.length, 1);
    assert.equal(harness.injections[0].sessionKey, SLACK_SESSION_KEY);
    assert.equal(harness.injections[0].placement, "append_context");
    assert.equal(harness.injections[0].metadata.fallbackReason, "active-run-queue-declined");
    assert.equal(harness.injections[0].metadata.slack.threadTs, "1700000000.000100");
  });

  it("declines instead of falling back when no active run is resolved", async () => {
    const harness = createHarness({ initialDelayMs: 100 }, { activeRunSessionId: undefined });
    await startSlackRun(harness);

    harness.clock.advance(100);
    await flushAsync();

    assert.equal(harness.queuedMessages.length, 0);
    assert.equal(harness.injections.length, 0);
    assert.equal(harness.shared.turnsByRunId.size, 0);
    assert.equal(harness.warnings.at(-1)?.[0], "slack-turn-presence: host declined progress nudge");
    assert.equal(harness.warnings.at(-1)?.[1].reason, "no-active-run");
  });

  it("does not nudge at the initial threshold if a visible message was sent first", async () => {
    const harness = createHarness({ initialDelayMs: 100 });
    await startSlackRun(harness);

    harness.clock.advance(60);
    handleMessageSent(
      harness.api,
      harness.shared,
      { success: true, sessionKey: SLACK_SESSION_KEY, content: "working" },
      { sessionKey: SLACK_SESSION_KEY },
    );
    harness.clock.advance(40);
    await flushAsync();
    assert.equal(harness.queuedMessages.length, 0);

    harness.clock.advance(60);
    await flushAsync();
    assert.equal(harness.queuedMessages.length, 1);
  });

  it("does not enqueue a stale next-turn nudge after a final visible message when the run is gone", async () => {
    const harness = createHarness({ initialDelayMs: 100 }, { activeRunSessionId: undefined });
    await startSlackRun(harness);

    harness.clock.advance(60);
    handleMessageSent(
      harness.api,
      harness.shared,
      { success: true, sessionKey: SLACK_SESSION_KEY, content: "done" },
      { sessionKey: SLACK_SESSION_KEY },
    );
    harness.clock.advance(100);
    await flushAsync();

    assert.equal(harness.queuedMessages.length, 0);
    assert.equal(harness.injections.length, 0);
    assert.equal(harness.shared.turnsByRunId.size, 0);
    assert.equal(harness.warnings.at(-1)?.[1].reason, "no-active-run");
  });

  it("does not nudge cron, background, system, or non-Slack sessions by default", async () => {
    for (const trigger of ["cron", "background", "maintenance", "system"]) {
      const harness = createHarness({ initialDelayMs: 10 });
      await handleMessageReceived(
        harness.api,
        harness.shared,
        { sessionKey: SLACK_SESSION_KEY },
        { runId: `run-${trigger}`, sessionKey: SLACK_SESSION_KEY, trigger, messageProvider: "slack" },
      );
      harness.clock.advance(10);
      await flushAsync();
      assert.equal(harness.queuedMessages.length, 0, trigger);
    }

    const nonSlack = createHarness({ initialDelayMs: 10 });
    await handleMessageReceived(
      nonSlack.api,
      nonSlack.shared,
      { sessionKey: "agent:main:discord:channel:C123:thread:T1" },
      {
        runId: "run-discord",
        sessionKey: "agent:main:discord:channel:C123:thread:T1",
        messageProvider: "discord",
      },
    );
    nonSlack.clock.advance(10);
    await flushAsync();
    assert.equal(nonSlack.queuedMessages.length, 0);
  });

  it("honors maxNudgesPerTurn and prevents duplicates", async () => {
    const harness = createHarness({ initialDelayMs: 10, maxNudgesPerTurn: 1, repeatMs: 10 });
    await startSlackRun(harness);

    harness.clock.advance(10);
    await flushAsync();
    harness.clock.advance(100);
    await flushAsync();

    assert.equal(harness.queuedMessages.length, 1);
  });

  it("only repeats when repeatMs is configured", async () => {
    const withoutRepeat = createHarness({ initialDelayMs: 10, maxNudgesPerTurn: 3 });
    await startSlackRun(withoutRepeat);
    withoutRepeat.clock.advance(100);
    await flushAsync();
    assert.equal(withoutRepeat.queuedMessages.length, 1);

    const withRepeat = createHarness({ initialDelayMs: 10, repeatMs: 25, maxNudgesPerTurn: 3 });
    await startSlackRun(withRepeat);
    withRepeat.clock.advance(10);
    await flushAsync();
    withRepeat.clock.advance(24);
    await flushAsync();
    assert.equal(withRepeat.queuedMessages.length, 1);
    withRepeat.clock.advance(1);
    await flushAsync();
    assert.equal(withRepeat.queuedMessages.length, 2);
  });

  it("requires observed activity before nudge when configured", async () => {
    const harness = createHarness({
      initialDelayMs: 10,
      minObservedActivityBeforeNudge: 2,
    });
    await startSlackRun(harness);

    await runPresenceCheck(harness.api, harness.shared, "run-1");
    assert.equal(harness.queuedMessages.length, 0);

    handleMessageSent(
      harness.api,
      harness.shared,
      { success: true, sessionKey: SLACK_SESSION_KEY },
      { sessionKey: SLACK_SESSION_KEY },
    );
    harness.clock.advance(10);
    await flushAsync();
    assert.equal(harness.queuedMessages.length, 1);
  });

  it("does not nudge when no active run or durable injection API is available", async () => {
    const harness = createHarness(
      { initialDelayMs: 10 },
      { activeRunSessionId: undefined, disableInjection: true },
    );
    await startSlackRun(harness);

    harness.clock.advance(10);
    await flushAsync();

    assert.equal(harness.queuedMessages.length, 0);
    assert.equal(harness.injections.length, 0);
    assert.equal(harness.shared.turnsByRunId.size, 0);
  });

  it("does not throw when next-turn injection returns an invalid result", async () => {
    const harness = createHarness(
      { initialDelayMs: 10 },
      { queueMessageResult: false, injectionResult: undefined },
    );
    await startSlackRun(harness);

    harness.clock.advance(10);
    await flushAsync();

    assert.equal(harness.queuedMessages.length, 0);
    assert.equal(harness.injections.length, 1);
    assert.equal(harness.shared.turnsByRunId.size, 0);
    assert.equal(harness.warnings.at(-1)?.[0], "slack-turn-presence: host declined progress nudge");
    assert.equal(harness.warnings.at(-1)?.[1].reason, "next-turn-injection-invalid-result");
    assert(
      harness.warnings.some(
        ([message, meta]) =>
          message === "slack-turn-presence: next-turn injection returned invalid result" &&
          meta.resultType === "undefined",
      ),
    );
  });

  it("does not throw when next-turn injection rejects", async () => {
    const harness = createHarness(
      { initialDelayMs: 10 },
      { queueMessageResult: false, injectionError: new Error("facade failed") },
    );
    await startSlackRun(harness);

    harness.clock.advance(10);
    await flushAsync();

    assert.equal(harness.queuedMessages.length, 0);
    assert.equal(harness.injections.length, 1);
    assert.equal(harness.shared.turnsByRunId.size, 0);
    assert.equal(harness.warnings.at(-1)?.[0], "slack-turn-presence: host declined progress nudge");
    assert.equal(harness.warnings.at(-1)?.[1].reason, "next-turn-injection-error");
    assert(
      harness.warnings.some(
        ([message, meta]) =>
          message === "slack-turn-presence: next-turn injection failed" &&
          meta.error === "facade failed",
      ),
    );
  });

  it("registers only lifecycle and outbound observation hooks, preserving Slack delivery paths", () => {
    const hooks = [];
    const api = createHarness().api;
    api.on = (hookName, handler) => {
      hooks.push({ hookName, handler });
    };

    registerSlackTurnPresenceHandlers(api, createSharedState(createFakeClock()));

    assert.deepEqual(
      hooks.map((hook) => hook.hookName),
      ["message_received", "message_sent", "gateway_stop"],
    );
    assert.equal(hooks.includes("message_sending"), false);
    assert.equal(hooks.includes("reply_payload_sending"), false);
  });
});

async function startSlackRun(harness) {
  await handleMessageReceived(
    harness.api,
    harness.shared,
    { sessionKey: SLACK_SESSION_KEY },
    {
      runId: "run-1",
      sessionKey: SLACK_SESSION_KEY,
      messageProvider: "slack",
      agentId: "main",
      accountId: "default",
    },
  );
}

function createHarness(pluginConfig = {}, options = {}) {
  const clock = createFakeClock();
  const injections = [];
  const queuedMessages = [];
  const warnings = [];
  const activeRunSessionId =
    "activeRunSessionId" in options ? options.activeRunSessionId : "active-run-session";
  const api = {
    pluginConfig,
    logger: {
      info() {},
      warn(message, meta) {
        warnings.push([message, meta]);
      },
    },
    activeRunQueue: {
      resolveSessionId: () => activeRunSessionId,
      queueMessage: (sessionId, text, queueOptions) => {
        if (options.queueMessageResult === false) {
          return false;
        }
        queuedMessages.push({ sessionId, text, options: queueOptions });
        return true;
      },
    },
    on() {},
  };
  if (!options.disableInjection) {
    api.enqueueNextTurnInjection = async (injection) => {
      injections.push(injection);
      if (options.injectionError) {
        throw options.injectionError;
      }
      if ("injectionResult" in options) {
        return options.injectionResult;
      }
      return { enqueued: true, id: `inj-${injections.length}`, sessionKey: injection.sessionKey };
    };
  }
  return {
    api,
    clock,
    injections,
    queuedMessages,
    warnings,
    shared: createSharedState(clock),
  };
}

function defaultNudgeText() {
  return "You are still running in Slack and the user has not seen an update for about 3 minutes. If work is continuing, send a brief user-facing progress update via the normal user-facing message path and keep working. Do not stop solely because of this nudge.";
}

function createFakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(callback, delayMs) {
      const timer = {
        id: nextId++,
        dueAt: now + Math.max(0, delayMs),
        callback,
        unref() {},
      };
      timers.set(timer.id, timer);
      return timer;
    },
    clearTimeout(handle) {
      timers.delete(handle.id);
    },
    advance(ms) {
      now += ms;
      let ran = true;
      while (ran) {
        ran = false;
        const due = [...timers.values()].filter((timer) => timer.dueAt <= now);
        due.sort((a, b) => a.dueAt - b.dueAt || a.id - b.id);
        for (const timer of due) {
          if (!timers.delete(timer.id)) continue;
          timer.callback();
          ran = true;
        }
      }
    },
  };
}

async function flushAsync() {
  await Promise.resolve();
  await Promise.resolve();
}
