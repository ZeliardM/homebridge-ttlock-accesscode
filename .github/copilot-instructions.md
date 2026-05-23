# Homebridge TTLock AccessCode - Copilot / AI Assistant Instructions

## Overview

This is a Homebridge plugin (`homebridge-ttlock-accesscode`) that integrates TTLock smart lock access codes with Apple HomeKit. It also supports optional external HomeKit doors backed by IKEA DIRIGERA open/close sensors. Runtime code is TypeScript/Node.js, and the custom Homebridge configuration UI is plain JavaScript/CSS/HTML under `homebridge-ui/`.

## Architecture

- **Language**: TypeScript, compiled to JavaScript via `tsc`
- **Entry point**: `src/index.ts` (platform registration)
- **Config schema**: `config.schema.json`
- **Custom UI**: `homebridge-ui/public/index.html` and `homebridge-ui/server.js`
- **Build output**: `dist/` directory
- **Package manager**: npm

The plugin communicates with the TTLock cloud API via HTTP to manage access codes on supported smart locks. DIRIGERA hub polling is local to the configured hub and is separate from TTLock polling limits.

## Build & Validation Sequence

```text
lint -> build -> node import test -> package dry run
```

1. `npm run lint` - ESLint check for `src/**/*.ts` and `homebridge-ui/**/*.js`
2. `npm run build` - TypeScript compile
3. Node import test - `await import('./dist/index.js')`
4. Package dry run - verifies `dist`, `config.schema.json`, and `homebridge-ui` are included

No formal unit tests exist. Validation relies on lint, build, import, and package checks.

## Branch & PR Model

- **All PRs must target `beta` branch** (except stable-conversion PRs which go `beta -> latest`)
- The `latest` branch holds stable/production releases
- Stable releases are promoted from `beta` via a `beta-to-stable` workflow dispatch
- Dependabot PRs targeting `beta` are auto-merged for minor/patch/lockfile updates

## Release Flow

```text
feature branch -> beta PR -> beta merge -> draft release updated -> publish release -> stable conversion PR -> latest merge -> stable release
```

- On PR merge to `beta`: CHANGELOG.md is updated and a draft GitHub Release is created/updated
- On manual commit push to `beta`: same as above
- On release publish: CHANGELOG.md is finalized, build/lint/test runs, CodeQL runs, npm publish runs, Discord notification sent
- Stable promotion: `workflow_dispatch` on `beta-to-stable.yml` creates a beta-to-latest PR

## Labels

Enforced via `label-and-validate-pr.yml` and `pr_manager.py`:
- `bug`, `fix`, `enhancement`, `feature`, `breaking-change`, `docs`, `dependency`, `internal`, `workflow`
- At least one classification label required per PR
- `breaking-change` PRs require `BREAKING_CHANGE_EXPLANATION_START` / `BREAKING_CHANGE_EXPLANATION_END` markers with at least a 60 character explanation
- Dependabot PRs get: `dependency-major/minor/patch/lockfile` + `auto-merge` (non-major)

## CI Matrix

- Node.js: 22, 24
- Runs on `ubuntu-latest`
- No Python matrix (pure Node.js plugin)

## Scripts (`.github/scripts/`)

All automation scripts are Python 3.13, stdlib-only (no third-party pip packages):
- `common.py` - shared helpers (GitHub API, git ops, npm ops, Context dataclass)
- `release_manager.py` - CHANGELOG.md updates and GitHub Release CRUD
- `release_publish.py` - npm publish + rollback delegation
- `issue_manager.py` - issue classification and validation
- `pr_manager.py` - PR semantic validation
- `beta_to_stable.py` - creates/updates stable conversion PR
- `discord_tools.py` - builds and posts Discord webhook embed (stdlib urllib only, no `requests`)

## Key Constraints for Contributions

- The `detect-fork` action uses a parameterized `repository` input (default: `ZeliardM/homebridge-ttlock-accesscode`)
- Labels JSON is serialized to `/tmp/labels.json` (not `.github/labels.json`)
