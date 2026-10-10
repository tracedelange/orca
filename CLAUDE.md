# orca

## Development

The code runs from source. There is no build step: node runs the `.ts` files directly.

- First install: `npm run setup`. It runs `npm install`, `npm link`, `orca install-hooks` and `orca start`.
- `npm link` links the global `orca` (and its alias `nodes`) to this repository. CLI changes apply immediately.
- The server does not reload. After you change code in `src/server`, `src/core` or `web`, run `orca restart`.
- After you change `package.json` dependencies or `bin` entries, run `npm install && npm link`.
- After you change `templates/skill` or the hook, run `orca install-hooks`.
- Server output goes to `~/Library/Logs/orca.log` (`orca logs`).
- Before you commit, run `npm run typecheck && npm test`.
