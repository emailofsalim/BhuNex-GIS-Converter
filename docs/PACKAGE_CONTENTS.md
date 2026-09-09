# What the ZIP must contain

The complete file and folder list a Chrome or Microsoft Edge extension archive
needs in order to load through **Developer mode → Load unpacked**, and the rules
the archive itself has to satisfy.

Chrome and Edge run the same Chromium extension system, so one package serves
both. They differ only in store review, not in loading.

Everything on this page is enforced in CI by `scripts/verify-package.mjs`
(`npm run package:check`), which reads the built archive rather than the source
tree.

---

## 1. The archive layout

`manifest.json` must sit at the **root of the ZIP**, not inside a wrapper
folder.

```
bhunex-gis-converter-1.0.5.zip     17 entries, 0.35 MB
├── manifest.json               ← at the ROOT. Not in a subfolder.
├── INSTALL-FIRST.txt
├── service-worker.js
├── icons/
│   ├── icon-16.png
│   ├── icon-32.png
│   ├── icon-48.png
│   └── icon-128.png
├── assets/
│   ├── workspace.js
│   ├── popup.js
│   ├── sidepanel.js
│   ├── convert.worker.js
│   ├── client-<hash>.js
│   ├── store-<hash>.js
│   └── client.css
└── src/
    ├── popup/index.html
    ├── sidepanel/index.html
    └── workspace/index.html
```

**Why the root matters.** If the archive contains
`bhunex-gis-converter/manifest.json`, the user extracts it, selects the
folder they just extracted, and the browser reports *"Manifest file is missing
or unreadable"* — because the manifest is one level further down. This is one of
the three common causes of that message.

> Package the **contents** of `dist/`, never the `dist/` folder itself.

---

## 2. Required manifest keys

| Key | Required | Notes |
|---|---|---|
| `manifest_version` | **Yes** | Must be `3`. Neither browser loads V2 any more. |
| `name` | **Yes** | Chrome rejects over 75 characters; Edge truncates the listing past 45. |
| `version` | **Yes** | One to four dot-separated integers, each 0–65535. No `-beta` suffix. |
| `description` | Store only | **Hard limit 132 characters**, enforced silently at upload. |
| `icons` | **Yes in practice** | Without them both browsers show a generic puzzle piece. |
| `action` | If there is a toolbar button | `default_popup` must exist in the archive. |
| `background.service_worker` | If there is a background script | MV3 uses a service worker, never a background page. |
| `permissions` | As needed | Anything here prompts at install time. |
| `optional_permissions` | Preferred | Requested from a user gesture instead. |
| `content_security_policy` | Recommended | MV3 forbids relaxing `script-src 'self'`. |
| `key` | **Must be absent** | Pins the extension ID to a local build. |
| `update_url` | **Must be absent** | Store-hosted extensions must not self-update. |

**Every path any of these keys points at must exist in the archive.** A manifest
referencing a file that was not packaged produces an extension that *installs
successfully and then does nothing* — a blank workspace, a popup that never
opens — with no error at install time.

---

## 3. Required icon sizes

All four are used somewhere in the Chrome or Edge interface:

| Size | Used for |
|---|---|
| 16×16 | Favicon on the extension's own pages |
| 32×32 | Windows display scaling |
| 48×48 | The extensions management page |
| 128×128 | Installation and the store listing |

Each must be a real PNG at exactly its declared dimensions.

---

## 4. Archive integrity

The ZIP must be readable by a **strict** extractor, not merely by a tolerant
one.

- The End Of Central Directory record's entry count must equal the number of
  central-directory records actually written.
- Every central-directory record's local-header offset must point at a valid
  local header.
- Every entry's stored CRC-32 must match its data.

**This is not theoretical.** Releases v1.0.0 through v1.0.2 shipped an archive
whose EOCD count was one short, because the packager counted the files in
`dist/` and then wrote one extra synthetic entry (`INSTALL-FIRST.txt`).

The consequence is a clean split between readers:

| Reader | Behaviour |
|---|---|
| Node, Python, 7-Zip, macOS Archive Utility | Scan the file and recover. Archive looks fine. |
| `unzip` | `expected central file header signature not found` |
| **Windows Explorer** | Strict. Can extract only part of the archive. |

Every user of this extension is on Windows, and Windows Explorer is what they
extract with. A partial extraction missing `manifest.json` is reported by the
browser as, exactly, *"Manifest file is missing or unreadable"*.

Fixed in `scripts/package-extension.mjs`; regression-checked by
`scripts/verify-package.mjs`, which honours the EOCD count on purpose — a reader
that recovers from a malformed directory cannot detect a malformed directory.

---

## 5. Path rules

Every user is on Windows, so every path must be one Windows can create. A path
Explorer refuses produces a partial extraction, which lands back at the same
error message.

| Rule | Why |
|---|---|
| No absolute paths (`/foo`, `C:\foo`) | Some extractors refuse the whole archive |
| No `..` segments | Path traversal; rejected, and a security defect |
| Forward slashes only, never `\` | A backslash becomes part of the filename on Linux |
| None of `< > : " \| ? *` | Windows cannot put these in a filename |
| No reserved device names | `CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9` |
| No segment ending in a space or `.` | Windows strips them, so the path stops matching the manifest |
| No two entries differing only in case | On Windows and macOS one silently overwrites the other |
| No `__MACOSX/`, `.DS_Store`, `Thumbs.db`, `desktop.ini` | Chrome Web Store rejects the archive |

---

## 6. Content rules

- **No remote code.** No `<script src="https://…">`, no remote stylesheet, no
  remote font, no runtime download of an engine. Both stores reject it, and rule
  R15 requires this extension to work with the network interface disabled.
- **No `eval` or `new Function`.** MV3's `script-src 'self'` cannot be relaxed,
  so both throw at runtime. Code that needs to evaluate an expression must parse
  it — see `extension/src/core/expression.ts`.
- **Source maps are optional.** They are 78% of the package. Build with
  `STORE_BUILD=1` to drop them.

---

## 7. Building and checking it

**Both artefacts are committed**, so nothing below is needed to install or to
submit — `dist/` loads and `dist-zip/*.zip` uploads as they are.

```bash
npm run build          # a DEVELOPER build over dist/, with source maps
npm run build:store    # the build that is committed: no maps
npm run store:check    # validates dist/ against store rules
npm run package        # → dist-zip/*.zip, then validates the archive
npm run build:check    # rebuilds from source and byte-compares with dist/
```

Or, for a store submission in one step:

```bash
npm run store:package  # no source maps, both validators, packaged
```

Every validator runs on every push in `.github/workflows/ci.yml`, and the
packaged ZIP is attached to every GitHub Release.

### Two manifests, on purpose

`extension/manifest.json` is the source of truth. The build writes two copies:

| File | Paths | Why |
|---|---|---|
| `dist/manifest.json` | `src/popup/index.html` | what ships in the ZIP, and what makes `dist/` loadable on its own |
| `manifest.json` (repo root) | `dist/src/popup/index.html` | makes the REPOSITORY ROOT loadable, so someone can extract a download and select the folder |

The second one exists because the first was not enough. Committing `dist/` made
the extension downloadable, but installing it still meant *extract → go into
`dist` → Load unpacked*, and that middle step is where it goes wrong: the folder
picker opens on the folder you just extracted, selecting it is the obvious move,
and the result was "Manifest file is missing or unreadable" for a third distinct
reason.

They are generated rather than maintained, by `scripts/write-root-manifest.mjs`,
because two hand-written copies drift the first time a page moves — and the
symptom is a blank tab rather than an error. The service worker and the popup
read the workspace path from `chrome.runtime.getManifest()` for the same reason:
only the browser knows which of the two it loaded.

### Why the build output is in version control

A browser loads a **folder**; it cannot build one. With `dist/` gitignored, the
obvious use of the repository — download it, load it — produced the exact error
this document exists to prevent, and the only alternative on offer was "install
Node first", which is not an ask a survey office should have to meet.

The real cost of committing build output is that it drifts silently, and a stale
extension is worse than none: the bug report describes code that is already
fixed. So `scripts/assert-build-committed.mjs` rebuilds from source into a
temporary directory on every CI run and compares every file byte for byte. Drift
is a build failure with the file list attached — the same guard `npm run
docs:check` already puts on the generated format matrix.

---

## 8. Loading it

**Microsoft Edge**

1. Extract the ZIP to a **local** folder — `C:\Extensions\` is a good choice.
2. Open `edge://extensions`.
3. Turn on **Developer mode** (bottom-left).
4. Click **Load unpacked** and select the folder containing `manifest.json`.

**Google Chrome**

1. Extract the ZIP to a **local** folder.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top-right).
4. Click **Load unpacked** and select the folder containing `manifest.json`.

### Do not extract into OneDrive

On a work laptop, `Desktop`, `Documents` and `Downloads` are usually synced to
OneDrive, which replaces file contents with cloud placeholders. File Explorer
shows `manifest.json` at the right size, but the browser reads extension files
directly and cannot trigger the download — so it reports *"Manifest file is
missing or unreadable"* about a file you can plainly see.

Check the Status column: a solid green tick means the contents are on the
machine, a blue cloud outline means they are not.

The browser re-reads the folder every time it starts, so wherever you extract
it, leave it there. Deleting or moving the folder uninstalls the extension.
