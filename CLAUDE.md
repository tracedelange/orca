# orca

## Development

A checkout runs from source: the bins run the `.ts` files directly when `src/` exists. The published package has no `src/`, so the bins run `dist/`. `npm run build` (and `npm pack`) writes `dist/`.

- First install: `npm install && npm link && orca up`.
- `npm link` links the global `orca` (and its alias `nodes`) to this repository. CLI changes apply immediately.
- The server does not reload. After you change code in `src/server`, `src/core` or `web`, run `orca restart`.
- After you change `package.json` dependencies or `bin` entries, run `npm install && npm link`.
- After you change `templates/skill` or the hook, run `orca install-hooks`.
- Server output goes to `~/Library/Logs/orca.log` (`orca logs`).
- Before you commit, run `npm run typecheck && npm test`.

## Commits and releases

Commit messages must use conventional commits: `<type>(<optional scope>): <summary>`. The `.githooks/commit-msg` hook rejects other messages.

- Use `feat` for a new feature and `fix` for a bug fix. Only these two types go into `CHANGELOG.md` and change the version.
- For other changes, use `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `style` or `revert`.
- If a change breaks the CLI, the hook or the node format, add `!` after the type: `feat!: ...`.
- Do not edit `CHANGELOG.md` or the version in `package.json`. release-please writes them.

release-please keeps a release PR open on GitHub. When the PR merges, CI tags the release and publishes `@tracedelange/orca` to npm.
