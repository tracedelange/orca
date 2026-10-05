# Node Tree: Phase 1 Build Spec

## Purpose

This project is the first piece of an attention-first workspace for agent-driven work. The long-term tool will let one person manage several Claude Code sessions across many projects without holding the whole map in their head. The scarce resource it manages is the person's attention, not agents or compute.

Phase 1 builds only the foundation: a hierarchical tree of **nodes** stored on disk, and a web viewer for exploring that tree as nested, zoomable bubbles. No agents are launched or managed in Phase 1. The goal is to find out whether the map itself is useful before any orchestration is built on top of it.

Later phases are described at the end of this document. They are out of scope for this build, but the Phase 1 design must not make them harder.

## Environment

- Runs on a single Linux workstation. The user reaches it over SSH via Tailscale.
- The viewer is opened in a browser on another machine on the same tailnet.
- Single user. No authentication beyond tailnet membership.
- Node 22 and TypeScript throughout.

## Core concepts

**Node.** A durable unit in the tree. It holds context, an optional goal, and notes. A node exists whether or not any work is happening on it.

**Session (future).** An ephemeral Claude Code instance attached to a node to do a bounded piece of work. A node can have zero, one, or several sessions. Sessions are not nodes, and a leaf node is not a session. Phase 1 has no sessions, but this distinction drives the data model.

**Containment is implicit.** There is no container type. A node renders as a container when it has child nodes and as a leaf when it does not. Any node can gain children at any time.

**Goals vary by altitude.** Upper nodes (for example `work`, `personal`) are mostly organizational and may have no goal. Goals matter most at the project level and below. A child may restate, sharpen, or ignore its parent's goal. Nothing enforces inheritance.

## Data model: the filesystem is the database

There is no database. The tree is a directory tree.

- The root directory is configurable. Default: `~/nodes`.
- A **node** is any directory that contains a `CLAUDE.md` file.
- A node's **children** are its immediate subdirectories that are themselves nodes.
- Directories without a `CLAUDE.md` are ignored, along with their contents. Hidden directories (names starting with `.`) and `node_modules` are always skipped.
- A node's identity is its path relative to the root, for example `work/vmt-analyzer`.

### Why CLAUDE.md

When Claude Code starts in a directory, it loads every `CLAUDE.md` from that directory up through its ancestors. Making each node a folder with a `CLAUDE.md` means a future session launched in a node automatically receives that node's context plus the context of every node above it. Hierarchical context costs nothing to implement.

The consequence is that ancestor files are loaded in full into every descendant session. **Organizational nodes must stay short.** The viewer should flag any node with children whose `CLAUDE.md` body exceeds 40 lines (a soft warning, not an error).

### Node file format

Each `CLAUDE.md` has YAML frontmatter followed by a Markdown body.

```markdown
---
title: VMT Analyzer
goal: Ship a contract-ready VMT mitigation model for the first pilot
status: active
repo: ~/code/vmt-analyzer
branch: main
---

## Context
What this node is, why it exists, and anything an agent working here must know.

## Notes
The user's own input: decisions, constraints, open questions, direction.

## Log
- 2026-10-02: Node created.
```

Frontmatter fields:

| Field | Required | Meaning |
|---|---|---|
| `title` | yes | Display name. Falls back to the directory name if missing. |
| `goal` | no | One sentence describing what progress means here. Omit on organizational nodes. |
| `status` | no | One of `idle`, `active`, `waiting`, `done`, `dormant`. Default `idle`. |
| `repo` | no | Path to the code this node works on, if any. |
| `branch` | no | The git branch work happens on, if any. |

Unknown frontmatter fields are preserved and shown in the viewer but otherwise ignored. A file with missing or malformed frontmatter is still a valid node; the viewer shows it with a warning badge rather than dropping it.

In Phase 1 the user sets `status` by hand. In Phase 2, machine-written state (session status, last summary) will move into a hidden `.node/` directory inside each node, so hooks never rewrite `CLAUDE.md`. Do not create `.node/` in Phase 1, but treat the name as reserved.

### Root conventions file

The root `~/nodes/CLAUDE.md` is itself a node (the root of the tree) and also documents the conventions above in plain language: what a node is, the file format, and how to create a child node. Any agent launched anywhere in the tree inherits this file, so every agent knows how to create subnodes without a special API. Keep it under 40 lines.

## Components

### 1. CLI: `nodes`

A small TypeScript CLI, installed globally on the workstation.

- `nodes new <path> [--title "..."] [--goal "..."]` creates the directory (and any missing parents as nodes with only a `title`), writes a `CLAUDE.md` from the template above, and adds a dated "Node created" log line. It refuses to overwrite an existing `CLAUDE.md`.
- `nodes tree` prints the tree to the terminal with status markers.
- `nodes check` validates every node: parse errors, missing titles, unknown status values, oversized organizational nodes. Exits non-zero on errors (not warnings).
- `nodes init` scaffolds the root directory with the root conventions file and the seed tree below, if the root does not exist yet.

The CLI and the server share one module for walking and parsing the tree.

### 2. Server

- A minimal HTTP server. Use Hono or `node:http`; no larger framework.
- Binds to `127.0.0.1` only. It is exposed to the tailnet with `tailscale serve`, so no port is opened on the workstation's other interfaces. Document the exact `tailscale serve` command in the README.
- Endpoints:
  - `GET /api/tree` returns the whole tree as JSON: for each node, its path, title, goal, status, repo, branch, child count, descendant count, warnings, and children. Bodies are not included.
  - `GET /api/node?path=<relative path>` returns one node's frontmatter, raw body, and rendered HTML body.
- Every path parameter is resolved against the root and rejected if it escapes the root. This is the only security-sensitive code in the project; test it.
- The tree is re-read from disk on each request. At the expected scale (tens to low hundreds of nodes) this is fast enough and avoids cache invalidation bugs.
- Serves the static frontend.
- Started under PM2 (or a systemd user unit) so it survives logout and reboot.

### 3. Viewer

A single-page frontend using D3 v7. No React; a build step is acceptable but not required.

**Layout.** Nested circles using `d3.pack`. Each node's circle contains its children's circles. Circle size is based on descendant count (a leaf weighs 1), so bigger subtrees take more room.

**Attention protection is the main design constraint.** At any moment the viewer has one **focus** node. It renders:

- the focus node as the outer circle,
- its immediate children as labeled circles inside it,
- nothing deeper. Grandchildren are not drawn. A child that has children of its own shows a small count badge instead.

The user never sees deep detail unless they step into it.

**Navigation.**

- Clicking a child zooms into it with an animated transition, making it the new focus. Transitions should be smooth (about 500ms) so the user keeps a sense of place.
- Clicking the background, pressing Escape, or clicking a breadcrumb zooms back out.
- A breadcrumb trail at the top shows the path from root to focus.
- The URL hash holds the focused path (for example `#/work/vmt-analyzer`), so views can be bookmarked and the back button works.

**Detail panel.** Selecting a node (single click on a leaf, or a dedicated info control on a container) opens a side panel showing title, goal, status, repo, branch, warnings, and the rendered Markdown body. The panel is read-only. The absolute path to the node's `CLAUDE.md` is shown with a copy button, so the user can open it over SSH.

**Status display.** Each status has a distinct fill: `active` is prominent, `waiting` is the most attention-grabbing, `idle` neutral, `done` muted, `dormant` faded. Never rely on color alone; show the status as a text label or icon as well.

**Refresh.** The viewer polls `/api/tree` every 5 seconds and updates in place without losing the current focus or panel. Polling is chosen over file watching for simplicity; it can be replaced later.

**Theming and layout.** Supports light and dark mode via `prefers-color-scheme`. Usable on a laptop screen; mobile is not a goal.

## Seed tree

`nodes init` creates this example so the viewer has something to show. The user will replace it with real nodes.

```
~/nodes/
  CLAUDE.md                 root conventions
  work/
    CLAUDE.md               organizational, no goal
    vmt-analyzer/
      CLAUDE.md             project node with a goal
  personal/
    CLAUDE.md               organizational, no goal
    meloria/
      CLAUDE.md             project node with a goal
    side-projects/
      CLAUDE.md             organizational
      example-project/
        CLAUDE.md           leaf with a goal and status
  home/
    CLAUDE.md               organizational
    household/
      CLAUDE.md             leaf
```

Seed files contain placeholder text in each section, clearly marked as placeholder.

## Non-goals for Phase 1

- Launching, monitoring, or managing Claude Code sessions.
- Editing nodes from the viewer. All writes go through the filesystem or the CLI, so there is one write path and no conflict with agents writing the same files later.
- Goal roll-ups or progress aggregation.
- A database, accounts, sharing, or multi-user support.
- Notifications.

## Acceptance criteria

1. `nodes init` creates the seed tree, and `nodes check` passes on it.
2. `nodes new work/vmt-analyzer/data-pipeline --goal "..."` creates a valid node that appears in the viewer within one poll cycle, without a page reload.
3. Hand-editing a node's frontmatter (for example setting `status: waiting`) is reflected in the viewer within one poll cycle.
4. At the root view, only the top-level nodes and their badges are visible. No grandchildren are drawn at any focus level.
5. Zooming in and out is animated, the breadcrumb is always correct, and the browser back button returns to the previous focus.
6. A request for `/api/node?path=../../etc/passwd` (and similar escapes) is rejected.
7. Launching `claude` inside `~/nodes/personal/side-projects/example-project` loads that node's `CLAUDE.md` and its ancestors' (verify with `/memory` or `/context` inside Claude Code). This confirms the inheritance assumption the whole design rests on.
8. The server survives a workstation reboot and is reachable over the tailnet via `tailscale serve`.

## Suggested repo layout

```
node-tree/
  src/
    core/        tree walking, frontmatter parsing, validation, path safety
    cli/         nodes command
    server/      HTTP server and API
  web/           viewer (HTML, CSS, D3 code)
  templates/     node template, root conventions file, seed tree
  test/
  README.md      setup, tailscale serve command, PM2 setup
```

## Future phases (context only, do not build)

These explain why Phase 1 is shaped the way it is.

**Phase 2: sessions.** A "launch here" control on a node starts a tmux session running Claude Code in that node's directory, with the node's `repo` added via `--add-dir`. The tmux session is named after the node path. Clicking a node with a live session jumps to it. Claude Code hooks (`Stop` when a response finishes, `Notification` when it is waiting on the user) write session state and a one-sentence status summary into the node's `.node/` directory. The viewer then shows which nodes are working and which are done and waiting, so the user stops polling terminals by hand. The one-sentence summary is the first attack on the main pain point: long phase reports that take minutes to digest when one sentence and a decision would do.

**Phase 3: orchestration.** A project node's session receives a goal from the user and creates its own child nodes and sessions, acting as the point of contact for its subtree. Subnodes report up through their parent rather than interrupting the user directly. The user can promote any subnode to talk to them directly when they want to work at that level of detail. "Bringing a node online" grants it permission to interrupt; offline nodes queue their results. Agents run only when there is concrete work, and write back to the node before exiting, so idle nodes cost no tokens.
