# The editing workstation — plan of record

**Status: in progress.** This document is the durable record of a feature set
the owner specified in full on 2026-09-09. It exists so the work survives a
context reset: any session picking it up reads this file, checks the phase
table, and continues from the first unfinished row.

---

## What the owner asked for, in their own framing

> "if we imported some geometry and then it got display on a canvas then we [turn]
> on the background map tiles and observed that there is a shift so we will get
> there option like select multiple geometry which need to shift then simply drag
> or pan all that geometry to the position with the help of map tile and then we
> can easily export"

That sentence is the whole product in miniature, and it is worth keeping at the
top of this file because it fixes the priority order. The point is not "add
drawing tools". The point is: **a surveyor can see that their data is in the
wrong place, and fix it, without leaving the tool.** Everything else here
serves that or extends it.

The rest of the request, unpacked:

- Editing tools: scale, undo/redo, draw polygon, draw line, add point, place
  marker, add text, snap, lasso select, ortho.
- Click a geometry on the canvas and see its area, perimeter and vertex count.
- Offset inside or outside, in more than one form.
- Per-layer control: colour, line thickness, line type, rename, lock, visibility.
- A legend generated automatically on export from the layer names and colours.
- A backdrop when the map tiles are out of date: import an image or a PDF,
  georeference it by GCPs, or — for a local grid — by picking two points and
  entering the distance between them. Choose which PDF page holds the map.
- Two levels of layer: the FILES imported (from a ZIP or added individually),
  and, inside whichever file is open, that file's own layers.
- One file on the canvas at a time. Import many, with different CRS; open one,
  edit it, save it, open the next.

---

## The architecture this implies

Three things have to exist before most of the list is buildable, and they are
the reason the phases are ordered the way they are.

### 1. Transforms as replayable commands, not canvas mutations

Dragging a selection is a *translation*, and this codebase already has the right
shape for it: an `EditCommand` describes an INTENT and is replayed against the
full dataset at conversion time. The workspace holds a 5,000-feature preview, so
a transform applied to the preview would export an eighth of a 40,000-parcel
correction. A drag must therefore record `translate by (dx, dy)` — not a list of
moved coordinates — for the same reason a buffer records its distance.

This also gives undo/redo for free: the history engine already reverses
commands.

### 2. A tool mode on the canvas

There are three canvas overlays today (edit, measure, geometry preview) and they
share one `onOverlay` hook, deliberately, so a stale tool cannot keep drawing
over a tab it no longer belongs to. A dozen tools need that to become an
explicit mode with one active tool, an escape that always returns to select, and
a single place that decides what a click means.

### 3. Two-tier layers

The current `LayerViewState` is per queue item and keyed by layer name. The
owner's model is a level above: files are the outer list, and the open file's
layers are the inner one. That is a state-shape change, and everything that
styles, locks or renames a layer depends on it.

---

## Phases

| # | Phase | Delivers | Status |
|---|---|---|---|
| A | Transform operations | translate / scale / rotate as replayable `EditCommand`s, with the CRS and lock gates every other operation honours | ✅ |
| B | Selection model | select one, select many, lasso, select-by-layer — the thing a transform is applied *to* | ✅ |
| C | Canvas tool modes | one active tool, escape to select, shared hit-testing; drag-to-move wired to Phase A | ✅ |
| D | Layer control | line width, line type, rename, extending the existing colour/opacity/lock/visibility | ✅ |
| E | Feature info on click | area, perimeter, vertex count, through `core/measure.ts` so the method is stated | ✅ |
| F | Drawing tools | polygon, line, point, marker, text, with snap and ortho | ✅ |
| G | Backdrop layer | image and PDF under the canvas, georeferenced | ✅ |
| H | Legend on export | generated from layer names and colours | ✅ |
| I | Offset variants | inside, outside, both, per-side | ✅ |
| J | More basemap providers | a switcher across the open providers, plus key-holding services | ✅ |
| K | Digitise from a CSV | build lines and polygons by snapping to imported survey points | ✅ |

Phases A–C are the shift-correction feature. They ship together or the feature
does not exist — and they did.

**All eleven phases are built.** Where each lives:

| Phase | Engine | Interface |
|---|---|---|
| A | `core/geometry-ops.ts` (`translate`, `scale`, `rotate`) | Geometry tools tab |
| B | `core/selection.ts` | Select & move tab |
| C | `ui/tool-canvas.ts` | Select & move tab, canvas toolbar |
| D | `core/layers.ts` (`lineWidthOf`, `lineTypeOf`, `colourOf`) | Layers tab, per row |
| E | `core/measure.ts` (`measureGeometry`) | Select & move tab, "This feature" |
| F | `core/drawing.ts` | Select & move tab, draw tools |
| G | `core/georeference.ts`, `engines/raster/pdf-image.ts`, `ui/backdrop.ts` | Backdrop tab |
| H | `core/legend.ts` | Settings → "Attach a legend" |
| I | `core/geometry-ops.ts` (`OffsetSide`) | Geometry tools → Offset → "Which side" |
| J | `ui/basemap.ts` (`TILE_PROVIDERS`, `TILE_PRESETS`) | Settings → basemap |
| K | `core/drawing.ts` (`pointSnapSources`) | Select & move → "Only snap to imported points" |

---

## Decisions taken up front

### The backdrop, and what a PDF can honestly be

A scanned survey PDF is, almost always, **one raster image in a PDF wrapper**.
Extracting that image needs an object parser and a stream decoder, both of which
are a few hundred lines — and the image itself is usually JPEG or Flate, which
the browser decodes natively through `createImageBitmap`.

A **vector** PDF is a different problem entirely: a full content-stream
interpreter with fonts, paths, clipping and blend modes. That is what pdf.js is,
it is over a megabyte, and it would break R15 (no runtime download) and the
zero-dependency rule together.

**So: a PDF whose page is a wrapped raster image is supported, and a vector PDF
is refused by name with the reason.** That is the honest subset, and it covers
the case the owner described — an old scanned sheet the tiles do not match.

### Georeferencing the backdrop

Two routes, because the owner named two situations:

1. **GCPs.** Three or more control points give a least-squares affine
   (six parameters: scale, rotation, shear and translation in each axis). Two
   points give a similarity transform only — scale, rotation, translation — and
   the difference is worth stating rather than silently fitting whatever is
   possible. The residual at each point is reported, because an affine through
   badly-placed GCPs fits perfectly and is wrong everywhere between them.
2. **Two points and a distance**, for a local grid with no control at all. This
   fixes scale and rotation but NOT absolute position, so the result is placed
   relative to the canvas and the tool must say that it is not georeferenced.

### The map-tile shift is not a datum shift

When a survey looks shifted against OpenStreetMap, the cause is usually one of
three things, and only one of them is fixed by dragging:

- a wrong or missing datum shift (fix the CRS, do not drag);
- an old local grid with no relationship to WGS 84 (drag is legitimate);
- the basemap itself being imprecise (drag is wrong — the survey is right).

The tool cannot tell these apart. So the translate command **records the offset
it applied** and the conversion report states it, rather than quietly baking a
correction into coordinates that were correct.

---

## Added on 2026-09-09, after the first request

### More basemap providers, and the Google question again

The owner named OpenStreetMap, Stadia, Jawg and Carto, and asked again for
Google Earth imagery with a switcher between them.

The open ones differ in what they need:

| Provider | Key needed | Notes |
|---|---|---|
| OpenStreetMap | no | already shipped |
| OpenTopoMap | no | already shipped; contours and relief |
| Carto Positron / Dark Matter | no | attribution required; free tier has usage limits |
| Stadia Maps | **yes** | free developer tier, registration required |
| Jawg Maps | **yes** | free tier, registration required |
| Esri World Imagery | no | the usual free satellite layer, attribution required |

So the switcher carries the keyless ones directly, and the key-requiring ones
as PRESETS that fill in the URL shape and leave a blank for the key. That is
the same mechanism as the custom template already shipped, with the tedious
part filled in.

**Google is reachable through exactly that mechanism and is not a built-in.**
This has now been asked three times, so the reasoning is recorded rather than
repeated: Google's tile endpoints are not licensed for direct use outside the
Maps JavaScript API and the Maps Tile API, and this repository is public and
MIT-licensed. Shipping `mt0.google.com` in it would put every person who
installs the extension in breach of terms they never saw, and would put the
owner's name on the repository that did it. A user who holds a Maps Tile API
key can paste their endpoint into the custom field and use it under the terms
they actually hold — which is the request, satisfied, without the liability.

### Digitising from a CSV

A survey CSV is a list of observed points. The owner wants to draw the boundary
those points describe: click them in order, snapping exactly to each, and close
the ring. That is the drawing tools of phase F plus a snap mode whose targets
are the imported points rather than the geometry being drawn — the important
part being that a digitised vertex is EXACTLY the observed coordinate, not one
within a few pixels of it. Snapping that rounds is worse than no snapping,
because it looks deliberate.

### The basemap needs a network, and says so

Added after the owner wrote: "internet only be use able when available if not
available then Map tile will remain off since it requires internet".

`isOnline()` in `ui/basemap.ts` wraps `navigator.onLine`, which is honest in one
direction and optimistic in the other — false means there is definitively no
route, true only means an interface is up. That asymmetry suits a gate used to
SUPPRESS requests rather than to promise they will succeed.

Offline, `Basemap.usable` is false, the canvas never installs the draw hook, and
no tile request is made at all. Not a request that fails: a failed request is
still a DNS lookup and a connection attempt per tile, sixty-four per pan, which
on a metered or captive connection is real traffic for a layer the user has been
told is off. The `online` event drops the failed tiles and redraws, so it comes
back by itself.

This strengthens R15 rather than qualifying it. Everything except the basemap
already worked with the network disabled; now the basemap does not pretend
otherwise.

## Rules this work must not break

- **R4** — nothing is guessed. A transform records what it did.
- **R8 / R15** — no file bytes leave the machine; the packaged extension works
  with the network disabled. The backdrop is a local file, not a fetch.
- **R16** — input structure equals output structure. Editing must not reorder
  or restructure a delivery.
- **R18** — a detector never repairs. Feature info is read-only.
- **R24** — nothing that changes data happens because a control was already set.
