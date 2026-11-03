---
name: orca
description: Register this Claude Code session with orca, the node tree in ~/nodes, so it shows on the orca map and sessions rail. Use when the user says "register with orca", "add this to orca", "file this session", "track this in orca", or runs /orca, with or without a node path. Also use in a node when the user asks to "create a map" or "update the map" of its subtree.
---

# Register this session with orca

orca shows Claude sessions on a map of nodes (folders in `~/nodes`, each with a `CLAUDE.md`). This session is outside that tree, so orca cannot see it until you claim a node.

1. If the user named a node path (for example `work/gcp-bill`), run:

   ```sh
   orca claim <path>
   ```

   The node is created if it does not exist.

2. If the user did not name a node, write one or two plain sentences that say what this session is working on, from the conversation so far. Then run:

   ```sh
   orca claim --auto "<your sentences>"
   ```

   To keep the new node under a branch the user mentioned, add `--scope <path>`, for example `--scope personal`.

3. The command prints the node it chose and that node's `CLAUDE.md` chain, root first. Read it. It is the context a session started inside the node would load, including the node's goal.

4. Follow the conventions in that output from now on. In particular, end every reply with one line: `Status: <one sentence on where things stand>`. If you end a turn while you watch a job or wait on a reply, end with `Monitoring: <what you are watching>` instead. When the node's goal is met, commit your work, then end with `Done: <one sentence>` in place of `Status:`. Write documents for the user as Markdown in the node's `docs/` folder, and give their full paths.

5. Tell the user, in one line, which node this session is now attached to.

If `orca` is not found, tell the user to run `npm link` in the orca repository.

# Map of a subtree

Use this section only when the user asks you to create or update a map. The map is `docs/map.drawio` in the node where you work. The orca viewer shows it in the node's panel. The user edits it in draw.io.

1. If `docs/map.drawio` exists, read it first.
2. Read every `CLAUDE.md`, Log, `TODO.md` and `docs/` file in the subtree. Include archived children and `docs/outcomes.md`.
3. Draw one box for each experiment or line of work. Put its title on the first line. Put its result on the second line: worked, failed or open, then one line of detail.
4. Draw an arrow from one box to another when the second piece of work builds on the first. Siblings can have arrows too.
5. Draw each idea that is not started as a box with a dashed border.
6. If the map existed, change only what is new or different. Keep the layout. Keep all boxes, arrows and text that the user added.
7. Add a dated line to the node's Log.

Write the file as uncompressed draw.io XML:

```xml
<mxfile><diagram id="map" name="Map"><mxGraphModel><root>
  <mxCell id="0"/><mxCell id="1" parent="0"/>
  <mxCell id="baseline" value="&lt;b&gt;Baseline model&lt;/b&gt;&lt;br&gt;worked: R² 0.61 on held-out counties" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;" vertex="1" parent="1">
    <mxGeometry x="40" y="40" width="220" height="60" as="geometry"/></mxCell>
  <mxCell id="idea-weather" value="&lt;b&gt;Add weather&lt;/b&gt;&lt;br&gt;idea" style="rounded=1;whiteSpace=wrap;html=1;dashed=1;" vertex="1" parent="1">
    <mxGeometry x="320" y="40" width="220" height="60" as="geometry"/></mxCell>
  <mxCell id="baseline-to-idea-weather" edge="1" source="baseline" target="idea-weather" style="endArrow=classic;html=1;" parent="1">
    <mxGeometry relative="1" as="geometry"/></mxCell>
</root></mxGraphModel></diagram></mxfile>
```

- Colors: worked `fillColor=#d5e8d4;strokeColor=#82b366`, failed `fillColor=#f8cecc;strokeColor=#b85450`, open `fillColor=#fff2cc;strokeColor=#d6b656`. An idea has `dashed=1` and no fill.
- Give each box an id made from its name, for example the child node's folder name. The ids let you find your boxes again on update.
- Lay the work out left to right in the order it happened. Put boxes that build on the same box in one column. Leave 60 px between boxes.
- Use only plain shapes: boxes, arrows and text. Stencil shapes and images need the network.
- Escape `<`, `>`, `&` and `"` inside `value`.
