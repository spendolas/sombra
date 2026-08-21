# Fork intent: shader thumbnail support

This worktree exists to finish the `.sombra` thumbnail flow.

What it was trying to achieve:

- capture a thumbnail from the current shader preview when the user saves a project;
- embed that thumbnail directly into the `.sombra` file, alongside the graph data;
- read the embedded thumbnail back when the file is opened;
- show the thumbnail in the project-open confirmation dialog;
- keep the file self-describing by adding the app build id that wrote it;
- preserve backward compatibility with older `.sombra` files that do not have thumbnails or build metadata.

Why this matters:

- the file itself becomes the source of truth for its preview image;
- users can recognize projects quickly from the open dialog;
- saved files can be traced back to the exact editor build that produced them.

Current scope of the fork:

- save-path thumbnail capture;
- `.sombra` package encoding/decoding;
- open-dialog preview rendering;
- build metadata embedded in exported files.

