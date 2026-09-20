# Trial feedback — inspection register

Everything in `1_Trial_Feedback_Files`, `2_Trial_Feedback_Files`,
`3_Trial_Feedback_Files` and `4_Trial_Feedback_Screenshorts`, inspected file by
file against the code as it stands at v1.11.12. Nothing here is a guess: every
row was reproduced against the current pipeline or read out of the delivered
bytes.

**Status key** — `OPEN` still broken today · `FIXED` already corrected since the
trial build · `UX` works but reads as broken · `NOTE` observation, no change
proposed.

---

## What was trialled

| Folder | Source | Size | Exports |
|---|---|---|---|
| 1 | `RAM_Pakhar-115.13 Ha Entity LMS Final Data.dxf` | 3.9 MB, 76 features, **no CRS declared** | GeoJSON ×12 (same file, re-downloaded) |
| 2 | `PKR_CADASTRAL_MAP.kmz` | 567 kB, 1,025 features, **EPSG:4326** | 10 formats |
| 3 | `Pakhar-A 115.13 Ha Boundary Pillars.csv` | 6 kB, 188 survey points | 17 formats |
| 4 | 23 screenshots of the running extension | — | — |

---

## F1 — Survey CSV with a title row swaps easting and northing `OPEN` `CRITICAL`

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

## F2 — Format detection scores this CSV at 35% `OPEN` `HIGH`

The same title row drops CSV detection below the confidence floor, so the
conversion throws `FORMAT_UNCONFIRMED` and the user must pick the format by
hand. A four-column survey CSV is the commonest input this tool will ever see.

**To do** — score a table on its DATA rows rather than only its first line, so a
title row costs a little confidence instead of most of it.

---

## F3 — Basemap and terrain ignore an assumed CRS `OPEN` `HIGH`

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

## F4 — A target CRS set for one file silently breaks the next `OPEN` `HIGH` `UX`

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

**To do**
1. Put a **"Clear the target CRS"** button in that error, so the remedy is one
   click from where the problem is reported.
2. Consider scoping the target CRS to the file it was set for, or warning when
   a target CRS carried over from a different source is about to block an
   export.

---

## F5 — The canvas credit runs under the bottom-left controls `OPEN` `MEDIUM`

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

## F6 — GeoJSON declared EPSG:32645 while holding degrees `FIXED`

The delivered `PKR_CADASTRAL_MAP_converted_to_geojson.geojson` declares
`urn:ogc:def:crs:EPSG::32645` and **all 62,111 of its coordinates are degrees**
(`84.594, 23.544`). The file lies about its own CRS.

Current code is correct — same input and target now gives
`[254374.143, 2605788.719]` with a `CRS_TRANSFORMED` warning. The delivered file
came from a build predating the fix.

**To do** — add a regression test pinning it, since nothing currently proves the
labelled CRS matches the written magnitudes.

---

## F7 — DXF written in degrees `FIXED`

`PKR_CADASTRAL_MAP_converted_to_dxf.dxf` has `firstX = 84.594` — longitude in
the X ordinate, the defect fixed in PR #77.

Current code on the same file: `firstX = 254348.202`. Correct.

---

## F8 — 20 of 76 DXF features missing from the delivered GeoJSON `NOTE`

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

**To do** — pin 76-in/76-out for this file as a regression test so it cannot
come back unnoticed.

---

## F9 — Same GeoJSON downloaded twelve times `NOTE` `UX`

Folder 1 holds twelve byte-identical copies, `(1)` … `(12)`. Either the Download
button gave no feedback that it had already delivered, or the user was retrying
something that looked like it had not worked.

**To do** — confirm Download gives visible confirmation; low cost, and twelve
retries is a signal.

---

## F10 — Settings › Conversion is empty until a format is chosen `NOTE` `UX`

Screenshot 1135: the section reads "Choose an output format to see the settings
that apply to it". Defensible, but a user opening Settings to look for
conversion options finds an empty panel.

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

## Execution order

1. **F1** — CSV header detection and named axis mapping (critical, silent, wrong data)
2. **F2** — table detection confidence (same root cause, same file)
3. **F3** — basemap/terrain honour an assumed CRS
4. **F4** — one-click "clear the target CRS" in the refusal
5. **F5** — credit band vs the bottom-left cluster
6. **F6/F7/F8** — regression tests pinning what is already fixed
7. **F9/F10** — UX confirmations
