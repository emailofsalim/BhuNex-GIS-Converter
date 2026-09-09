# BhuNex GIS Converter

Convert GIS, survey, CAD, LiDAR and mining data **entirely on your own machine**.
Nothing is uploaded.

- **[Install](INSTALL.html)** — including what to do about
  *"Manifest file is missing or unreadable"*
- **[Privacy policy](PRIVACY.html)** — nothing is collected, and how to verify that
- **[Format matrix](FORMAT_MATRIX.html)** — every format, with its limits stated
- **[Native host](NATIVE_HOST.html)** — optional, for DWG only
- **[Source](https://github.com/emailofsalim/Universal-Converter)**

## Install

**No Node, no npm, no build step.** The built extension is committed to the
repository, so downloading it gives you something the browser can load directly.

1. **[Download the repository](https://github.com/emailofsalim/Universal-Converter/archive/refs/heads/main.zip)**
   (or a packaged archive from
   **[Releases](https://github.com/emailofsalim/Universal-Converter/releases)**).
2. Extract it to a plain local folder such as `C:\Extensions\` — **not**
   OneDrive, Desktop, Documents or Downloads.
3. `edge://extensions` or `chrome://extensions` → turn on **Developer mode**.
4. **Load unpacked** → select the folder you just extracted.

The repository root carries a `manifest.json`, so the folder you extracted is
the folder to select. `dist/` inside it works too — it has its own manifest —
so there is no wrong choice between the two.

Store listings are in preparation; once published, installing will be one click
with no folder to keep.
