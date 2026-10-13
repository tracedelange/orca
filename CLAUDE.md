# orca

## Development

A checkout runs from source: the bins run the `.ts` files directly when `src/` exists. The published package has no `src/`, so the bins run `dist/`. `npm run build` (and `npm pack`) writes `dist/`.

- First install: `npm install && npm link && orca install-hooks && orca start`.
- `npm link` links the global `orca` (and its alias `nodes`) to this repository. CLI changes apply immediately.
- The server does not reload. After you change code in `src/server`, `src/core` or `web`, run `orca restart`.
- After you change `package.json` dependencies or `bin` entries, run `npm install && npm link`.
- After you change `templates/skill` or the hook, run `orca install-hooks`.
- Server output goes to `~/Library/Logs/orca.log` (`orca logs`).
- Before you commit, run `npm run typecheck && npm test`.
