# Trial feedback — inspection register

Everything in `1_Trial_Feedback_Files`, `2_Trial_Feedback_Files`,
`3_Trial_Feedback_Files` and `4_Trial_Feedback_Screenshorts`, inspected file by
file against the code as it stands at v1.11.12. Nothing here is a guess: every
row was reproduced against the current pipeline or read out of the delivered
bytes.

**Status key** — `OPEN` still broken today · `FIXED` corrected, in code that is
on this branch · `PINNED` a regression test now holds it · `UX` works but reads
as broken · `NOTE` observation, no change proposed.

**Every row in this register is now closed.** The statuses below were written
during the inspection and have been updated as each was executed — nothing here
says `OPEN`.

---

## What was trialled

| Folder | Source | Size | Exports |
|---|---|---|---|
| 1 | `RAM_Pakhar-115.13 Ha Entity LMS Final Data.dxf` | 3.9 MB, 76 features, **no CRS declared** | GeoJSON ×12 (same file, re-downloaded) |
| 2 | `PKR_CADASTRAL_MAP.kmz` | 567 kB, 1,025 features, **EPSG:4326** | 10 formats |
| 3 | `Pakhar-A 115.13 Ha Boundary Pillars.csv` | 6 kB, 188 survey points | 17 formats |
| 4 | 23 screenshots of the running extension | — | — |

---

## F1 — Survey CSV with a title row swaps easting and northing `FIXED` `CRITICAL`

The source file is an ordinary survey deliverable:

```
Pakhar-A 115.13 Ha Boundary Pillars,,,      ← title row
Sl No,NORTHING,EASTING,Code                  ← the real header
1,2605201.531,256320.247,BP1
```

The reader takes **line 1** as the header. The real field names are never seen,
so the columns become `Pakhar-A 115.13 Ha Boundary Pillars`, `Column 2`,
`Column 3`, `Column 4` — and with no `NORTHING`/`EASTING` to match on, it falls
back to position: **column 2 → X, column 3 → Y**.

Reproduced against current code:

```
FIRST COORD: [2605201.531, 256320.247]   ← northing in the X slot
EXPECTED   : [256320.247, 2605201.531]
```

**Every one of the 17 delivered formats carries the swap** — GeoJSON, DXF, WKT
(`SRID=32645;POINT(2605201.531 256320.247)`), GML, KML, shapefile, LandXML, all
of them. The points land ~2,600 km east of where they belong: in the Bay of
Bengal rather than in Madhya Pradesh.

The tool is not silent — it raises `CSV_SCHEMA_UNCONFIRMED` and
`TABLE_ROWS_SKIPPED` — but it still writes 17 confidently wrong files.

**To do**
1. Skip leading rows that are not a header (all-empty trailing cells, a single
   filled cell, no numeric row beneath) and find the real header.
2. Match `NORTHING`/`EASTING`/`N`/`E`/`Y`/`X` by NAME before ever falling back
   to column position.
3. When the mapping is positional rather than named, **refuse or block** rather
   than warn: a coordinate table whose axes were guessed is the one case where
   a wrong answer is indistinguishable from a right one.
4. Regression test built from this exact file.

---

## F2 — Format detection scores this CSV at 35% `FIXED` `HIGH`

The same title row drops CSV detection below the confidence floor, so the
conversion throws `FORMAT_UNCONFIRMED` and the user must pick the format by
hand. A four-column survey CSV is the commonest input this tool will ever see.

**To do** — score a table on its DATA rows rather than only its first line, so a
title row costs a little confidence instead of most of it.

---

## F3 — Basemap and terrain ignore an assumed CRS `FIXED` `HIGH`

Screenshots 1125–1144 (the DXF, **CRS not declared**, source CRS assigned as
EPSG:32645 in Settings):

- canvas caption reads `UTM 45N (assumed)` — the assignment is honoured here
- **no tiles draw at all**, and the readout stays `Terrain —`

Screenshots 1145–1147 (the KMZ, CRS **declared** EPSG:4326):

- tiles draw, and the readout reads `Terrain 1070.0 m`

Cause: `renderPreview` resolves `declared ?? assumed` for the caption, but
`attachBasemap` reads `dataset?.crs ?? ui.georefSession?.targetCrs ?? null` —
the **assumed CRS is not in that chain**. A DXF almost never declares a CRS, so
this is the normal case for CAD work, not an edge case.

Worse, no badge appears explaining it, so the basemap looks broken rather than
unplaceable.

**To do** — feed the same resolved CRS to the basemap that the caption uses, and
make sure the "no placeable CRS" badge actually shows when it is genuinely
absent.

---

## F4 — A target CRS set for one file silently breaks the next `FIXED` `HIGH` `UX`

Screenshots 1146–1147: `PKR_CADASTRAL_MAP.kmz` → KML shows **`failed`** with
`Retry 1 failed`.

The reason is correct and the message is accurate:

> KML stores coordinates in EPSG:4326 — WGS 84, but the data is in
> EPSG:32645 — WGS 84 / UTM zone 45N. … → Clear the target CRS to let KML use
> EPSG:4326, or choose a format that carries its own CRS.

Reproduced: `kml` + `targetCrs: 32645` throws `TARGET_CRS_NOT_STORABLE`.

The refusal is right. The problem is that the target CRS was set while working
on the **DXF**, is a **global setting**, survived the file swap, and the only
remedy offered is prose telling the user to go and find a control.

**Done**

1. **A button in the refusal.** `workspace/remedies.ts` maps an error code to a
   remedy that needs no judgement; `messageBlock` grew an optional button, and
   the inspector's error block offers it. For `TARGET_CRS_NOT_STORABLE` it reads
   *"Clear the target CRS (EPSG:32645) and convert again"* — it names the code,
   so the user recognises the setting as one they made for another file — and it
   clears the setting and re-runs that file in one click.
2. **The same problem, said before the conversion.** The CRS panel now warns as
   soon as the chosen target format cannot store the chosen target CRS, with the
   same button (minus the re-run — nothing has failed yet). That is the half
   that matters: the refusal is now the fallback, not the first the user hears
   of it.

Deliberately NOT done: scoping the target CRS per file. It is one global setting
on purpose — a 200-file batch reprojecting to one grid is the common case, and
per-file CRS would make that twenty minutes of clicking. The warning above
addresses the carry-over without breaking the batch.

No remedy is offered for `CRS_REQUIRED`, the other cause of the same refusal:
the only fix there is a CRS the tool refuses to invent (R4), and a button that
guessed a UTM zone would be the guess wearing a click.

**Verified** in headless Chromium on the built bundle, not only in unit tests:
CSV → KML with source and target both EPSG:32645 shows the warning on the CRS
panel, the conversion is refused with the button, and pressing it clears the
setting and takes the file to `pass with warnings` → KML.

---

## F5 — The canvas credit runs under the bottom-left controls `FIXED` `MEDIUM`

Screenshots 1125, 1128, 1133, 1145: `Imagery © Esri, Maxar, Earthstar
Geographics and the GIS User Community` is drawn right-aligned across the canvas
floor and passes **behind** the basemap button, the coordinate readout and the
Terrain box.

I fixed the credit-vs-CRS-caption collision in v1.11.12 by stacking the bands,
but only considered the bottom-**right** corner. A long attribution on a narrow
canvas reaches far enough left to reach the other cluster. A clipped attribution
is a licence problem, not a cosmetic one.

**To do** — lift the bottom-left overlay clear of the credit band as well, or
cap the credit's width and keep the full list under *Sources & APIs*.

---

## F6 — GeoJSON declared EPSG:32645 while holding degrees `FIXED` `PINNED`

The delivered `PKR_CADASTRAL_MAP_converted_to_geojson.geojson` declares
`urn:ogc:def:crs:EPSG::32645` and **all 62,111 of its coordinates are degrees**
(`84.594, 23.544`). The file lies about its own CRS.

Current code is correct — same input and target now gives
`[254374.143, 2605788.719]` with a `CRS_TRANSFORMED` warning. The delivered file
came from a build predating the fix.

**Done** — `trial-feedback.test.ts` converts the operator's own KMZ and checks
the label and the magnitudes TOGETHER, in both directions: declaring EPSG:32645
must come with six-digit eastings and seven-digit northings, and declaring
nothing (RFC 7946) must come with degrees. Checking either alone is what let the
delivered file out.

---

## F7 — DXF written in degrees `FIXED` `PINNED`

`PKR_CADASTRAL_MAP_converted_to_dxf.dxf` has `firstX = 84.594` — longitude in
the X ordinate, the defect fixed in PR #77.

Current code on the same file: `firstX = 254348.202`. Correct.

**Done** — pinned on the KMZ, in the no-target-CRS case the trial actually ran:
all 60,748 vertices are on a metre grid, none is left in degrees, and the
drawing measures kilometres across rather than the 0.033 units that opens as a
dot at the origin. The explicit-EPSG:32645 run is pinned to the same numbers, so
"leave it unset" cannot become advice that moves the drawing.

---

## F8 — 20 of 76 DXF features missing from the delivered GeoJSON `PINNED`

The delivered file has 56 features where the UI reported 76:

| Layer | in DXF | delivered | now |
|---|---|---|---|
| ML Boundary | 2 | 1 | **2** |
| Mined Out Area | 7 | 1 | **7** (2 line + 5 polygon) |
| Reclaimed | 14 | 1 | **14** (4 line + 10 polygon) |
| Plantation | 5 | 5 | 5 |
| Plot | 24 | 24 | 24 |
| Plot_Text | 24 | 24 | 24 |

Current code returns all **76**. Tested with polygonise off, on, and on with
keep-lines: all three give 76, so that setting does not explain it either. The
delivered file predates a fix I have not identified.

**Done** — `trial-feedback.test.ts` pins 76 features on the operator's own DXF,
the three per-layer counts that had collapsed to 1, and the presence of
LineStrings, which the delivered file had none of.

**And the checks are checked.** A regression test that passes proves the code is
right today, not that the test would have noticed when it was wrong. The two
broken files are still in the tree, so the same two helpers are pointed at them
in `the checks bite`: if those ever stop failing the delivered files, the checks
above have gone blind.

---

## F9 — Same GeoJSON downloaded twelve times `FIXED` `UX`

Folder 1 holds twelve byte-identical copies, `(1)` … `(12)`. Either the Download
button gave no feedback that it had already delivered, or the user was retrying
something that looked like it had not worked.

**Done.** A browser download is silent by design — no dialog, no toast, just a
file appearing in a folder nobody is looking at — and the only acknowledgement
was a line in a log dock that can be folded shut. So the button itself says it:

- after a save it reads **Download again**, with a tooltip giving the time and
  warning that these are the same bytes, so the browser will number the copy
- the queue row gains a **`saved`** badge
- converting again clears both, because those would be different bytes

`downloadedAt` on the queue item carries it, set in `downloadSelected` and
cleared by every conversion.

---

## F10 — Settings › Conversion is empty until a format is chosen `FIXED` `UX`

Screenshot 1135: the section reads "Choose an output format to see the settings
that apply to it". Defensible, but a user opening Settings to look for
conversion options finds an empty panel.

**Done.** Only the LAST section of that panel is genuinely format-specific.
Output structure, precision, whether Z and attributes travel, and what gets
checked apply to every conversion this tool runs, are set once and reused, and
are exactly what someone opens the dialog to change — so they now render whether
or not a format has been picked. The format-specific section is replaced by one
line naming what is waiting on a choice (DXF arc tolerance, KML balloon
templates, LAS scaling), rather than a union of options for a conversion nobody
asked for.

Verified in headless Chromium: with nothing queued and no format chosen, the
dialog shows four groups and ten controls; with GeoJSON chosen, the
"GeoJSON options" section is still there.

---

## What the trial confirms is working

From the screenshots, on real 1,025-feature and 76-feature files:

- basemap button on the canvas, provider switching, Esri satellite imagery
- terrain elevation readout (`1070.0 m`, `861.0 m`, `746.0 m`) on a declared CRS
- *Sources & APIs* panel, bottom right
- layer list with per-layer colour, width, line type, visibility and counts
- select, lasso, move — `Moving 301.860 east, −189.741 north — 356.541 in all`
- Data / Export / Results tabs, QA, Log, Delivery, Manifest, Health, History,
  Workflows
- fidelity badges per format, "what will be lost", warnings
- 188 survey points preserved across all 17 export formats (the values are
  swapped per F1, but nothing is dropped)
- 1,025 KMZ features preserved into 10 formats, including 27 description-only
  placemarks correctly written as `"geometry": null`

---

---

# UI audit

Driven in headless Chromium against the built extension, instrumenting
`addEventListener`/`removeEventListener` on `window` and `document` and
measuring real geometry. Numbers below are measured, not estimated.

## U1 — Every popover open leaks two window listeners `FIXED` `HIGH`

`closeCanvasMenu()` and `closeMapMenu()` remove the element and null the
handle. They do **not** remove the `pointerdown`/`keydown` capture listeners —
those are only removed inside `dismiss` itself, which never runs when the menu
is closed any other way (a menu item click, the button toggling it shut,
`host.render()`).

Measured over five open/close cycles of the basemap popover:

| listener | before | after |
|---|---|---|
| `pointerdown` (capture, window) | 0 | **5** |
| `keydown` (capture, window) | 3 | **8** |

Unbounded across a working session, and each stale closure pins a detached DOM
node.

**To do** — give `closeMapMenu`/`closeCanvasMenu`/the layers popover ownership
of their own teardown, so closing by any route removes the listeners.

## U2 — The popover shuts on the first click inside it `FIXED` `HIGH`

Direct consequence of U1. Reopen the basemap popover and click its own title:

```
openedOk: true    stillOpen: false
```

A stale `dismiss` from a previous open still holds the OLD menu element. The
click is not inside that detached node, so it calls `closeMapMenu()` and takes
down the CURRENT popover. After the first use the control is barely usable —
every choice inside it closes it.

This is very likely part of why the trial screenshots show the same panels
being opened again and again.

**To do** — fixed by U1; pin it with a test that opens, clicks inside, and
asserts the popover is still up.

## U3 — F5 confirmed by measurement `FIXED` `MEDIUM`

The bottom-left overlay occupies y 913–940. The drawn credit band is y 912–928.
**They overlap by 15 px** — the attribution passes behind the basemap button,
the coordinate readout and the Terrain box.

## What the UI audit found healthy

- **No horizontal overflow at any width** — 1920, 1440, 1024, 820, 600, 400 px
  all report 0 px of document overflow, and no body overflow.
- **Canvas controls are keyboard reachable** — the basemap button and
  *Sources & APIs* are both real `<button>`s at tab index 0.
- **No clipped text** in the dock, rail or ribbon: nothing with
  `overflow: visible` exceeds its box without an ellipsis.
- **Zero page errors** across load, file drop, popover use and six viewport
  changes.

---

## Execution order, and what was done

Worked in this order — worst data defect first, then the ones that make the tool
read as broken, then the tests that stop any of it coming back.

| # | Item | Done |
|---|---|---|
| 1 | **F1** — CSV header under a title banner | `findHeaderRow` skips a banner and matches NORTHING/EASTING by name |
| 2 | **F2** — detection confidence on the same file | scored on data rows, and the header searched over the first six lines: 35% → 85% |
| 3 | **U1 + U2** — popover listener ownership | each popover owns its own `teardown`, so closing by any route takes its listeners with it |
| 4 | **F3** — basemap/terrain honour an assumed CRS | `previewCrs` shared by the caption and the tiles |
| 5 | **F4** — clearing the target CRS | a button in the refusal, and a warning on the CRS panel before it |
| 6 | **F5 / U3** — credit band vs the bottom-left cluster | the overlay lifts clear while a credit is drawn |
| 7 | **F6/F7/F8** — pin what was already fixed | label-and-magnitude checks on the operator's KMZ and DXF, plus a check that the checks still bite |
| 8 | **F9/F10** — UX confirmations | Download says it already delivered; Settings fills without a format chosen |
