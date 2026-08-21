# Canvas file-drop formats

The editor canvas treats external files as typed import operations. Classification
happens during `dragenter`/`dragover` so the overlay can explain the pending action
before the user releases the files.

## Current formats

| Format | Detection | Multiplicity | Operation |
|---|---|---:|---|
| Image | PNG, JPEG, WebP, or GIF MIME/extension | Many | Append one Image node per successfully processed file |
| Sombra project | `.sombra` extension or `application/x-sombra` MIME | One | Decode and validate, confirm replacement, then load the project |

Image drops use the same `processImageFile()` path as the Image node picker. Files
are processed sequentially to cap peak bitmap memory; every successful result gets
its own node and the whole batch is one undo step. Project drops use the packaged
and legacy `.sombra` reader. Cancellation, invalid input, or failed confirmation
leaves the current graph untouched.

Project confirmation and import errors use the in-app `FileDropDialog`. It
composes the generated Full Window Overlay, Node Info, button, typography, icon,
and color-token primitives so behavior and appearance do not depend on native
browser alert/confirmation UI.

Browsers may temporarily hide filenames for security while a drag is in progress.
Image MIME types can still be identified; an opaque `.sombra` file shows the
neutral “Inspect dropped files” overlay until the browser exposes its filename.
That unresolved drag remains droppable so Sombra can classify it at release.
Sombra downloads use `application/x-sombra`, but operating systems do not always
preserve that browser MIME metadata when the file is later dragged from disk.

## Adding a supported format

1. Add a descriptor to `FILE_DROP_FORMATS` in `src/utils/file-drop.ts`:
   - stable `id`;
   - append/replace operation;
   - multiplicity;
   - MIME types and extensions;
   - overlay icon, tone, preview title, busy title, and detail.
2. Add the importer under the same ID in `FlowCanvas`’s
   `Record<FileDropFormatId, handler>`. The ID union is derived from the descriptor
   array, so TypeScript fails the build if the handler is missing.
3. Put decoding/transcoding in a reusable utility with an injectable boundary.
   The UI handler should only confirm, dispatch, and commit the result to the graph.
4. Extend `scripts/verify-file-drop.ts` with classification, mechanism-engagement,
   partial-failure, and append/replace assertions for the new format.
5. If the format introduces new UI rather than reusing the existing overlay,
   follow the Figma/design-system workflow before adding visual classes.

Mixed-format batches are deliberately rejected. A future format can opt into
multi-file batches, but each accepted drop resolves to exactly one handler and one
graph operation.
