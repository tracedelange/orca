Consolidate the subtree under this node ({{path}}). Refine its children into a cleaner structure. Do not merge them all into this node.

Work bottom-up: consolidate the deepest nodes first, then use what you learned from them at each level above.

Sort each node into one of four classes and take that class's action:
- Dead: no Log line in 30 days, no session, Goal unmet. Copy anything worth keeping to its parent, then archive it.
- Stub: placeholder Context and Notes, and the Log holds only "Node created". Add one line to its parent's TODO.md, then archive it.
- Completed: Goal met, or the Log says the work is done. Write the outcome to its parent's Notes or docs/, then archive it.
- Long-running: recent Log lines, or a live or parked session. Keep it. Shorten its Log into Context. Move it under a new group node if one fits.

Rules:
- Never delete a node. To archive one, run `orca set <path> --archived`. Archiving a node archives its subtree.
- Leave these nodes alone, because a session is live on them: {{live}}
- To move a node, use `orca mv <from> <to>`. To create a group node, use `orca new`.
- Change only files inside this node's folder. The user accepts or rejects everything under it as one change.
- Do not commit.
- A parent CLAUDE.md with children must stay at 40 lines or fewer.

Steps:
1. Read every CLAUDE.md in the subtree.
2. Write your proposal to docs/consolidation-{{date}}.md in this node. Give one row per node with its path, class, action and reason. List each move on its own line.
3. Stop and ask the user to review the proposal. Change nothing else until they approve it.
4. Apply the approved proposal. Add a dated Log line to every node you change.
5. End your reply with a `Done:` line. The user then reviews the changes and accepts or rejects them in the viewer.
