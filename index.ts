import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import * as agentHarness from "openclaw/plugin-sdk/agent-harness";
import {
  registerSlackTurnPresenceHandlers,
  type ActiveRunQueueApi,
  type PluginApi,
} from "./plugin-handlers.js";

export default definePluginEntry({
  id: "slack-turn-presence",
  name: "Slack Turn Presence",
  description:
    "Nudges silent long-running Slack-origin agent turns to post a brief user-facing progress update.",

  register(api: unknown) {
    const activeRunQueue: ActiveRunQueueApi = {
      queueMessage: (sessionId, text, options) =>
        typeof agentHarness.queueAgentHarnessMessage === "function"
          ? agentHarness.queueAgentHarnessMessage(sessionId, text, options)
          : false,
      resolveSessionId: (sessionKey) =>
        typeof agentHarness.resolveActiveEmbeddedRunSessionId === "function"
          ? agentHarness.resolveActiveEmbeddedRunSessionId(sessionKey)
          : undefined,
    };

    registerSlackTurnPresenceHandlers(Object.assign(api as PluginApi, {
      activeRunQueue,
    }));
  },
});
