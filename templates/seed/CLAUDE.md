---
title: Nodes
---

This directory is a tree of nodes. Every agent started anywhere in it loads this file.

## What a node is
- A node is a directory that contains a `CLAUDE.md`.
- A node's children are its subdirectories that are also nodes.
- Directories without a `CLAUDE.md`, hidden directories and `node_modules` are not nodes.
- A node with children must keep its `CLAUDE.md` to 40 lines or fewer. Every session below it loads the file in full.
- The `.node/` directory inside a node is reserved. Do not create or edit it.

## File format
YAML frontmatter, then Markdown:

    ---
    title: Short name                 (required)
    repo: ~/code/project              (optional)
    branch: main                      (optional)
    ---
    ## Goal       one sentence on what progress means here (optional; omit on organizational nodes)
    ## Context
    ## Notes
    ## Log
    - YYYY-MM-DD: what happened

## Creating a child node
Run `nodes new <path> --title "..." --goal "..."`. The path is relative to this root.
If the CLI is not available, make the directory and write a `CLAUDE.md` in the format above.
When you change a node, add a dated line to its Log.

## Reporting
End every reply with one line: `Status: <one sentence on where things stand>`. The viewer shows it.
