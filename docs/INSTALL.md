# Installing Universal BhuNex Converter

Works in **Chrome** and **Microsoft Edge** (both are Chromium, the steps are the
same). Everything runs on your machine — no file is uploaded anywhere.

---

## The one mistake everybody makes

> **Failed to load extension**
> **Error: Manifest file is missing or unreadable**

This means the folder you selected has no `manifest.json` directly inside it.
Almost always it is one of these three:

| What you selected | Why it fails |
|---|---|
| The source code from the green **Code → Download ZIP** button | That is TypeScript. A browser cannot run it. It has to be built first, or you download the built package instead (Option A below). |
| The folder *containing* the extension folder | Load unpacked wants the folder that has `manifest.json` **in** it, not its parent. |
| The `.zip` file itself | Browsers load a **folder**. Unzip it first. |

The fix is Option A.

---

## Option A — download the built extension (no Node, no build)

**Recommended. This is the whole install.**

1. Go to the repository's **Releases** page:
   <https://github.com/emailofsalim/Universal-Converter/releases>
2. Under the latest release, download
   `universal-bhunex-converter-<version>.zip`.
3. **Unzip it.** Right-click → *Extract All* on Windows. Remember where it
   extracts to.
4. Open the extensions page:
   - Chrome: `chrome://extensions`
   - Edge: `edge://extensions`
5. Turn on **Developer mode** (a toggle, top-right in Chrome, bottom-left in
   Edge).
6. Click **Load unpacked**.
7. Select the **unzipped folder** — the one that directly contains
   `manifest.json`. If you open the folder and see `manifest.json` listed, you
   have the right one.
8. Click the toolbar icon → **Open converter workspace**.

### Checking you picked the right folder

The folder you select must look like this:

```
universal-bhunex-converter/
├── manifest.json        ← this file must be here
├── service-worker.js
├── assets/
└── src/
```

If instead you see a folder inside a folder, go one level deeper.

---

## Option B — build it yourself

Only needed if you want to modify the code. Requires **Node 20 or newer**.

```bash
git clone https://github.com/emailofsalim/Universal-Converter.git
cd Universal-Converter
npm ci
npm run build          # writes dist/
```

Then load **`dist/`** with Load unpacked — not the repository root, and not
`extension/`. The repository root has no manifest, and `extension/` holds the
TypeScript sources that `npm run build` compiles.

```bash
npm run verify         # typecheck + tests + build, what CI runs
npm run package        # dist-zip/universal-bhunex-converter-<version>.zip
```

---

## Option C — grab a build from CI

Every green CI run publishes the built extension. Useful for testing a branch
before it is released. Requires being signed in to GitHub.

1. Open the **Actions** tab → the most recent green **CI** run.
2. Scroll to **Artifacts**.
3. Download `universal-bhunex-converter-unpacked`, unzip, and load the folder
   as in Option A.

---

## After installing

- **Toolbar icon** → *Open converter workspace* for the full page.
- **Side panel** for quick conversions beside a page.
- **Ctrl/Cmd + K** opens the command palette — the fastest way to reach any
  format, preset or tool.

### Optional: DWG support

DWG needs a small local Python helper, because there is no browser-native DWG
reader. Everything else — DXF, Shapefile, KML/KMZ, GeoJSON, LAS, GeoTIFF,
LandXML, Surpac and the rest — works without it. See
[NATIVE_HOST.md](NATIVE_HOST.md).

---

## Troubleshooting

**"Manifest file is missing or unreadable"**
See the table at the top. You selected a folder without `manifest.json`.

**"Manifest version 2 is unsupported"**
You have loaded something else. This extension is Manifest V3.

**The extension loads but the workspace is blank**
The build is incomplete — `assets/` is missing. Re-download the release ZIP and
make sure the extraction finished before loading it.

**Edge says the extension is from an unknown source**
That is expected for any unpacked extension and is not an error. Developer mode
has to stay on for unpacked extensions to keep running.

**It disappears when I restart the browser**
Developer mode was switched off, or the folder was moved or deleted. The
browser loads the extension from that folder every time it starts, so keep the
unzipped folder somewhere permanent — not in Downloads if you clear it.
