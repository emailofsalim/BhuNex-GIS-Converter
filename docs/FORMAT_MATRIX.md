# Format matrix

<!--
  GENERATED FILE — do not edit by hand.
  Run: node --experimental-strip-types scripts/format-matrix.mjs
  CI fails if this file disagrees with extension/src/core/registry.ts.
-->

Generated from `extension/src/core/registry.ts`, which is the single source of
truth the UI, the detector and the conversion pipeline all read. A format appears
here exactly as its engines actually behave.

## What the support levels mean

| Level | Meaning |
|---|---|
| **Supported** | Reader/writer implemented and covered by a round-trip test. |
| Partial | Implemented with named, enumerated limitations — listed below the table. |
| Metadata only | Structure and georeference are read; the payload is **not** decoded. |
| Adapter required | The contract exists; the engine (native helper or WASM) is not bundled. |
| Not supported | Not implemented, and never offered in the interface. |

A format is never listed above what its engine has earned: a `full` claim without a
covering test fails the build (`extension/tests/registry.test.ts`).

**23 formats read directly**, 5 partially, 0 metadata-only, 7 through adapters that are not bundled.

## GIS

| Format | Extensions | Import | Export | Carries |
|---|---|---|---|---|
| ESRI Shapefile | `.shp` | **Supported** | **Supported** | 3D, Z, M, attributes, CRS |
| File Geodatabase | `.gdb` | Adapter required | Adapter required | 3D, Z, M, attributes, CRS, curves |
| FlatGeobuf | `.fgb` | **Supported** | **Supported** | 3D, Z, attributes, CRS |
| GeoJSON | `.geojson` `.json` | **Supported** | **Supported** | 3D, Z, attributes, CRS |
| GeoJSON Sequence | `.geojsonl` `.jsonl` `.ndjson` | **Supported** | **Supported** | 3D, Z, attributes |
| GeoPackage | `.gpkg` | Adapter required | Adapter required | 3D, Z, M, attributes, CRS |
| GeoParquet | `.parquet` | Adapter required | Adapter required | 3D, Z, attributes, CRS |
| GML | `.gml` | Partial | Partial | 3D, Z, attributes, CRS |
| KML | `.kml` | **Supported** | **Supported** | 3D, Z, attributes |
| KMZ | `.kmz` | **Supported** | **Supported** | 3D, Z, attributes |
| MapInfo MIF/MID | `.mif` | Partial | Partial | attributes, CRS |
| OpenStreetMap XML | `.osm` | Partial | Partial | attributes |
| TopoJSON | `.topojson` | **Supported** | Partial | attributes |
| Well-Known Binary | `.wkb` | **Supported** | **Supported** | 3D, Z, M |
| Well-Known Text | `.wkt` | **Supported** | **Supported** | 3D, Z, M |

**ESRI Shapefile**

- Exported as a ZIP containing .shp, .shx, .dbf, .prj and .cpg.
- One shapefile holds one geometry type; mixed input is split into _point, _line and _polygon files.
- DBF field names are limited to 10 bytes and text values to 254 bytes. Every rename or truncation is listed in the manifest.
- Companion files: `.shx`, `.dbf`, `.prj`, `.cpg`.
- Multi-file output is packaged automatically as one ZIP.

**File Geodatabase**

- Requires a licensed SDK. Adapter contract only.

**FlatGeobuf**

- Written without the optional spatial index, so feature order is preserved rather than sorted into Hilbert order.
- A FlatGeobuf file holds one feature collection, so multiple layers are merged on export.
- has_z is a property of the whole file: if any feature is 3D, every 2D feature is written with Z = 0, and that is reported.

**GeoJSON**

- RFC 7946 writes WGS 84 longitude/latitude. Other CRS are written with a crs member and flagged as non-standard.

**GeoJSON Sequence**

- One Feature per line. Streams well for very large datasets.

**GeoPackage**

- Needs a SQLite WASM engine. Adapter contract only.

**GeoParquet**

- Adapter contract only.

**GML**

- Reads gml:Point, LineString, LinearRing, Polygon, MultiGeometry and their pos/posList forms. Curved GML primitives and application schemas beyond simple features are not interpreted.
- srsName axis order is honoured for EPSG geographic CRS, which store latitude first.

**KML**

- KML is defined in WGS 84 longitude/latitude. Projected input is transformed on export, and the transform is recorded.

**MapInfo MIF/MID**

- POINT, LINE, PLINE, REGION and MULTIPOINT are handled. ARC, TEXT, ELLIPSE and ROUNDRECT objects are reported, not converted.
- MIF is 2D; Z values are dropped.
- Companion files: `.mid`.
- Multi-file output is packaged automatically as one ZIP.

**OpenStreetMap XML**

- Nodes and ways are read. Relations (multipolygons, routes) are not assembled.
- The writer emits nodes and ways only. Polygon interior rings need a multipolygon relation and are reported rather than written.
- Exported elements carry negative ids — the OSM convention for objects that do not exist in the database. This is data shaped like OSM, not an upload-ready changeset.

**TopoJSON**

- The writer emits one arc per ring or line without shared-arc detection, so the output is valid TopoJSON but not topologically minimal.
- Z values are not carried by TopoJSON.

**Well-Known Binary**

- WKB carries geometry only. Attributes are not written.

**Well-Known Text**

- WKT carries geometry only. Attributes are not written.

## CAD

| Format | Extensions | Import | Export | Carries |
|---|---|---|---|---|
| AutoCAD DWG | `.dwg` | Adapter required | Adapter required | 3D, Z, attributes, curves |
| AutoCAD DXF (ASCII) | `.dxf` | **Supported** | **Supported** | 3D, Z, attributes, curves |
| MicroStation DGN | `.dgn` | Adapter required | Adapter required | 3D, Z, attributes, curves |

**AutoCAD DWG**

- Install instructions: docs/NATIVE_HOST.md
- DWG requires the local native helper driving your installed ODA File Converter. A renamed DXF is never presented as DWG.

**AutoCAD DXF (ASCII)**

- DXF has no CRS. The source CRS must be declared or selected before any coordinate transform.
- Curved entities (ARC, CIRCLE, ELLIPSE, SPLINE) are segmentized on the way to GIS targets using the sagitta tolerance in the settings panel. The substitution is counted in QA.
- Entity classes outside the supported set are counted by name and reported rather than dropped silently.

**MicroStation DGN**

- Adapter contract only. No DGN parser is bundled.

## Survey

| Format | Extensions | Import | Export | Carries |
|---|---|---|---|---|
| CSV / TSV coordinate table | `.csv` `.tsv` `.txt` | **Supported** | **Supported** | 3D, Z, attributes |
| LandXML | `.landxml` `.xml` | Partial | Partial | 3D, Z, attributes, CRS |

**CSV / TSV coordinate table**

- Recognises PNEZD, PENZD, NEZ, ENZ, XYZ and header-named schemas. Column mapping is always editable before conversion.

**LandXML**

- CgPoints, Parcels, Surface Pnts/Faces and PlanFeatures are read. Alignments, profiles, superelevation and pipe networks are reported, not converted.
- LandXML stores northing before easting; the reader swaps to x/y and records that it did.

## Mining

| Format | Extensions | Import | Export | Carries |
|---|---|---|---|---|
| Surpac String | `.str` | Partial | Partial | 3D, Z, attributes |

**Surpac String**

- Surpac writes northing before easting; the reader swaps to x/y and records that it did.
- String number, Y (northing), X (easting), Z and description fields are handled. Surpac styling and extended D-fields beyond the description are not interpreted.

## LiDAR

| Format | Extensions | Import | Export | Carries |
|---|---|---|---|---|
| E57 point cloud | `.e57` | Adapter required | Adapter required | 3D, Z, attributes, CRS |
| LAS point cloud | `.las` | **Supported** | **Supported** | 3D, Z, attributes, CRS |
| LAZ compressed point cloud | `.laz` | Adapter required | Adapter required | 3D, Z, attributes, CRS |
| PLY mesh / point cloud | `.ply` | **Supported** | Partial | 3D, Z, attributes |
| PTS scan points | `.pts` | **Supported** | **Supported** | 3D, Z, attributes |
| XYZ point cloud / text | `.xyz` | **Supported** | **Supported** | 3D, Z, attributes |

**E57 point cloud**

- Adapter contract only.

**LAS point cloud**

- LAS 1.0–1.4, point record formats 0–10 on read; 0–3 and 6–7 on write. Coordinates use the file scale and offset in double precision.

**LAZ compressed point cloud**

- A real laszip codec is Phase 5 work.
- LAZ point data is arithmetic-coded. No decoder is bundled, so the header is reported and the points are refused. LAZ bytes are never read as uncompressed LAS.

**PLY mesh / point cloud**

- The writer emits ASCII PLY vertices only; faces are not written.

**PTS scan points**

- First line is the point count, then X Y Z [intensity] [R G B].

## Raster

| Format | Extensions | Import | Export | Carries |
|---|---|---|---|---|
| ESRI ASCII Grid / DEM | `.asc` `.grd` `.agr` | **Supported** | **Supported** | 3D, Z, CRS |
| GeoTIFF | `.tif` `.tiff` | **Supported** | **Supported** | CRS |
| QGIS GCP points | `.points` | **Supported** | **Supported** | attributes, CRS |
| World file | `.tfw` `.jgw` `.pgw` `.wld` `.gfw` `.bpw` | **Supported** | **Supported** | — |

**ESRI ASCII Grid / DEM**

- Single-band elevation grid. This is the working DEM path: values round-trip exactly.
- Companion files: `.prj`.

**GeoTIFF**

- Reading covers the compressions GDAL and QGIS produce by default. Overviews, masks and multi-IFD pyramids are not read: only the first image of the file.
- Pixels are decoded for uncompressed, LZW, Deflate and PackBits data, in strips or tiles, with predictors 2 and 3.
- JPEG, JPEG 2000, LERC, WebP and Zstandard compression are refused by name rather than misread — the georeference, extent and footprint of such a file are still read.
- Output is written as a single-IFD, strip-based, Deflate-compressed TIFF. Rotated georeference is reported and not written; the sample type is chosen from the data so no value is silently rounded.
- Companion files: `.tfw`, `.prj`, `.aux.xml`.

**World file**

- Six-line affine georeference for an image. Bound automatically to a matching image file.

## Spreadsheet

| Format | Extensions | Import | Export | Carries |
|---|---|---|---|---|
| Excel Workbook | `.xlsx` | **Supported** | **Supported** | 3D, Z, attributes |

**Excel Workbook**

- Cell formatting, formulas and charts are not preserved; values are.

## CRS

| Format | Extensions | Import | Export | Carries |
|---|---|---|---|---|
| Projection sidecar (.prj/.qpj) | `.prj` `.qpj` | **Supported** | **Supported** | CRS |

## Archive

| Format | Extensions | Import | Export | Carries |
|---|---|---|---|---|
| ZIP archive | `.zip` | **Supported** | **Supported** | — |

**ZIP archive**

- Opened, inspected and expanded into the queue. Nesting depth, decompressed size and compression ratio are capped.
- Multi-file output is packaged automatically as one ZIP.

---

## Not offered, and why

| Format | Reason |
|---|---|
| AutoCAD DWG | Needs a native helper or licensed SDK on your machine. |
| MicroStation DGN | Needs a native helper or licensed SDK on your machine. |
| LAZ compressed point cloud | Needs a WebAssembly engine that is not part of this build. |
| E57 point cloud | Needs a WebAssembly engine that is not part of this build. |
| GeoPackage | Needs a WebAssembly engine that is not part of this build. |
| GeoParquet | Needs a WebAssembly engine that is not part of this build. |
| File Geodatabase | Needs a native helper or licensed SDK on your machine. |

Closing any of these is tracked in `docs/BUILD_STATE.md`.
