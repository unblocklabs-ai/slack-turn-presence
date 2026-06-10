# Releasing

Release from a clean `main` checkout after all code changes are merged:

```sh
npm run release -- X.Y.Z
```

## Release Rules

- `main` is the release source of truth.
- npm, the Git tag, the GitHub release, and `main` should point at the same commit.
- Do not publish from an unmerged branch.
- `package.json` and `openclaw.plugin.json` versions must match.
- This package publishes to npm and does not publish to ClawHub by default.

## What The Script Enforces

- clean git worktree
- current branch is `main`
- local `main` matches `origin/main`
- `gh` and npm authentication are available
- target version is new
- package OpenClaw metadata declares `@unblocklabs/slack-turn-presence`
- `npm run check` and `npm test` pass
- tests/builds do not dirty tracked files before the version bump

## Manual Verification

After release, verify:

```sh
git rev-parse main
git rev-parse vX.Y.Z
npm view @unblocklabs/slack-turn-presence version
gh release view vX.Y.Z --repo unblocklabs-ai/slack-turn-presence
```
