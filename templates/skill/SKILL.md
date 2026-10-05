---
name: orca
description: Register this Claude Code session with orca, the node tree in ~/nodes, so it shows on the orca map and sessions rail. Use when the user says "register with orca", "add this to orca", "file this session", "track this in orca", or runs /orca, with or without a node path.
---

# Register this session with orca

orca shows Claude sessions on a map of nodes (folders in `~/nodes`, each with a `CLAUDE.md`). This session is outside that tree, so orca cannot see it until you claim a node.

1. If the user named a node path (for example `work/gcp-bill`), run:

   ```sh
   nodes claim <path>
   ```

   The node is created if it does not exist.

2. If the user did not name a node, write one or two plain sentences that say what this session is working on, from the conversation so far. Then run:

   ```sh
   nodes claim --auto "<your sentences>"
   ```

   To keep the new node under a branch the user mentioned, add `--scope <path>`, for example `--scope personal`.

3. The command prints the node it chose and that node's `CLAUDE.md` chain, root first. Read it. It is the context a session started inside the node would load, including the node's goal.

4. Follow the conventions in that output from now on. In particular, end every reply with one line: `Status: <one sentence on where things stand>`.

5. Tell the user, in one line, which node this session is now attached to.

If `nodes` is not found, tell the user to run `npm link` in the orca repository.
