# Homebridge TTLock AccessCode — Copilot / AI Assistant Instructions

## Overview

This is a Homebridge plugin (`homebridge-ttlock-accesscode`) that integrates TTLock smart lock access codes with Apple HomeKit. It is written entirely in **TypeScript/Node.js**.

## Architecture

- **Language**: TypeScript, compiled to JavaScript via `tsc`
- **Entry point**: `src/index.ts` (platform registration)
- **Config schema**: `config.schema.json`
- **Build output**: `dist/` directory
- **Package manager**: npm

The plugin communicates with the TTLock cloud API via HTTP to manage access codes on supported smart locks.

## Build & Validation Sequence

```
lint → build → node import test
```

1. `npm run lint` — ESLint check
2. `npm run build` — TypeScript compile
3. Node import test — `await import('./dist/index.js')`

No formal unit tests exist. Validation relies on lint, build, and import checks.

## Branch & PR Model

- **All PRs must target `beta` branch** (except stable-conversion PRs which go `beta → latest`)
- The `latest` branch holds stable/production releases
- Stable releases are promoted from `beta` via a `beta-to-stable` workflow dispatch
- Dependabot PRs targeting `beta` are auto-merged for minor/patch/lockfile updates

## Release Flow

```
feature branch → beta PR → beta merge → draft release updated → publish release → stable conversion PR → latest merge → stable release
```

- On PR merge to `beta`: CHANGELOG.md is updated and a draft GitHub Release is created/updated
- On manual commit push to `beta`: same as above
- On release publish: CHANGELOG.md is finalized, build/lint/test runs, CodeQL runs, npm publish runs, Discord notification sent
- Stable promotion: `workflow_dispatch` on `beta-to-stable.yml` creates a beta→latest PR

## Labels

Enforced via `label-and-validate-pr.yml` and `pr_manager.py`:
- `bug`, `fix`, `enhancement`, `feature`, `breaking-change`, `docs`, `dependency`, `internal`, `workflow`
- At least one classification label required per PR
- `breaking-change` PRs require `BREAKING_CHANGE_EXPLANATION_START` / `BREAKING_CHANGE_EXPLANATION_END` markers with ≥60 char explanation
- Dependabot PRs get: `dependency-major/minor/patch/lockfile` + `auto-merge` (non-major)

## CI Matrix

- Node.js: 20, 22, 24
- Runs on `ubuntu-latest`
- No Python matrix (pure Node.js plugin)

## Scripts (`.github/scripts/`)

All automation scripts are Python 3.13, stdlib-only (no third-party pip packages):
- `common.py` — shared helpers (GitHub API, git ops, npm ops, Context dataclass)
- `release_manager.py` — CHANGELOG.md updates and GitHub Release CRUD
- `release_publish.py` — npm publish + rollback delegation
- `issue_manager.py` — issue classification and validation
- `pr_manager.py` — PR semantic validation
- `beta_to_stable.py` — creates/updates stable conversion PR
- `discord_tools.py` — builds and posts Discord webhook embed (stdlib urllib only, no `requests`)

## Key Constraints for Contributions

- The `detect-fork` action uses a parameterized `repository` input (default: `ZeliardM/homebridge-ttlock-accesscode`)
- Labels JSON is serialized to `/tmp/labels.json` (not `.github/labels.json`)
