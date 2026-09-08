# Installing Universal BhuNex Converter

Works in **Chrome** and **Microsoft Edge** (both are Chromium, the steps are the
same). Everything runs on your machine — no file is uploaded anywhere.

---

## The one mistake everybody makes

> **Failed to load extension**
> **Error: Manifest file is missing or unreadable**

Read that message carefully: it has **two** halves. The folder either has no
`manifest.json` in it, or it has one the browser **could not read**. The second
half is the one that catches people, and it has nothing to do with picking the
wrong folder.

### Missing — you picked the wrong folder

| What you selected | Why it fails |
|---|---|
| The **`extension/`** folder | That is TypeScript source, not a built extension. Select the folder above it, or `dist/`. |
| The folder *containing* the extension folder | Load unpacked wants the folder that has `manifest.json` **in** it, not its parent. |
| The `.zip` file itself, or the folder view Windows shows when you double-click a `.zip` | Browsers load a real **folder** on disk. Extract it first — double-clicking a ZIP only previews it. |

### Unreadable — the file is there but the browser cannot open it

**This is the usual cause on a work laptop, and OneDrive is why.**

If the path in the error starts with `C:\Users\…\OneDrive` or
`D:\OneDrive - <Your Company>`, stop and re-extract somewhere else.

OneDrive's **Files On-Demand** replaces files it has synced with placeholders —
the name is on disk, the contents are in the cloud. File Explorer hides this
completely: the folder looks normal and `manifest.json` is listed. But Edge and
Chrome read extension files directly, without triggering OneDrive's download,
so they see an empty or unreadable file and report exactly the message above.

The same applies to any folder that is redirected, synced or roamed by your
organisation — Desktop, Documents and Downloads are often all inside OneDrive on
a managed machine, which is how a perfectly good package fails to load from
three different places in a row.

**The fix — extract outside OneDrive entirely:**

1. Make a plain local folder. `C:\Extensions\` is a good choice. Avoid anything
   under `OneDrive`, `Desktop`, `Documents` or `Downloads` on a managed laptop.
2. Extract `universal-bhunex-converter-<version>.zip` into it, so you have
   `C:\Extensions\universal-bhunex-converter-1.0.0\manifest.json`.
3. Load **that** folder.

Keep it there permanently. The browser re-reads the folder at every start, so if
you delete it or let it sync away, the extension stops loading.

> If you must keep it in OneDrive, right-click the extracted folder →
> **Always keep on this device**, wait for the green tick on every file, then
> retry. Extracting outside OneDrive is more reliable and is what we recommend.

### Still stuck? Confirm what the browser sees

Open the folder you are selecting and check all three:

- `manifest.json` is **directly inside** it — not in a subfolder.
- Its **Size** column shows something around 1–2 KB, **not** 0 bytes.
- Its **Status** column (if present) shows a solid green tick or no cloud icon —
  a blue cloud outline means the contents are not on this machine.

Then open `manifest.json` in Notepad. If it opens and starts with `{`, the file
is readable and the folder is right. If Notepad shows nothing, or an error, the
file is a placeholder — go back to the OneDrive fix above.

---

## Option A — download the repository and load the folder

**Recommended, and the whole install. No Node, no npm, no build step.**

The built extension is committed to this repository, and the repository root
carries its own `manifest.json`, so the folder you extract is a loadable
extension exactly as it comes.

1. On the repository page, green **Code** button → **Download ZIP**.
   (Or `git clone https://github.com/emailofsalim/Universal-Converter.git`.)
2. **Extract it to a plain local folder — not OneDrive.** Right-click →
   *Extract All* on Windows, and set the destination to something like
   `C:\Extensions\`. On a work laptop, Desktop, Documents and Downloads are
   often inside OneDrive, and files synced there load as placeholders the
   browser cannot read. See the OneDrive section above.
3. Open the extensions page:
   - Chrome: `chrome://extensions`
   - Edge: `edge://extensions`
4. Turn on **Developer mode** (a toggle, top-right in Chrome, bottom-left in
   Edge).
5. Click **Load unpacked**.
6. Select **the folder you just extracted**.
7. Click the toolbar icon → **Open converter workspace**.

### Which folder?

The one you extracted. It carries a `manifest.json` at its top level, which is
what "Load unpacked" is looking for:

```
Universal-Converter/
├── manifest.json        ← this is what makes the folder loadable
├── dist/                ← the built extension itself (also loadable on its own)
│   ├── manifest.json
│   ├── service-worker.js
│   ├── icons/
│   ├── assets/
│   └── src/
├── extension/           ← TypeScript source; NOT loadable
├── docs/
└── scripts/
```

**Either the outer folder or `dist/` works** — they carry the same extension,
with the paths written from different depths. `extension/` is the one that does
not: it is the source the build compiles.

---

## Option A2 — download a release archive

The same build, packaged so that `manifest.json` is at the top of the archive
rather than one level down.

1. <https://github.com/emailofsalim/Universal-Converter/releases>
2. Download `universal-bhunex-converter-<version>.zip`.
3. Extract it outside OneDrive, then Load unpacked → the extracted folder
   itself. `INSTALL-FIRST.txt` inside repeats these steps.

The identical archive is also committed at `dist-zip/` if you already have the
repository.

---

## Option B — build it yourself

Only needed if you want to modify the code. Requires **Node 20 or newer**.

```bash
git clone https://github.com/emailofsalim/Universal-Converter.git
cd Universal-Converter
npm ci
npm run build          # a DEVELOPER build, with source maps, over dist/
```

Then load **`dist/`** with Load unpacked — not the repository root, and not
`extension/`. The repository root has no manifest, and `extension/` holds the
TypeScript sources that `npm run build` compiles.

Note that `npm run build` overwrites the committed `dist/` with a build that
carries source maps, so `git status` will show a diff. That is expected while
developing; `npm run build:store` restores exactly what is committed.

```bash
npm run verify         # typecheck + tests + build + committed-build check
npm run store:package  # rebuilds dist/ and dist-zip/ as committed
```

**Why `dist/` is committed at all.** A browser loads a folder and cannot build
one, so gitignoring the build meant the obvious use of this repository — 
download it, load it — failed with the exact error at the top of this page.
Committed build output normally goes stale silently, which would be worse, so
CI rebuilds from source on every push and fails if one byte differs
(`npm run build:check`).

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
See the top of this page. Either the folder has no `manifest.json` in it, or —
on a work laptop, usually — the folder is inside OneDrive and the file is a
cloud placeholder the browser cannot read. Extract to `C:\Extensions\` instead.

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
