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
- Lock and unlock are answered to HomeKit at once and sent in the background within a time limit counted from the HomeKit request. Access-code adds and deletes are answered when done and are not sent once HomeKit's 9 s have passed; one already sent is left to finish (never aborted), even past the 9 s.
- Never resend `keyboardPwd/add` or `keyboardPwd/delete` after a failure TTLock may have acted on; read the list again instead.
- Requests through a gateway go one at a time through the gateway queue; a poll skips instead of waiting for it.
- Polls, and discovery once one has completed, must not use the API calls kept in reserve for HomeKit requests.
- Never stop polling a lock because its polls fail; it shows No Response until a poll succeeds.
- Keep each access code's HomeKit identifier stable; the identifiers are stored in the accessory context.
- Never log the client secret, password, tokens or access codes.
- `src/api/ttlockApi.ts` is also loaded on its own by `homebridge-ui/server.js`; it must not import platform or device code except as types.
- Clean up timers, intervals and in-flight requests on shutdown.
