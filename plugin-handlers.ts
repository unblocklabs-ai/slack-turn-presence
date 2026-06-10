export type Logger = {
  debug?: (message: string, meta?: Record<string, unknown>) => void;
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error?: (message: string, meta?: Record<string, unknown>) => void;
};

export type SlackTurnPresenceConfig = {
  enabled?: unknown;
  channels?: unknown;
  initialDelayMs?: unknown;
  repeatMs?: unknown;
  maxNudgesPerTurn?: unknown;
  minObservedActivityBeforeNudge?: unknown;
  nudgeText?: unknown;
};

export type ResolvedSlackTurnPresenceConfig = {
  enabled: boolean;
  channels: string[];
  initialDelayMs: number;
  repeatMs: number | null;
  maxNudgesPerTurn: number;
  minObservedActivityBeforeNudge: number;
  nudgeText: string;
};

export type PluginApi = {
  logger: Logger;
  pluginConfig?: SlackTurnPresenceConfig;
  registrationMode?: string;
  activeRunQueue?: ActiveRunQueueApi;
  on?: (
    hookName: string,
    handler: (event: unknown, ctx: HookContext) => void | Promise<void>,
  ) => unknown;
  enqueueNextTurnInjection?: (injection: {
    sessionKey: string;
    text: string;
    idempotencyKey?: string;
    placement?: "prepend_context" | "append_context";
    ttlMs?: number;
    metadata?: Record<string, unknown>;
  }) => Promise<unknown>;
  session?: {
    workflow?: {
      enqueueNextTurnInjection?: PluginApi["enqueueNextTurnInjection"];
    };
  };
};

export type ActiveRunQueueApi = {
  resolveSessionId: (sessionKey: string) => string | undefined;
  queueMessage: (
    sessionId: string,
    text: string,
    options?: {
      steeringMode?: "all";
      debounceMs?: number;
      deliveryTimeoutMs?: number;
      waitForTranscriptCommit?: boolean;
    },
  ) => boolean;
};

export type HookContext = {
  runId?: string;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  channelId?: string;
  accountId?: string;
  messageProvider?: string;
  trigger?: string;
};

export type MessageSentEvent = {
  to?: string;
  content?: string;
  success?: boolean;
  messageId?: string;
  sessionKey?: string;
  runId?: string;
  threadId?: string | number;
};

export type MessageReceivedEvent = {
  from?: string;
  content?: string;
  timestamp?: number;
  threadId?: string | number;
  messageId?: string;
  senderId?: string;
  sessionKey?: string;
  runId?: string;
  metadata?: Record<string, unknown>;
};

type TimerHandle = ReturnType<typeof setTimeout>;

export type TimerRuntime = {
  now: () => number;
  setTimeout: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimeout: (handle: TimerHandle) => void;
};

export type ActiveTurn = {
  runId: string;
  sessionKey: string;
  agentId?: string;
  channel: string;
  accountId?: string;
  startedAt: number;
  lastVisibleAt: number;
  observedActivity: number;
  nudgesSent: number;
  timer?: TimerHandle;
  closed: boolean;
};

export type SharedState = {
  registeredApis: WeakSet<object>;
  turnsByRunId: Map<string, ActiveTurn>;
  runIdsBySessionKey: Map<string, Set<string>>;
  runtime: TimerRuntime;
};

type NextTurnInjection = Parameters<NonNullable<PluginApi["enqueueNextTurnInjection"]>>[0];

type NudgeDeliveryResult =
  | { delivered: true; path: "active-run-queue" | "next-turn-injection" }
  | { delivered: false; reason: string };

const SHARED_STATE_KEY = "__slackTurnPresenceSharedState";
const DEFAULT_NUDGE_TEXT =
  "You are still running in Slack and the user has not seen an update for about 3 minutes. If work is continuing, send a brief user-facing progress update via the normal user-facing message path and keep working. Do not stop solely because of this nudge.";
const DEFAULT_CONFIG: ResolvedSlackTurnPresenceConfig = {
  enabled: true,
  channels: ["slack"],
  initialDelayMs: 180_000,
  repeatMs: null,
  maxNudgesPerTurn: 1,
  minObservedActivityBeforeNudge: 1,
  nudgeText: DEFAULT_NUDGE_TEXT,
};
const NON_INTERACTIVE_TRIGGERS = new Set([
  "background",
  "cron",
  "heartbeat",
  "maintenance",
  "scheduled",
  "system",
]);
const SLACK_SESSION_RE =
  /^agent:[^:]+:slack:(?<kind>channel|room|direct):(?<target>[^:]+):thread:(?<thread>.+)$/;

export function createSharedState(runtime: TimerRuntime = defaultTimerRuntime()): SharedState {
  return {
    registeredApis: new WeakSet<object>(),
    turnsByRunId: new Map<string, ActiveTurn>(),
    runIdsBySessionKey: new Map<string, Set<string>>(),
    runtime,
  };
}

export function getSharedState(): SharedState {
  const globalScope = globalThis as unknown as Record<string, SharedState | undefined>;
  globalScope[SHARED_STATE_KEY] ??= createSharedState();
  return globalScope[SHARED_STATE_KEY];
}

export function resolveConfig(input: SlackTurnPresenceConfig | undefined): ResolvedSlackTurnPresenceConfig {
  const enabled = typeof input?.enabled === "boolean" ? input.enabled : DEFAULT_CONFIG.enabled;
  const channels = normalizeChannels(input?.channels);
  return {
    enabled,
    channels,
    initialDelayMs: normalizePositiveInteger(input?.initialDelayMs, DEFAULT_CONFIG.initialDelayMs),
    repeatMs:
      input?.repeatMs === null || input?.repeatMs === undefined
        ? null
        : normalizePositiveInteger(input.repeatMs, DEFAULT_CONFIG.initialDelayMs),
    maxNudgesPerTurn: normalizeNonNegativeInteger(
      input?.maxNudgesPerTurn,
      DEFAULT_CONFIG.maxNudgesPerTurn,
    ),
    minObservedActivityBeforeNudge: normalizeNonNegativeInteger(
      input?.minObservedActivityBeforeNudge,
      DEFAULT_CONFIG.minObservedActivityBeforeNudge,
    ),
    nudgeText: normalizeNonEmptyString(input?.nudgeText, DEFAULT_CONFIG.nudgeText),
  };
}

export function registerSlackTurnPresenceHandlers(
  api: PluginApi,
  shared: SharedState = getSharedState(),
): void {
  if (typeof api.on !== "function") return;
  if (shared.registeredApis.has(api)) return;
  shared.registeredApis.add(api);

  api.on("message_received", async (event, ctx) => {
    await handleMessageReceived(api, shared, event as MessageReceivedEvent, ctx);
  });
  api.on("message_sent", (event, ctx) => {
    handleMessageSent(api, shared, event as MessageSentEvent, ctx);
  });
  api.on("gateway_stop", () => {
    closeAllTurns(shared);
  });
}

export async function handleMessageReceived(
  api: PluginApi,
  shared: SharedState,
  event: MessageReceivedEvent,
  ctx: HookContext,
): Promise<void> {
  const config = resolveConfig(api.pluginConfig);
  if (!config.enabled || config.maxNudgesPerTurn === 0) return;
  const target = resolveInteractiveTarget(event, ctx, config);
  if (!target) return;

  const runId = normalizeString(ctx.runId) ?? `session:${target.sessionKey}:${shared.runtime.now()}`;
  closeTurn(shared, runId);

  const now = shared.runtime.now();
  const turn: ActiveTurn = {
    runId,
    sessionKey: target.sessionKey,
    agentId: normalizeString(ctx.agentId),
    channel: target.channel,
    accountId: normalizeString(ctx.accountId),
    startedAt: now,
    lastVisibleAt: now,
    observedActivity: 1,
    nudgesSent: 0,
    closed: false,
  };
  shared.turnsByRunId.set(runId, turn);
  addSessionRun(shared, target.sessionKey, runId);
  scheduleNextCheck(api, shared, turn, config);
}

export function handleMessageSent(
  api: PluginApi,
  shared: SharedState,
  event: MessageSentEvent,
  ctx: HookContext,
): void {
  if (event.success === false) return;
  const sessionKey = normalizeString(event.sessionKey) ?? normalizeString(ctx.sessionKey);
  if (!sessionKey) return;
  const runIds = shared.runIdsBySessionKey.get(sessionKey);
  if (!runIds) return;

  const config = resolveConfig(api.pluginConfig);
  const now = shared.runtime.now();
  for (const runId of runIds) {
    const turn = shared.turnsByRunId.get(runId);
    if (!turn || turn.closed) continue;
    turn.lastVisibleAt = now;
    turn.observedActivity += 1;
    scheduleNextCheck(api, shared, turn, config);
  }
}

export async function runPresenceCheck(
  api: PluginApi,
  shared: SharedState,
  runId: string,
): Promise<void> {
  const turn = shared.turnsByRunId.get(runId);
  if (!turn || turn.closed) return;
  const config = resolveConfig(api.pluginConfig);
  if (!config.enabled || config.maxNudgesPerTurn === 0) {
    closeTurn(shared, runId);
    return;
  }
  if (turn.timer) {
    shared.runtime.clearTimeout(turn.timer);
    turn.timer = undefined;
  }

  const waitMs = resolveWaitMs(turn, config, shared.runtime.now());
  if (waitMs > 0) {
    scheduleTimer(api, shared, turn, waitMs);
    return;
  }
  if (turn.observedActivity < config.minObservedActivityBeforeNudge) {
    scheduleTimer(api, shared, turn, 1_000);
    return;
  }
  if (turn.nudgesSent >= config.maxNudgesPerTurn) {
    closeTurn(shared, runId);
    return;
  }

  const delivery = await deliverNudge(api, turn, config);
  if (delivery.delivered) {
    turn.nudgesSent += 1;
    api.logger.info("slack-turn-presence: delivered progress nudge", {
      runId: turn.runId,
      sessionKey: turn.sessionKey,
      path: delivery.path,
      nudgesSent: turn.nudgesSent,
    });
  } else {
    api.logger.warn("slack-turn-presence: host declined progress nudge", {
      runId: turn.runId,
      sessionKey: turn.sessionKey,
      reason: delivery.reason,
    });
  }

  if (config.repeatMs !== null && turn.nudgesSent < config.maxNudgesPerTurn) {
    turn.lastVisibleAt = shared.runtime.now();
    scheduleTimer(api, shared, turn, config.repeatMs);
  } else {
    closeTurn(shared, runId);
  }
}

async function deliverNudge(
  api: PluginApi,
  turn: ActiveTurn,
  config: ResolvedSlackTurnPresenceConfig,
): Promise<NudgeDeliveryResult> {
  const activeSessionId = api.activeRunQueue?.resolveSessionId(turn.sessionKey);
  if (!activeSessionId) {
    return { delivered: false, reason: "no-active-run" };
  }

  const queued = api.activeRunQueue?.queueMessage(activeSessionId, config.nudgeText, {
    steeringMode: "all",
    debounceMs: 0,
    deliveryTimeoutMs: 30_000,
  });
  if (queued) {
    return { delivered: true, path: "active-run-queue" };
  }

  const enqueue = resolveInjectionApi(api);
  if (!enqueue) {
    return { delivered: false, reason: "active-run-queue-declined" };
  }
  return enqueueNextTurnInjectionSafely(api, enqueue, turn, {
    sessionKey: turn.sessionKey,
    text: config.nudgeText,
    placement: "append_context",
    ttlMs: Math.max(config.initialDelayMs, config.repeatMs ?? config.initialDelayMs),
    idempotencyKey: `slack-turn-presence:${turn.runId}:${turn.nudgesSent + 1}`,
    metadata: buildInjectionMetadata(turn, "active-run-queue-declined"),
  });
}

async function enqueueNextTurnInjectionSafely(
  api: PluginApi,
  enqueue: NonNullable<PluginApi["enqueueNextTurnInjection"]>,
  turn: ActiveTurn,
  injection: NextTurnInjection,
): Promise<NudgeDeliveryResult> {
  try {
    const result = await enqueue(injection);
    if (!isNextTurnInjectionResult(result)) {
      api.logger.warn("slack-turn-presence: next-turn injection returned invalid result", {
        runId: turn.runId,
        sessionKey: turn.sessionKey,
        resultType: typeof result,
      });
      return { delivered: false, reason: "next-turn-injection-invalid-result" };
    }
    return result.enqueued
      ? { delivered: true, path: "next-turn-injection" }
      : { delivered: false, reason: "next-turn-injection-declined" };
  } catch (error) {
    api.logger.warn("slack-turn-presence: next-turn injection failed", {
      runId: turn.runId,
      sessionKey: turn.sessionKey,
      error: stringifyError(error),
    });
    return { delivered: false, reason: "next-turn-injection-error" };
  }
}

function isNextTurnInjectionResult(result: unknown): result is { enqueued: boolean } {
  return (
    typeof result === "object" &&
    result !== null &&
    typeof (result as { enqueued?: unknown }).enqueued === "boolean"
  );
}

function scheduleNextCheck(
  api: PluginApi,
  shared: SharedState,
  turn: ActiveTurn,
  config: ResolvedSlackTurnPresenceConfig,
): void {
  if (turn.closed) return;
  const waitMs = Math.max(1, resolveWaitMs(turn, config, shared.runtime.now()));
  scheduleTimer(api, shared, turn, waitMs);
}

function scheduleTimer(api: PluginApi, shared: SharedState, turn: ActiveTurn, delayMs: number): void {
  if (turn.timer) {
    shared.runtime.clearTimeout(turn.timer);
  }
  turn.timer = shared.runtime.setTimeout(() => {
    void runPresenceCheck(api, shared, turn.runId).catch((error) => {
      api.logger.warn(`slack-turn-presence: nudge check failed: ${stringifyError(error)}`);
    });
  }, delayMs);
  if (typeof (turn.timer as { unref?: unknown }).unref === "function") {
    (turn.timer as { unref: () => void }).unref();
  }
}

function resolveWaitMs(
  turn: ActiveTurn,
  config: ResolvedSlackTurnPresenceConfig,
  now: number,
): number {
  const silenceThreshold =
    turn.nudgesSent > 0 && config.repeatMs !== null ? config.repeatMs : config.initialDelayMs;
  return Math.max(0, turn.lastVisibleAt + silenceThreshold - now);
}

function closeAllTurns(shared: SharedState): void {
  for (const runId of [...shared.turnsByRunId.keys()]) {
    closeTurn(shared, runId);
  }
}

function closeTurn(shared: SharedState, runId: string): void {
  const turn = shared.turnsByRunId.get(runId);
  if (!turn) return;
  turn.closed = true;
  if (turn.timer) {
    shared.runtime.clearTimeout(turn.timer);
    turn.timer = undefined;
  }
  shared.turnsByRunId.delete(runId);
  const runIds = shared.runIdsBySessionKey.get(turn.sessionKey);
  runIds?.delete(runId);
  if (runIds?.size === 0) {
    shared.runIdsBySessionKey.delete(turn.sessionKey);
  }
}

function addSessionRun(shared: SharedState, sessionKey: string, runId: string): void {
  const existing = shared.runIdsBySessionKey.get(sessionKey);
  if (existing) {
    existing.add(runId);
    return;
  }
  shared.runIdsBySessionKey.set(sessionKey, new Set([runId]));
}

function resolveInteractiveTarget(
  event: MessageReceivedEvent,
  ctx: HookContext,
  config: ResolvedSlackTurnPresenceConfig,
): { channel: string; sessionKey: string } | undefined {
  const trigger = normalizeString(ctx.trigger)?.toLowerCase();
  if (trigger && NON_INTERACTIVE_TRIGGERS.has(trigger)) return undefined;
  const channel =
    normalizeString(ctx.messageProvider) ??
    normalizeString(ctx.channelId) ??
    channelFromSessionKey(ctx.sessionKey);
  if (!channel || !config.channels.includes(channel.toLowerCase())) return undefined;
  const sessionKey = normalizeString(event.sessionKey) ?? normalizeString(ctx.sessionKey);
  if (!sessionKey || channelFromSessionKey(sessionKey) !== channel.toLowerCase()) {
    return undefined;
  }
  return { channel: channel.toLowerCase(), sessionKey };
}

function channelFromSessionKey(sessionKey: unknown): string | undefined {
  const value = normalizeString(sessionKey);
  if (!value) return undefined;
  const parts = value.split(":");
  return parts.length >= 3 ? normalizeString(parts[2])?.toLowerCase() : undefined;
}

function buildInjectionMetadata(turn: ActiveTurn, fallbackReason: string): Record<string, unknown> {
  const thread = parseSlackThreadSessionKey(turn.sessionKey);
  return {
    reason: "slack_turn_silence",
    fallbackReason,
    runId: turn.runId,
    channel: turn.channel,
    accountId: turn.accountId,
    startedAt: turn.startedAt,
    lastVisibleAt: turn.lastVisibleAt,
    nudgesSent: turn.nudgesSent + 1,
    ...(thread
      ? {
          slack: {
            kind: thread.kind,
            target: thread.target,
            threadTs: thread.thread,
          },
        }
      : {}),
  };
}

function parseSlackThreadSessionKey(
  sessionKey: string,
): { kind: string; target: string; thread: string } | undefined {
  const match = SLACK_SESSION_RE.exec(sessionKey);
  if (!match?.groups) return undefined;
  return {
    kind: match.groups.kind,
    target: match.groups.target,
    thread: match.groups.thread,
  };
}

function resolveInjectionApi(api: PluginApi): PluginApi["enqueueNextTurnInjection"] | undefined {
  return api.session?.workflow?.enqueueNextTurnInjection ?? api.enqueueNextTurnInjection;
}

function defaultTimerRuntime(): TimerRuntime {
  return {
    now: () => Date.now(),
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (handle) => clearTimeout(handle),
  };
}

function normalizeChannels(value: unknown): string[] {
  if (!Array.isArray(value)) return DEFAULT_CONFIG.channels;
  const channels = value
    .map((entry) => normalizeString(entry)?.toLowerCase())
    .filter((entry): entry is string => Boolean(entry));
  return channels.length > 0 ? [...new Set(channels)] : DEFAULT_CONFIG.channels;
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  if (value < 1) return fallback;
  return Math.max(1, Math.floor(value));
}

function normalizeNonNegativeInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function normalizeNonEmptyString(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
