# homebridge-ttlock-accesscode

Homebridge plugin (platform `TTLockAccessCode`) for TTLock locks and their access codes through the TTLock Cloud API, with optional HomeKit doors backed by IKEA DIRIGERA open/close sensors. The owner's own plugin, published on npm. Work on `beta`; `latest` is the stable branch.

## Layout

- `src/platform.ts`: platform. `src/api/`: TTLock and DIRIGERA clients and the API usage tracker. `src/devices/`: HomeKit lock and door accessories.
- `homebridge-ui/`: setup UI (plain JS, HTML and CSS).
- `.github/`: release automation; the workflows call stdlib-only Python 3 scripts in `.github/scripts/`.

## Build and test

```bash
npm run lint    # eslint over src and homebridge-ui, zero warnings
npm run build   # tsc into dist/
node -e "import('./dist/index.js').then(() => console.log('import OK'))"
npm pack --dry-run   # must list dist/, config.schema.json and homebridge-ui/
```

There are no unit tests. CI runs these same checks on Node 22, 24 and 26.

Deploy: `homebridge-deploy --plugin homebridge-ttlock-accesscode` (only after my yes).

## Rules

- Branch from `beta` and target PRs at `beta`. `latest` changes only through the beta-to-stable workflow.
- Start commit messages with a bracketed label: `[enhancement]` or `[feature]`, `[bug]` or `[fix]`, `[breaking-change]`, `[other]`. The release scripts sort changelog entries by it.
- Don't edit `CHANGELOG.md` or bump `version` by hand: the workflows do both.
- Keep the TTLock API usage protection (polling adapts to the monthly call limit) and the door safety block (lock and unlock commands are ignored while the linked door is open, unknown or unavailable).
- The TTLock login, OAuth client ID and secret, and DIRIGERA tokens live in the Homebridge config.
