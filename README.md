<p align="center">
  <img src="web/orca.svg" width="112" alt="The orca icon">
</p>

<h1 align="center">orca</h1>

<p align="center">One map for all of your Claude Code sessions, and one place that tells you which session needs you now.</p>

---

## Why orca

When you run one agent, you watch one terminal. When you run ten agents on six projects, you lose track. A session waits for an answer in a tab that you closed. A result sits unread for an hour. You forget which project a session is for.

Agents and compute are not the scarce resource. Your attention is the scarce resource. Orca manages your attention.

Orca keeps your work as a tree of **nodes**: one folder for each area, project, or task. Each Claude Code session attaches to a node. The viewer shows the tree as a live map. A node that needs you is easy to see, and the rail lists every session from most urgent to least urgent.

Orca adds no database and no new file format:

- The tree is a folder tree in `~/nodes`. Each node is a folder with a `CLAUDE.md` file.
- Every session in a node reads the `CLAUDE.md` chain above it, so each agent knows its goal and its context.
- You can edit the tree with your editor, with `git`, or with the `orca` CLI.

See `design.md` for the full specification.

## How it works

| Part | What it does |
|---|---|
| **Nodes** | Folders with a `CLAUDE.md` file. A node holds a title, an optional goal, notes, and a log. |
| **Hook** | A Claude Code hook. It records the state of each session: working, needs you, or ready. |
| **Server** | A local server on `127.0.0.1:4317`. launchd starts it at login and restarts it after a crash. |
| **Viewer** | A web page with the map, the session rail, node details, and a terminal for each session. |
| **Workers** | Other machines that run sessions for this machine, over `ssh`. |
| **Queues** | Task lists on a node. Background sessions do the tasks in git worktrees, and the server merges the results. |

## Requirements

- macOS. The server runs under launchd.
- Node 22.18 or later. Node runs the TypeScript source directly, so there is no build step.
- tmux.
- Claude Code.

## Installation

1. Clone the repository:

   ```sh
   git clone https://github.com/tracedelange/orca.git
   cd orca
   ```

2. Install orca and start the server:

   ```sh
   npm run setup
   ```

   This command runs `npm install`, `npm link`, `orca install-hooks`, and `orca start`.

3. Make the node tree in `~/nodes`:

   ```sh
   orca init
   ```

4. Open the viewer:

   ```sh
   orca open
   ```

`npm link` puts `orca` on your PATH. `nodes` is an alias for `orca`. To remove the hook from `~/.claude/settings.json`, run `orca install-hooks --remove`.

### Settings

| Variable | Default | What it changes |
|---|---|---|
| `NODES_ROOT` | `~/nodes` | The root folder of the node tree. |
| `PORT` | `4317` | The port of the server. Set it before `orca start`. |

## The server

```sh
orca start          # installs ~/Library/LaunchAgents/com.orca.server.plist and starts the server
orca stop           # stops the server and removes the plist, so it does not start at login
orca restart        # use this after you change server code
orca status
orca open           # opens the viewer in the browser
orca logs           # follows ~/Library/Logs/orca.log
```

To run the server in the foreground, run `npm start`.

### Open the viewer from other machines

The server listens on `127.0.0.1` only. To open the viewer from other machines on your tailnet, use Tailscale:

```sh
tailscale serve --bg 4317
```

Then open `https://<machine>.<tailnet>.ts.net/`.

## How sessions attach to nodes

The hook runs in every Claude Code session. It records state only when the folder of the session is inside `~/nodes`, or inside a path in the `repo` field of a node. `repo` can be one path or a list:

```yaml
repo:
  - ~/dev/tc/code/workspace/data-collection
  - ~/dev/tc/code/billing-scripts
```

A session in a nested path attaches to the node with the most specific match.

`install-hooks` also installs the `/orca` skill. You can use it in a session in any folder. Run `/orca`, with a node path or without one, and Claude registers the session with `orca claim`. A claim has priority over the folder. The claim ends when the Claude process stops.

Only sessions that run in tmux get a Terminal button.

## CLI

```sh
orca new work/vmt-analyzer/data-pipeline --goal "Nightly ingest of counts"
orca set work/vmt-analyzer --title "..." --goal "..."
orca mv work/vmt-analyzer work/vmt          # rename, or move under another node
orca rm work/vmt                            # moves the subtree to <root>/.trash
orca launch work/vmt                        # start Claude in tmux
orca launch work/vmt --resume               # reopen the last conversation of the node
orca dispatch work "..."                    # let Haiku pick or make a node under work, then start Claude
orca queue work/vmt "..."                   # add a task to the queue of the node
orca end orca-work-vmt                      # end a session (tmux name or session id)
orca claim personal/sourdough               # from inside a Claude session: attach it to a node
orca claim --auto "..." --scope personal    # the same, but let Haiku pick or make the node
orca tree
orca check                                  # exits 1 on errors; warnings do not fail
orca help
```

`mv` and `rm` stop with an error while a session is live in the subtree.

## Workers

A worker is another machine that runs Claude sessions. This machine reaches it only with `ssh <host>`, for example with Tailscale SSH. Thus, the orca server stays on `127.0.0.1`. The worker needs tmux, Node 18 or later, and Claude Code.

```sh
orca worker add <worker-host>     # copies ~/.orca/bin to the worker and installs its hook
orca worker ls
orca worker rm <worker-host>      # removes the hook of the worker
orca launch work/vmt --host my-worker
orca dispatch work "..." --host my-worker
```

- The server polls each worker every 5 seconds, over one persistent SSH connection.
- A worker session shows on the node that orca launched it for. If orca did not launch it, it shows on the node with a matching worker repo, for example `repo: - my-worker:~/code/vmt`.
- A session that orca launches on a worker runs in the repo of the node, or in `~/orca/<node path>`. It gets the `CLAUDE.md` chain of the node as a system prompt.
- Trust `~/orca` one time on the worker (`cd ~/orca && claude`). Then new node folders do not stop at the trust prompt.
- The panel and the Dispatch dialog have a picker for the machine that runs a new session.

## The viewer

### The map

- Click a node with children to unpack it or to pack it again. Click a leaf, or the root, to open its details.
- The `i` mark on a node opens its details. `Info` in the header opens the details of the root.
- Drag a node to move it. Drag the background, or scroll sideways, to pan. Scroll up or down, or pinch, to zoom. Press `f` to fit the graph to the screen.
- Click the background, or press Escape, to close the panel.
- `Set as root` in the panel of a node makes it the root. The breadcrumb goes back up. The URL hash holds the root. The browser remembers the root and the unpacked nodes.
- A packed node shows the most urgent state in its subtree: needs you, new result, working, or idle. An unpacked node shows only its own sessions.

### The rail

- The rail on the left lists every session under the root.
- Working sessions are in a section at the top. The other sessions follow, from most urgent to least urgent.
- "Needs you" and "new result" use the accent color. Seen sessions are gray.
- A result stays new until you open its session. The server keeps this record, so all of your devices agree.
- The tab title shows the number of sessions that need you.
- A session stays in the rail while its Claude process runs. End (on hover in the rail, or in the panel) stops it. A working session needs a second click. The conversation stays on disk, and Resume in the panel opens it again.

### Terminals

- When you open a terminal, the viewer goes into terminal mode. The session fills the space to the right of the rail, and a click in the rail changes the session.
- Esc goes back to the map, on the node of that session. Shift+Esc sends Escape to Claude. ⌘. changes between the map and the last terminal.
- A registered session that runs outside tmux has no Terminal button. Use Move into orca in the panel, or `orca adopt <session id>`. Orca stops that Claude process, which saves the conversation. Then orca resumes the conversation in tmux, in the same folder. This works only between turns.

### Actions

- **Dispatch** (⌘K from anywhere, or `/` on the map) opens a dialog for a prompt. Haiku picks a node anywhere in the tree, or makes a new one. Then Claude starts there on the prompt.
- **New** opens a form to add a child to the root.
- **Edit**, **Add child**, **Move**, and **Delete** in the panel do the same work as `orca set`, `new`, `mv`, and `rm`.
- **Queue** in the panel adds tasks to the `## Queue` section of the node, one task on each line. The server starts a background session for each task, 2 at a time. Each background session is a child node. If the node has a repo, the session works in its own git worktree. When the session stops, the server merges its branch into your checkout and marks the task as done. Background sessions stay off the rail unless they need you. The queue moves only while the server runs.

## Development

The CLI runs from this checkout, so CLI changes apply immediately. After you change server code, run `orca restart`. `CLAUDE.md` gives the full development loop.

```sh
npm run typecheck
npm test
```
