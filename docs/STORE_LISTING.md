# Store listing — Chrome Web Store and Microsoft Edge Add-ons

Everything a submission needs, in the fields the dashboards ask for. Copy from
here rather than rewriting: the character limits below are the ones the upload
form actually enforces, and several of them are not shown until a submission is
rejected.

Publishing to a store is what makes this extension installable with one click —
no ZIP, no Developer mode, no folder to keep, and no OneDrive placeholder
problem. It also makes it available on any machine the user signs into.

---

## Before you start

| | Chrome Web Store | Microsoft Edge Add-ons |
|---|---|---|
| Developer account | One-off **$5** fee | **Free** |
| Register at | <https://chrome.google.com/webstore/devconsole> | <https://partner.microsoft.com/dashboard/microsoftedge> |
| Typical review | A few hours to a few days | 1–7 business days |
| Package | `dist-zip/universal-bhunex-converter-<version>.zip` | The same file |

Build the package with:

```bash
npm run store:package
```

That runs a store build (no source maps), checks every rule the stores enforce,
and writes the ZIP. If the check fails it tells you exactly which field is wrong
and why — that is cheaper than a rejection.

---

## Listing fields

### Name
```
Universal BhuNex Converter — GIS/CAD/Survey
```
43 characters. Chrome allows 75, but Edge truncates the listing title past 45.

### Short description / summary
*Chrome: 132 characters maximum, hard limit. Edge: 200.*
```
Convert GIS, survey, CAD, LiDAR and mining data offline. Nothing is uploaded — every file is processed on your machine.
```
119 characters. This is also the manifest `description`; keep the two identical.

### Category
- **Chrome:** Workflow & Planning
- **Edge:** Productivity

### Language
English (United Kingdom) — the interface uses British spelling.

### Single purpose
*Chrome requires one sentence. A listing that describes two purposes is rejected.*
```
Convert geospatial, survey and CAD data files between formats locally in the browser.
```

### Detailed description

```
Universal BhuNex Converter turns one geospatial file format into another —
entirely on your own computer. No upload, no account, no server.

Drop a file in. It tells you exactly what the file is, exactly what it can
become, converts it locally, then reads its own output back and compares it with
the source to prove the conversion was faithful.

WHAT IT CONVERTS

GIS vector — GeoJSON, GeoJSON Sequence, TopoJSON, Shapefile (complete
.shp/.shx/.dbf/.prj/.cpg packages), KML, KMZ, GPX, WKT, WKB, GML, OSM, MapInfo
MIF/MID

CAD — DXF read and write with wide entity coverage, including block expansion
and real B-spline evaluation. DWG through an optional local helper.

Survey — CSV, TSV and TXT coordinate tables with PNEZD, PENZD, NEZ, ENZ and XYZ
schemas, header-alias detection, LandXML and XLSX

Mining — Surpac .str, plus borehole, bench, crest and toe recognition. Cadastral
field names including Khasra, Khewat and Khatian.

LiDAR — LAS 1.0 to 1.4 read and write, XYZ, PTS, PLY, with nth, grid and voxel
decimation and classification, crop, elevation and intensity filters

Raster — ESRI ASCII Grid, world files, QGIS GCP points, and GeoTIFF read and
write (uncompressed, LZW, Deflate and PackBits; strips and tiles; predictors 2
and 3)

WHY THIS ONE IS DIFFERENT

Most converters tell you a job succeeded. This one tells you what it did to your
data, and refuses to guess when guessing would be wrong.

• No CRS is ever invented. An easting of 412,345 is valid in all 60 UTM zones
  and both hemispheres. If a file declares no coordinate system and the numbers
  are ambiguous, the conversion stops and asks rather than picking one.

• You are told the cost before you pay it. Every output format is graded against
  your data across eleven axes before anything is written, and a "What will be
  lost" panel names and counts each loss — the field name DBF will shorten, the
  arcs that will be densified, the Z values that have nowhere to go.

• QA means re-import. A green PASS means the output was read back and compared
  with the source. A format with no reader reports NOT VALIDATED, never PASS.

• Nothing is dropped silently. Unsupported entities, lost attributes and
  segmentized curves are counted by name, with what to do about each.

• Repair is off by default. Survey data is legal evidence, so geometry repair
  stays off until you switch it on, and reports every change it makes.

• LAZ is refused, not faked. No LAZ decoder is bundled, so compressed point data
  is reported honestly instead of being misread as raw coordinates.

• Input structure equals output structure. Layers become folders, folders stay
  folders, and a file found two archives deep is delivered under the same tree.
  You see the exact delivery layout before you download anything.

FOR SURVEYORS AND MINE ENGINEERS

Cadastral line work becomes labelled parcels: boundary lines are assembled into
closed polygons within a tolerance you set, and the plot number drawn inside
each parcel is attached to it as an attribute. Borehole collars are joined to
their interval logs by hole id and exported as Google Earth balloons with the
full core log — from, to, thickness, lithology, recovery, RQD, sample and assay
— with any gap or overlap flagged.

PRIVACY

Nothing is uploaded, ever. The extension requests no access to any website, has
no content scripts, contacts no server and contains no analytics or telemetry.
Disconnect from the internet entirely and it works exactly the same. The build
pipeline fails if any remote resource reaches the package.

Full source: https://github.com/emailofsalim/Universal-Converter
```

### Privacy policy URL
```
https://emailofsalim.github.io/Universal-Converter/PRIVACY.html
```
Publish it by enabling **GitHub Pages** on the repository (Settings → Pages →
Deploy from a branch → `main` → `/docs`). Until Pages is enabled, this also
works and both stores accept it:
```
https://github.com/emailofsalim/Universal-Converter/blob/main/docs/PRIVACY.md
```

### Support / homepage URL
```
https://github.com/emailofsalim/Universal-Converter
```

---

## Permission justifications

Chrome asks for a justification per permission, and a blank or vague one is a
common rejection. Paste these verbatim.

**`storage`**
```
Stores the user's own conversion preferences — output format, coordinate
precision, target CRS and delivery layout — so they persist between sessions.
No user content and no personal data is stored.
```

**`unlimitedStorage`**
```
Survey and LiDAR files routinely exceed the default 5 MB quota. A single LAS
point cloud or GeoTIFF held in memory during conversion can be hundreds of
megabytes. Without this permission those conversions fail partway through.
```

**`downloads`**
```
Saves the converted file to the user's computer when they click Download. This
is the only way the extension delivers its output. It does not read existing
downloads.
```

**`sidePanel`**
```
Renders the extension's side panel, which offers quick conversions alongside the
current page. The panel displays only the extension's own interface.
```

**`nativeMessaging`** (optional — requested at runtime, not at install)
```
DWG is a proprietary format with no browser-readable specification. To support
it, the extension communicates with a small helper program the user installs
themselves, which drives the user's own licensed copy of ODA File Converter on
their machine. This permission is optional and is requested only when the user
converts their first DWG file. Every other format works without it, and no data
leaves the user's computer — the helper is a local program, not a server.
```

**Remote code use**
```
No. The extension contains no remotely-hosted code. All logic is bundled in the
package and the build pipeline fails if any remote script, stylesheet or font is
referenced.
```

**Data usage — tick these on the Chrome dashboard**
- ☑ I do not sell or transfer user data to third parties, apart from the approved use cases
- ☑ I do not use or transfer user data for purposes unrelated to my item's single purpose
- ☑ I do not use or transfer user data to determine creditworthiness or for lending purposes

Every data-collection category should be left **unticked**. This extension
collects none of them.

---

## Graphics

Generate them with:

```bash
npm run assets
```

Written to `store-assets/`, rendered through the bundled Chromium at exact
pixel sizes so they can be regenerated after any UI change rather than being
hand-made once and going stale.

| Asset | Size | Required by |
|---|---|---|
| `icon-128.png` | 128×128 | Both (from the manifest) |
| `screenshot-1.png` … `screenshot-4.png` | 1280×800 | Chrome (1–5 needed), Edge |
| `promo-small.png` | 440×280 | Chrome small promo tile |
| `promo-marquee.png` | 1400×560 | Chrome marquee (optional) |
| `edge-logo-300.png` | 300×300 | Edge store logo |

Chrome requires at least one screenshot. Edge requires at least one and the
300×300 logo.

---

## Submitting

### Chrome Web Store

1. <https://chrome.google.com/webstore/devconsole> → pay the one-off $5 fee.
2. **Add new item** → upload `dist-zip/universal-bhunex-converter-<version>.zip`.
3. **Store listing** — paste the name, summary, detailed description and
   category from above; upload the screenshots and the 440×280 tile.
4. **Privacy practices** — paste the single-purpose sentence and each permission
   justification; tick the three certification boxes; add the privacy policy URL.
5. **Distribution** — Public, all regions.
6. **Submit for review.**

### Microsoft Edge Add-ons

1. <https://partner.microsoft.com/dashboard/microsoftedge> → register (free).
2. **New extension** → upload the same ZIP.
3. **Properties** — category Productivity, privacy policy URL, support URL.
4. **Store listing** — name, summary, description, screenshots, 300×300 logo.
5. **Availability** — all markets.
6. **Publish.**

The same package works in both stores. Edge accepts Chrome-format Manifest V3
extensions unchanged.

---

## Updating a published version

1. Bump `version` in `extension/manifest.json` — it must be strictly higher than
   the published one, or the upload is rejected.
2. `npm run store:package`
3. Upload the new ZIP to each dashboard and submit.

Users are updated automatically within a few hours of approval. There is nothing
for them to reinstall.

---

## If a submission is rejected

Rejections usually name a policy, not a field. The mapping that is not obvious:

| What they say | What it usually means |
|---|---|
| "Violation of minimum functionality" | The listing describes it as a tool but the reviewer could not work out what to do. Make sure the first screenshot shows the workspace with a file loaded. |
| "Requesting but not using permission X" | A permission in the manifest that no code path uses. Run `npm run store:check`. |
| "Insufficient justification for permission X" | The justification did not say *what breaks without it*. The ones above all do. |
| "Missing privacy policy" | The URL is not reachable publicly. Check GitHub Pages is enabled, or use the direct file link. |
| "Remotely hosted code" | Something in the package references a remote origin. `npm run store:check` catches this. |

Reply in the dashboard rather than resubmitting blind — a reply usually gets a
faster answer than a fresh submission.
