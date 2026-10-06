# orca

A tree of nodes on disk, and a viewer that shows it as a force-directed graph. See `design.md` for the spec.

## Requirements

Node 22.18 or later. Node runs the TypeScript directly, so there is no build step.

## Setup

```sh
npm install
npm link            # puts `nodes` on your PATH
nodes init          # creates ~/nodes with the seed tree
nodes check
nodes install-hooks # adds orca's hook to ~/.claude/settings.json (--remove undoes it)
```

The hook runs in every Claude Code session. It records state only when the session's folder is inside `~/nodes`, or inside a path listed in a node's `repo` field. `repo` may be one path or a list:

```yaml
repo:
  - ~/dev/tc/code/workspace/data-collection
  - ~/dev/tc/code/billing-scripts
```

`install-hooks` also installs the `/orca` skill. In a session anywhere, run `/orca` (optionally with a node path or a branch like "under personal") and Claude registers the session with `nodes claim`. A claim beats the folder, and it ends when the Claude process exits.

A session in a nested path attaches to the node with the most specific match. Only sessions that run in tmux get a Terminal button.

Set `NODES_ROOT` to use a root other than `~/nodes`. Set `PORT` to change the server port (default 4317).

## CLI

```sh
nodes new work/vmt-analyzer/data-pipeline --goal "Nightly ingest of counts"
nodes set work/vmt-analyzer --title "..." --goal "..."
nodes mv work/vmt-analyzer work/vmt          # rename, or move under another node
nodes rm work/vmt                            # moves the subtree to <root>/.trash
nodes launch work/vmt                        # start Claude in tmux
nodes launch work/vmt --resume               # reopen the node's last conversation
nodes end orca-work-vmt                      # end a session (tmux name or session id)
nodes claim personal/sourdough              # from inside a Claude session: attach it to a node
nodes claim --auto "..." --scope personal    # same, but let Haiku pick or create the node
nodes tree
nodes check         # exits 1 on errors; warnings do not fail
```

`mv` and `rm` refuse while a session is live anywhere in the subtree.

## Workers

A worker is another machine that runs Claude sessions. This machine reaches it only with `ssh <host>` (for example Tailscale SSH), so the orca server stays on `127.0.0.1`. The worker needs tmux, Node 18 or later, and Claude Code.

```sh
nodes worker add <worker-host>     # copies ~/.orca/bin to the worker and installs its hook
nodes worker ls
nodes worker rm <worker-host>      # removes the worker's hook
nodes launch work/vmt --host my-worker
nodes dispatch work "..." --host my-worker
```

- The server polls each worker over one persistent SSH connection every 5 seconds.
- A worker session shows on the node orca launched it for, or on the node with a matching worker repo, for example `repo: - my-worker:~/code/vmt`.
- A session launched on a worker runs in that repo, or in `~/orca/<node path>`. It gets the node's `CLAUDE.md` chain as a system prompt.
- Trust `~/orca` once on the worker (`cd ~/orca && claude`), so new node folders do not stop at the trust prompt.
- The panel and the Dispatch form have a picker for where a new session runs.

## Server

```sh
npm start           # listens on 127.0.0.1:4317 only
npm test
```

Keep it running with PM2:

```sh
npm install -g pm2
pm2 start bin/orca-server.js --name orca
pm2 save
pm2 startup         # run the command it prints, to start PM2 at boot
```

Expose it to the tailnet (HTTPS, tailnet only):

```sh
tailscale serve --bg 4317
```

Open `https://<machine>.<tailnet>.ts.net/` from another machine on the tailnet.

## Viewer

- Click a node with children to unpack it, or pack it again. Click a leaf, or the root, to open its details.
- The `i` mark on a node opens its details. `Info` in the header opens details for the root.
- Drag a node to move it. Drag the background, or scroll on a trackpad, to pan. Pinch, or use a mouse wheel, to zoom. Press `f` to fit the graph to the screen. Click the background, or press Escape, to close the panel.
- `Set as root` in a node's panel makes it the root. The breadcrumb steps back up. The URL hash holds the root, and the browser remembers it and the unpacked nodes.
- A packed node shows the most urgent state of everything inside it: needs you, new result, working, idle. An unpacked node shows only its own sessions. A result stays new until you open that session.
- The left rail lists every session under the root in the same order. Click one to jump to its node and terminal. The tab title counts what needs you.
- A session stays in the rail while its Claude process runs. End (on hover in the rail, or in the panel) quits it; working sessions need a second click. The conversation stays on disk, and the panel's Resume reopens it.
- A registered session that runs outside tmux has no Terminal button. Use Move into orca in the panel (or `nodes adopt <session id>`). Orca quits that Claude, which saves the conversation, and resumes it in tmux in the same folder. It works only between turns.
- Opening a terminal switches to terminal mode: the session fills the space right of the rail, and rail clicks switch sessions. Esc returns to the map on that session's node. Shift+Esc sends Escape to Claude. ⌘. toggles between the map and the last terminal.
- `New` opens a form to add a child to the root.
- `Dispatch` (or `/`) takes a prompt. A Haiku call picks an existing node or makes a new one under the root, then Claude starts there on the prompt. `nodes dispatch <scope> "<prompt>"` does the same from a shell.
- The panel's Edit, Add child, Move and Delete buttons do the same as `nodes set`, `new`, `mv` and `rm`.
- The panel's Queue button adds tasks to the node's `## Queue` section, one per line. `nodes queue <path> "<task>"` does the same from a shell. The server starts a background worker for each task, 2 at a time. Each worker is a child node, and works in its own git worktree when the node has a repo. When a worker stops, the server merges its branch into your checkout and checks the task off with the result. Workers stay off the rail unless they need you. The orca server must run for the queue to move.
