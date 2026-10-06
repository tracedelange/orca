# Orca: Design

## Purpose

Orca is an attention-first workspace for agent-driven work. It lets one person manage many Claude Code sessions across many projects without holding the whole map in their head. The scarce resource that orca manages is the person's attention, not agents or compute.

Orca has two parts:

- A tree of **nodes**, stored as folders on disk.
- A web viewer that shows the tree as a force-directed graph, and shows which sessions need the person.

## Environment

- One machine is the **hub**. The hub holds the node tree, runs the orca server, and runs the viewer in a browser. The hub is a macOS laptop.
- Zero or more other machines are **workers**. A worker runs Claude sessions for the hub. The hub reaches a worker only with `ssh <host>`, for example with Tailscale SSH.
- The hub needs Node 22.18 or later, tmux, and Claude Code. Node runs the TypeScript source directly, so there is no build step.
- A worker needs Node 18 or later, tmux, and Claude Code. A worker runs only plain JavaScript files.
- Orca has one user. It has no accounts and no identity checks.

## Core concepts

**Node.** A durable unit of work in the tree. A node holds context, an optional goal, and notes. A node exists when no work happens on it.

**Session.** One Claude Code process that works on a node. A node can have zero, one, or many sessions. A session is not a node, and a leaf node is not a session.

**Containment is implicit.** There is no container type. A node shows as a container when it has child nodes, and as a leaf when it has none. Any node can get children at any time.

**Goals vary by altitude.** Upper nodes, for example `work` and `personal`, are mostly organizational and often have no goal. Goals matter most at the project level and below. Nothing enforces inheritance of goals.

**State comes from sessions.** A node has no state field that a person sets. Its state is the most urgent state of the sessions in its subtree.

## Data model: the filesystem is the database

There is no database. The node tree is a folder tree.

- The root folder is `~/nodes`. The environment variable `NODES_ROOT` changes it.
- A **node** is a folder that contains a `CLAUDE.md` file.
- The **children** of a node are its immediate subfolders that are nodes.
- Folders without a `CLAUDE.md` are not nodes, and their contents are not read. Hidden folders (names that start with `.`) and `node_modules` are always skipped.
- The identity of a node is its path relative to the root, for example `work/vmt-analyzer`.

### Why CLAUDE.md

When Claude Code starts in a folder, it loads every `CLAUDE.md` from that folder up through its ancestors. Each node is a folder with a `CLAUDE.md`. As a result, a session in a node gets the context of that node and of every node above it. Hierarchical context costs nothing to implement. This behavior was tested with `/memory` in Claude Code.

The ancestor files load in full into every session below them. For this reason, organizational nodes must stay short. `nodes check` gives a warning for a node with children whose `CLAUDE.md` body is more than 40 lines.

Claude Code removes YAML frontmatter before it loads a `CLAUDE.md`. Agents do not see frontmatter fields. For this reason, the goal of a node is in the body, not in the frontmatter.

### Node file format

Each `CLAUDE.md` has YAML frontmatter and then a Markdown body.

```markdown
---
title: VMT Analyzer
repo:
  - ~/code/vmt-analyzer
  - my-worker:~/code/vmt-analyzer
branch: main
---

## Goal
Ship a contract-ready VMT mitigation model for the first pilot.

## Context
What this node is, why it exists, and anything an agent that works here must know.

## Notes
Decisions, constraints, open questions, direction.

## Log
- 2026-10-02: Node created.
```

Frontmatter fields:

| Field | Required | Meaning |
|---|---|---|
| `title` | yes | Display name. If it is missing, the viewer uses the folder name. |
| `repo` | no | One path or a list of paths to the code of this node. A path with a `<worker>:` prefix is a path on that worker. |
| `branch` | no | The git branch for the work, if there is one. |
| `background` | no | `true` on a queue worker node. The map shows its sessions. The rail shows them only when they need you. |

The body sections:

| Section | Meaning |
|---|---|
| `## Goal` | One sentence that says what progress means. Organizational nodes omit it. |
| `## Context` | What the node is and why it exists. Dispatch and claims write the starting prompt here. |
| `## Notes` | The person's input: decisions, constraints, open questions. |
| `## Queue` | A checklist of tasks for background workers. The server runs it (see Queues). |
| `## Log` | Dated lines. Agents add a line when they change the node. |

Unknown frontmatter fields stay in the file, and the viewer shows them. Old `status` and `goal` frontmatter fields are not used. The viewer ignores `status`. If a file has `goal` in its frontmatter, the viewer shows it, and `nodes check` gives a warning that agents cannot see it.

A file with missing or malformed frontmatter is still a valid node. The viewer shows it with an issue count and does not drop it.

### Machine-written state

Orca never writes machine state into `CLAUDE.md`. Machine state is in hidden folders:

| Path | Contents |
|---|---|
| `<node>/.node/sessions/<session-id>.json` | State of each local session on the node. The hook writes it. |
| `<root>/.orca/claims/<pid>.json` | Claims. A claim attaches a Claude process to a node, whatever its folder. |
| `<root>/.orca/workers.json` | The list of workers, with host and name. |
| `<root>/.trash/` | Deleted nodes. Delete moves a node here, so a delete is reversible. |
| `~/.orca/sessions/` on a worker | State of each session on that worker. |

A session file has these fields: `sessionId`, `pid`, `cwd`, `tmux`, `state`, `summary`, `finishedAt`, `updatedAt`. Worker sessions also have `host` and `node`.

### Root conventions file

The root `~/nodes/CLAUDE.md` is the root node. It also explains the conventions in plain language: what a node is, the file format, how to create a child node, and the reporting rule. Every session in the tree loads this file, so every agent knows how to create nodes without a special API. The file is less than 40 lines.

The reporting rule tells agents to end every reply with one line: `Status: <one sentence on where things stand>`. Orca uses this line as the summary of the session.

## Session tracking

### The hook

`nodes install-hooks` adds the orca hook to `~/.claude/settings.json` for six events: `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Notification`, `Stop`, and `SessionEnd`. Other hooks in that file stay. The command keeps a backup at `settings.json.orca-backup`. `nodes install-hooks --remove` removes the orca hook.

The hook runs in every Claude session on the hub. It never fails a session. If it cannot find a node for a session, it does nothing.

The hook finds the node of a session in this order:

1. `ORCA_NODE`. Orca sets this environment variable on every session that it starts.
2. A claim for the Claude process of the session.
3. The folder of the session, when the folder is inside the node tree. The nearest node above the folder wins.
4. A `repo` path of a node that contains the folder. The most specific path wins.

When a session outside the tree starts, the hook adds the `CLAUDE.md` chain of its node to the context of the session. This gives that session the same context as a session inside the node.

### Session states

| Hook event | Session state |
|---|---|
| `UserPromptSubmit`, `PostToolUse` | `working` |
| `Notification` with `permission_prompt`, `elicitation_dialog`, or `agent_needs_input` | `needs-input` |
| `SessionStart`, `Stop` | `ready` |
| `SessionEnd` | The hook removes the session file. |

On `Stop`, the hook records `finishedAt` and takes the last `Status:` line from the reply as the summary.

A session stays live while its Claude process runs. The server removes a session file when its process ID is no longer alive.

### Claims and the orca skill

`nodes install-hooks` also installs the `/orca` skill at `~/.claude/skills/orca/`. In a session in any folder, the skill registers the session with orca:

- If the person names a node path, the skill runs `nodes claim <path>`. The node is created if it does not exist.
- If the person names no node, Claude writes one or two sentences about the session, and the skill runs `nodes claim --auto "<sentences>"`. Placement (see Dispatch) picks or creates the node.

`nodes claim` finds the Claude process above it and writes a claim for that process. It then prints the `CLAUDE.md` chain of the node, so the session learns its goal and the reporting rule. A claim ends when its process exits.

### Moving a session into orca

The viewer can show a terminal only for a session that runs in tmux. A session in a normal terminal window belongs to that terminal app.

"Move into orca" (`nodes adopt <session-id>`) moves such a session into tmux:

1. Orca sends SIGTERM to the Claude process. Claude saves the conversation and exits.
2. Orca starts `claude --resume <session-id>` in tmux, in the same folder, with `ORCA_NODE` set.

The move is possible only when the session state is `ready`, so it never stops a turn.

## Components

### 1. CLI: `nodes`

A TypeScript CLI. `npm link` puts it on the `PATH`.

| Command | What it does |
|---|---|
| `nodes init` | Creates the root folder with the root conventions file and the seed tree, if the root does not exist. |
| `nodes new <path> [--title] [--goal]` | Creates a node. Missing parents become nodes with only a title. It does not overwrite a `CLAUDE.md`. |
| `nodes set <path> [--title] [--goal]` | Changes the title or the goal. Other fields, YAML comments, and the body stay. An empty goal removes the `## Goal` section. |
| `nodes mv <from> <to>` | Moves or renames a node with its subtree. The new parent must be a node. |
| `nodes rm <path>` | Moves a node with its subtree to `<root>/.trash/`. |
| `nodes tree` | Prints the tree with the sessions of each node. |
| `nodes check` | Finds parse errors, missing titles, frontmatter goals, and oversized organizational nodes. It exits with 1 on errors, not on warnings. |
| `nodes launch <path> [--resume] [--host]` | Starts Claude in tmux for a node. `--resume` opens the last conversation of the node. `--host` starts it on a worker. |
| `nodes dispatch <scope> "<prompt>" [--host]` | Places the prompt in the tree and starts Claude on it. |
| `nodes queue <path> ["<task>"]` | Adds a task to the queue of the node. Without a task, it prints the queue. |
| `nodes end <tmux-name or session-id>` | Ends a session on the hub or on a worker. |
| `nodes claim <path>` or `--auto "<text>" [--scope]` | Attaches the current Claude session to a node. The `/orca` skill runs it. |
| `nodes adopt <session-id>` | Moves a session that runs outside tmux into tmux. |
| `nodes worker add <host>`, `rm <host>`, `ls` | Manages workers. |
| `nodes install-hooks [--remove]` | Installs the hook and the `/orca` skill. |

`mv` and `rm` refuse while a local session is live anywhere in the subtree.

The CLI, the server, and the hook use one shared module in `src/core/` for the tree walk, parsing, edits, sessions, and path safety.

### 2. Server

- A minimal HTTP server on `node:http`. There is no framework.
- It binds to `127.0.0.1` only. The default port is 4317. The environment variable `PORT` changes it.
- It reads the tree from disk on each request. At tens to low hundreds of nodes, this is fast and has no cache faults.
- It polls each worker in the background every 5 seconds. A slow or offline worker never delays a request.
- PM2 (`pm2 start bin/orca-server.js --name orca`) keeps it running. After a server change, `pm2 restart orca` loads the new code.

Endpoints:

| Endpoint | What it does |
|---|---|
| `GET /api/tree` | The whole tree as JSON. For each node: path, title, goal, repos, branch, extra fields, issues, child count, descendant count, sessions, and children. No bodies. Worker sessions are on their nodes. |
| `GET /api/node?path=<path>` | One node: fields, sessions, the raw body, the rendered HTML body, and the absolute path of its `CLAUDE.md`. |
| `GET /api/workers` | Each worker with host, name, and the last poll error, if there is one. |
| `POST /api/launch?path=&resume=&host=` | Starts a session. |
| `POST /api/nodes/<op>` | `create`, `update`, `move`, `remove`, `end`, `adopt`, or `dispatch`. Each takes a JSON body. |
| WebSocket `/api/term?session=&host=` | A terminal bridge. It runs `tmux attach` in a pty on the hub, or `ssh -t <host> tmux attach` for a worker. |

Security rules:

- Every path parameter goes through one function that resolves it against the root. The function rejects absolute paths, `..` escapes, and symlinks that leave the root. Tests cover it.
- The write endpoints and the terminal accept only POST or WebSocket requests from the same origin as the page.
- The terminal accepts only a live tmux session on the hub, or a session that the last worker poll reported.
- tmux names and hosts that go to a remote shell must match `[A-Za-z0-9_.-]+`.
- The worker scripts take arguments as JSON on stdin, so no prompt or context goes through a shell.

CAUTION: Do not expose the server with `tailscale serve` on a shared tailnet. The server has no identity checks. Any person on the tailnet can then open a terminal as you.

### 3. Viewer

A single-page frontend with D3 v7 and xterm.js. It has no framework and no build step.

**Layout.** A force-directed graph from `d3.forceSimulation`. Links go from each parent to its children. A radial force puts each depth below the root on its own ring, 165px apart. As a result, each branch takes its own sector and does not interleave with other branches. Repulsion and a collision margin around each circle and its title keep nodes apart. The canvas pans and zooms. Node positions stay the same through each poll, and the layout moves only when the set of visible nodes changes.

**Root.** The graph has one **root** node at a time. Any node with children can be the root. The root is pinned at the center of the free space.

**Node kinds.** The root is a filled disc with an outer ring. A parent is a ring with an inner ring. A leaf is one plain ring. The size of a node comes from the number of its direct children.

**Packed and unpacked nodes.** The graph shows the root, and the children of every unpacked node. A packed parent is filled, hides its subtree, and shows `+N` for its child count. An unpacked parent is a smaller, hollow hub with a `–` mark. When a node is packed, all nodes inside it are packed too. The browser keeps the set of unpacked nodes in local storage.

**Attention protection.** The graph shows only the nodes that the person unpacked. Packed nodes still show the state of what they hide.

**State on the map.** A packed node shows the most urgent session state in its subtree. An unpacked node shows only the state of its own sessions, because its children show theirs. Thus a finished result three levels down shows on the packed node that contains it:

| State | Meaning | Mark |
|---|---|---|
| needs you | A session waits for a permission or an answer. | Red outline and label. Red is used for nothing else. |
| new result | A session finished a turn that the person has not opened. | Heavy solid outline. |
| working | A session runs. | Solid outline. |
| seen | Sessions are live, and the person saw their results. | Thin solid outline. |
| idle | No live sessions. | Dashed outline. |

Each state also has a text label on the rim, so the map does not rely on color alone. Each session is a dot on the rim of its own node. A working dot moves slowly around the rim.

A result stays new until the person opens the terminal of that session. The browser keeps the "seen" record in local storage.

**Sessions rail.** A column on the left lists every session under the root, in this order: needs you, new result, working, seen. Each row shows the node, the summary, the worker name, the path, and the age. A click on a row goes to the node and opens its terminal. The tab title shows the count of sessions that need the person or have new results.

**Navigation.**

- A click on a node with children unpacks it, or packs it again. Its children grow out of it on an arc that faces away from its parent. When a node is packed, its children shrink back into it.
- A drag on the background pans the canvas, and the canvas continues at the release speed, then slows. Trackpad scroll pans. A pinch or a mouse wheel zooms with easing.
- A click on a leaf, or on the root, opens its panel.
- A drag on a node moves it.
- The view fits all visible nodes after the first layout, after each root change, and when the person presses `f`.
- A click on the background, or the Escape key, closes the panel.
- **Set as root**, in the panel of a node with children, makes that node the root.
- The breadcrumb shows the path from the top of the tree to the root. A click on a step makes that step the root.
- The URL hash holds the root path, so bookmarks and the back button work. The browser remembers the last root, and the bare URL opens it.

**Detail panel.** A click on a leaf, or on the `i` mark of a container, opens the panel. The panel shows the title, goal, fields, issues, sessions, and the rendered body. It has a copy button for the path of the `CLAUDE.md`. Its controls:

- Edit, Add child, Move, and Delete do the same as `nodes set`, `new`, `mv`, and `rm`. Delete moves the node to `.trash`.
- Launch and Resume start a session. A picker selects the hub or a worker.
- Terminal, End, and Move into orca act on each session.
- End needs a second click when the session is working or needs the person.

**Header controls.** Info opens the panel for the root. New opens the Add child form for the root. Dispatch, or the `/` key, opens the Dispatch form.

**Terminal mode.** When a terminal opens, it fills the space to the right of the rail. The map, the legend, and the panel step aside. A click on another rail row changes the terminal.

| Key | Action |
|---|---|
| Esc | Back to the map, at the node of the session, with its panel open. |
| Shift+Esc | Sends Escape to Claude, for example to stop a turn. |
| ⌘. | Toggles between the map and the last terminal. |

**Refresh.** The viewer polls `/api/tree` every 5 seconds. It updates in place and keeps the root, the unpacked nodes, the panel, and the open terminal.

**Theme.** Ink on paper in light mode, chalk on slate in dark mode, through `prefers-color-scheme`. Titles use Brygada 1918 and metadata uses Azeret Mono, from Google Fonts. There are no italics. The viewer is for laptop screens.

### 4. Dispatch

Dispatch turns a prompt into a placed node and a running session, with no naming step.

1. The person types a prompt on the root node.
2. One `claude -p` call with Haiku gets the subtree outline and the prompt. It returns a path, a title, and a goal. The call has no tools and no user settings, so no hooks run.
3. If the path is an existing node, orca uses it. If not, orca creates the node and writes the prompt into its Context.
4. Orca starts Claude on the node with the prompt, and the terminal opens.

The placement stays inside the subtree of the root. A placement takes about 8 seconds and costs about 2 cents.

### 5. Workers

A worker runs sessions that the hub shows, streams, and controls. The orca server never listens outside `127.0.0.1`, because the hub pulls everything over SSH.

- `nodes worker add <host>` copies the plain JavaScript files in `src/remote/` to `~/.orca/bin` on the worker. It installs the worker hook in the `~/.claude/settings.json` of the worker and records the worker name.
- The worker hook records every Claude session on the worker in `~/.orca/sessions/`.
- The hub runs `list.mjs` on the worker over one persistent SSH connection. The script returns the live sessions and removes dead ones.
- A worker session goes to the node that orca launched it for. If orca did not launch it, it goes to the node with a matching `<worker>:<path>` repo. Other worker sessions do not show.
- A session that the hub starts on a worker runs in the worker repo of the node, or in `~/orca/<node-path>`. The worker has no node files, so orca passes the `CLAUDE.md` chain with `--append-system-prompt`.
- The hub hook and the worker hook share one plain JavaScript module, `src/remote/state.mjs`, for the state logic.

Do these steps once for each worker:

1. Run `nodes worker add <host>` on the hub.
2. On the worker, run `cd ~/orca && claude`.
3. Trust the folder. Then new node folders under `~/orca` do not stop at the trust prompt.

## Seed tree

`nodes init` creates this example. The person replaces it with real nodes.

```
~/nodes/
  CLAUDE.md                 root conventions
  work/
    CLAUDE.md               organizational, no goal
    vmt-analyzer/
      CLAUDE.md             project node with a goal and a repo
  personal/
    CLAUDE.md               organizational, no goal
    meloria/
      CLAUDE.md             project node with a goal
    side-projects/
      CLAUDE.md             organizational
      example-project/
        CLAUDE.md           leaf with a goal
  home/
    CLAUDE.md               organizational
    household/
      CLAUDE.md             leaf
```

The seed files mark their text as `(placeholder)`.

To make dispatched sessions start without a prompt, trust the root once: run `cd ~/nodes && claude`, then trust the folder. Trust of the root covers every folder below it.

### 6. Queues

A queue lets a node hand a list of tasks to background workers. The manager is a loop in the server that runs every 5 seconds. It is not a Claude session.

The `## Queue` section of a node holds the tasks:

```markdown
## Queue
- [ ] waiting
- [>] running → work/orca/fix-x
- [x] done → work/orca/dark-mode
  Result: the Status line of the worker
- [!] failed → work/orca/rename — the reason
```

1. The manager takes the next waiting task when fewer than 2 tasks of that node are running.
2. One Haiku call returns a folder name, a title, a model (`haiku` or `sonnet`), and the context that the worker needs.
3. The manager creates a child node with `background: true`. The task becomes its goal.
4. If the node has a local git repo, the manager adds a worktree on the branch `orca/<child path>`, in `<child>/.node/worktree`.
5. Claude starts in the worktree with the chosen model, `--permission-mode acceptEdits`, and read access to the whole tree. Edits outside the worktree and shell commands still stop for approval, and the session then shows on the rail.
6. When the worker finishes its turn, the manager commits the worktree and merges the branch into the current branch of the main checkout with `--no-ff`.
7. If the merge succeeds, the manager removes the worktree and the branch, ends the session, and checks the task off with the Status line of the worker.

The worker does not commit and does not run git. The manager does all git work.

If the merge conflicts, the manager aborts it and merges the main branch into the worktree. It sends the worker one prompt to remove the conflict markers. When the worker stops again, the manager commits and merges again. A second conflict fails the task. A merge that git refuses, for example because of uncommitted changes in the main checkout, also fails the task. Git does not overwrite those changes.

A failed task keeps its worktree and its session, so the person can examine them. A worker session that ends before it finishes also fails the task.

The manager keeps the conflict retries in memory. A restart of the server sets a task that was mid-plan back to waiting.

## Not built

- Identity checks on the server.
- `/orca` claims on a worker. A worker has no `nodes` CLI.
- Context for sessions that the person starts by hand on a worker.
- `mv` and `rm` do not see worker sessions, so they do not block a node that has one.
- Goal roll-ups or progress totals.
- Locks between viewer edits and agent writes to the same `CLAUDE.md`.
- Notifications outside the browser tab.
- Mobile layout.
- A queue on a worker. Queue workers run only on the hub.
- A worker that asks a question at the end of its turn counts as finished, and the manager merges what it has.

## Verified behavior

The test suite (`npm test`) and manual tests cover these items:

1. `nodes init` creates the seed tree, and `nodes check` passes on it.
2. A new node from `nodes new` or from the viewer shows in the viewer within one poll, without a page reload.
3. A hand edit of a node file shows in the viewer within one poll.
4. The viewer draws only the root and the children of unpacked nodes.
5. The root, the unpacked nodes, and the breadcrumb survive a reload. The back button returns to the last root.
6. `/api/node?path=../../etc/passwd` and similar escapes get a 400 response. Write and terminal requests from other origins are refused.
7. A session in `~/nodes/personal/side-projects/example-project` loads the `CLAUDE.md` files of that node and of its ancestors.
8. A session outside the tree that matches a `repo` path, or that runs `/orca`, shows on its node with its state and summary.
9. A dispatched prompt creates a node in the right subtree and starts a session on it.
10. A session moved into orca keeps its conversation.
11. A session that the hub launches on a worker shows on its node. Its terminal streams to the hub, and End stops it.
12. Queued tasks run 2 at a time and merge into the main checkout. A forced conflict goes back to the worker once, and then merges with no permission prompt.

## Repo layout

```
orca/
  bin/          entry points: nodes, orca-server, orca-hook
  src/
    core/       tree walk, parsing, edits, sessions, claims, dispatch, queues, workers, path safety
    cli/        the nodes command
    hook/       the hub hook
    server/     HTTP server, API, and terminal bridge
    remote/     plain JavaScript for workers, and the state logic shared with the hub hook
  web/          viewer: HTML, CSS, D3, and xterm code
  templates/    node template, seed tree, and the /orca skill
  test/
  README.md     setup, CLI, workers, and viewer
  design.md     this file
```

## Future work

These items explain the shape of the current design.

**Orchestration.** A project session gets a goal from the person, then creates its own child nodes and sessions. It is the point of contact for its subtree. Child sessions report through their parent, not directly to the person. The person can promote any child node to talk to them directly. Agents run only when there is concrete work, and they write back to the node before they exit, so idle nodes cost no tokens.

**Attention controls.** "Bringing a node online" lets it interrupt the person. Offline nodes queue their results until the person looks.
