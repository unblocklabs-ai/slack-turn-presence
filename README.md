# Slack Turn Presence

Nudges silent long-running Slack-origin OpenClaw turns to send a brief user-facing progress update.

This plugin is for OpenClaw installations that receive interactive agent turns from Slack and want long-running work to produce occasional visible progress instead of leaving the Slack thread silent.

It does not call Slack APIs, poll Slack typing/thinking UI, or fabricate a Slack message itself. It observes Slack-origin OpenClaw turns, tracks successful user-visible outbound messages, and nudges the running agent after configured silence. The normal agent reply path decides whether and how to post an update.

Delivery order:

1. Best-effort active-run steering through OpenClaw's agent-harness queue helper.
2. Durable `api.session.workflow.enqueueNextTurnInjection(...)` fallback only when an active run was resolved but live steering declined the nudge.

If no active run is resolved, the plugin declines and closes the tracked turn instead of injecting into a later prompt. This avoids stale progress nudges after a turn has already completed.

## Install

Install from npm:

```sh
openclaw plugins install npm:@unblocklabs/slack-turn-presence
```

Then restart the OpenClaw gateway process so the startup hook registration is loaded.

This package is npm-only by default. It does not publish to ClawHub unless the release metadata is changed in a future version.

## Requirements

- Node.js `>=22`
- OpenClaw `>=2026.4.22`
- A configured Slack channel in OpenClaw
- A runtime that exposes OpenClaw's active agent-run steering surface for live nudges

No Slack bot token or Slack app permission is required by this plugin beyond the Slack channel setup already used by OpenClaw.

## Configuration

All settings are optional. Defaults:

```json
{
  "enabled": true,
  "channels": ["slack"],
  "initialDelayMs": 180000,
  "repeatMs": null,
  "maxNudgesPerTurn": 1,
  "minObservedActivityBeforeNudge": 1,
  "nudgeText": "You are still running in Slack and the user has not seen an update for about 3 minutes. If work is continuing, send a brief user-facing progress update via the normal user-facing message path and keep working. Do not stop solely because of this nudge."
}
```

Options:

| Key | Default | Description |
| --- | --- | --- |
| `enabled` | `true` | Enables or disables the plugin. |
| `channels` | `["slack"]` | Channel names eligible for tracking. Leave as `["slack"]` for normal use. |
| `initialDelayMs` | `180000` | Silence window before the first nudge. |
| `repeatMs` | `null` | Optional repeat interval after the first nudge. `null` disables repeats. |
| `maxNudgesPerTurn` | `1` | Maximum nudges per tracked turn. Set `0` to disable nudges without disabling registration. |
| `minObservedActivityBeforeNudge` | `1` | Minimum observed activity count before nudging. The inbound Slack message counts as one. |
| `nudgeText` | progress-update instruction | Text queued into the running agent or next prompt fallback. |

Example plugin-local config:

```json
{
  "plugins": {
    "entries": {
      "slack-turn-presence": {
        "config": {
          "initialDelayMs": 180000,
          "maxNudgesPerTurn": 1
        }
      }
    }
  }
}
```

## Behavior

The plugin starts tracking when OpenClaw emits `message_received` for an interactive Slack-origin session. It resets the silence timer after successful `message_sent` events for the same canonical `sessionKey`.

At the silence threshold, it tries to queue the nudge into the active agent run. If that live queue accepts the message, the agent can send a normal progress reply through OpenClaw's usual outbound path.

If an active run is resolved but the live queue declines, the plugin may enqueue a durable next-turn injection through OpenClaw's workflow API. If no active run is resolved, it declines and closes the tracked turn. That conservative behavior prevents stale progress prompts from appearing in a later user turn after work has already finished.

## Hook Surface

The plugin registers:

- `message_received` to start tracking interactive Slack-origin turns
- `message_sent` to reset the silence timer after successful visible delivery
- `gateway_stop` to clean up timers

It intentionally does not register `message_sending` or `reply_payload_sending`, so Slack route and thread delivery behavior stays with OpenClaw core.

The plugin also avoids conversation-content hooks by default, so it does not require `plugins.entries.slack-turn-presence.hooks.allowConversationAccess`.

## Package Validation

```sh
npm run check
npm test
npm run preflight
```

## Releasing

Use the guarded release script from a clean `main` git checkout after changes are merged:

```sh
npm run release -- X.Y.Z
```

See [RELEASING.md](./RELEASING.md).

This local release flow publishes to npm and creates a GitHub release. It requires the GitHub repository and npm package ownership to be configured before running.

## Limitations

- Active-run steering uses OpenClaw's experimental agent-harness queue helper. The public helper reports immediate queue eligibility, not later async runtime rejection.
- The durable fallback reaches the next prompt/context boundary exposed by OpenClaw; it is not a direct Slack post and is not used when no active run can be resolved.
- Outbound delivery hooks currently correlate by canonical `sessionKey`, not guaranteed per-turn `runId`, because OpenClaw may omit `runId` from `message_sent`.
- By default, cron, background, maintenance, heartbeat, scheduled, and system-triggered runs are ignored.
