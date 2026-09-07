# Native engine — DWG support

Everything else in Universal BhuNex Converter runs inside the browser. DWG cannot:
it is a proprietary binary format with no open reader that can be bundled, and a
Chrome extension may not execute a native program directly.

So DWG runs through a small local helper that drives **your own installed
ODA File Converter**. Nothing is uploaded, and the extension never presents a
renamed DXF as a DWG.

**If you do not install this, everything except DWG still works.** DWG format
cards show *Native Engine Required* and the convert button for them is disabled.

---

## What you need

| | |
|---|---|
| Python 3.9+ | `python3 --version` |
| ODA File Converter | Free from [opendesign.com](https://www.opendesign.com/guestfiles/oda_file_converter) |
| The extension's ID | `chrome://extensions` with Developer mode on, or the extension's Settings → Native engine panel |

---

## Install

```bash
cd native-host
python3 install.py --extension-id <your-extension-id>
```

This writes one small manifest into your browser's per-user native-messaging
directory (and, on Windows, a matching `HKEY_CURRENT_USER` registry value).
Nothing is installed system-wide and nothing needs administrator rights.

Then point the helper at your ODA installation — or leave the path empty and let
it search the usual locations:

```jsonc
// native-host/host-config.json
{
  "odaExecutable": "C:/Program Files/ODA/ODAFileConverter 25.4.0/ODAFileConverter.exe",
  "odaOutputVersion": "ACAD2018",
  "conversionTimeoutSeconds": 180,
  "maxInputMb": 400
}
```

Restart the browser, then open the extension and check **Settings → Native
engine**. It should read `Native engine: ready`.

To remove it: `python3 install.py --uninstall`.

---

## How a DWG conversion actually runs

```
Extension  ──sendNativeMessage──▶  universal_bhunex_host.py
                                        │
                                        ├─ validates the DWG magic bytes (AC10xx)
                                        ├─ writes the file into a fresh temp job dir
                                        ├─ runs ODA File Converter on that dir
                                        ├─ validates the produced DXF
                                        └─ deletes the job dir, always
                                        │
Extension  ◀──── DXF bytes + engine name/version/path ────┘
                    │
                    └─▶ the normal DXF reader → CIR → your chosen target
```

The DXF hop is visible, not hidden: every DWG conversion carries a
`DWG_VIA_NATIVE_ENGINE` note naming the engine, its version and the DXF output
version it used.

### Message protocol

4-byte little-endian length prefix, then UTF-8 JSON.

```jsonc
// request
{ "id": "…", "op": "ping" | "health" | "convert",
  "payload": { "sourceName": "site.dwg", "sourceBase64": "…" } }

// success
{ "id": "…", "ok": true,
  "result": { "fileName": "site.dxf", "dxfBase64": "…", "outputVersion": "ACAD2018" },
  "engine": { "name": "ODA File Converter", "version": "25.4.0", "path": "…", "ready": true } }

// failure — always four fields: what, why, and what to do about it
{ "id": "…", "ok": false,
  "error": { "code": "ODA_NOT_INSTALLED", "what": "…", "why": "…", "action": "…" } }
```

---

## Status states

| Shown in the top bar | Meaning |
|---|---|
| `READY` | Helper reachable and ODA found. DWG conversion is available. |
| `NOT_INSTALLED` | No manifest for this extension id, or ODA was not found. |
| `CONFIGURATION_ERROR` | Helper reachable but `host-config.json` is unreadable. |
| `ENGINE_ERROR` | ODA ran and failed — the message carries its output. |
| `TIMEOUT` | No response in time; usually an ODA dialog waiting for input. |

---

## Security

- The manifest's `allowed_origins` names **only your extension id**. No other
  extension can reach the helper.
- The helper reads and writes **only inside a temp directory it creates per
  job**, and removes it in a `finally` block whether the job succeeded or not.
- Input is checked for the DWG magic bytes before ODA is invoked, and the
  supplied filename is reduced to its basename so a path separator in it cannot
  escape the job directory.
- Payloads above `maxInputMb` are refused rather than buffered.
- The helper makes no network requests.

---

## Troubleshooting

**"Specified native messaging host not found"** — the extension id in the
manifest does not match the installed extension. Re-run `install.py` with the id
shown on `chrome://extensions`, then restart the browser (Chrome reads these
manifests at start-up).

**Status stays `NOT_INSTALLED` after installing** — the helper is registered but
ODA was not found. Set `odaExecutable` to the full path of the executable.

**`ODA_TIMEOUT`** — ODA File Converter shows a dialog on first run and on some
licence prompts. Open it once manually, dismiss the dialog, then retry.

**Nothing happens at all** — run the helper directly to see its start-up error:

```bash
python3 native-host/universal_bhunex_host.py
```

It will wait for a length-prefixed message on stdin; a Python traceback instead
means the error is in the helper's environment.
