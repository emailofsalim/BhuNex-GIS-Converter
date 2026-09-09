# Scope

**Decided 7 September 2026. This file is the answer to "should we build X".**

---

## In scope: a Chrome MV3 browser extension

That is the product. One deliverable, one target:

- **Chrome Manifest V3 extension**, built to `dist/`, packaged to
  `dist-zip/bhunex-gis-converter-<version>.zip`
- Runs in **Google Chrome and Microsoft Edge** — both are Chromium, and the same
  package loads unchanged in either
- Installed either by **sideloading the ZIP** (extract, Load unpacked) or from
  the **Chrome Web Store / Edge Add-ons** once published
- **Everything runs locally.** No server, no upload, no account. The build fails
  if a remote resource reaches the package.

Everything in `docs/BHUNEX_GIS_CONVERTER_BUILD_INSTRUCTIONS.txt` is scoped
to that extension. The phase board in `docs/BUILD_STATE.md` tracks it.

---

## Deferred: a web app

**Recorded here so the idea is not lost, and explicitly not being built now.**

A hosted web version — the same conversion engines running on a plain web page
rather than inside an extension — is a reasonable future direction. It is
deferred for reasons that are worth writing down, because they will still be
true when someone reconsiders:

**It is not a small addition.** The engines are already portable: the core, CRS,
engine and QA layers use nothing but platform APIs and have no dependency on
`chrome.*`. What is genuinely extension-shaped is the surrounding apparatus —
the side panel, the popup, the service worker, `chrome.storage`, the downloads
permission and the native-messaging path for DWG. A web build has to replace
each of those, and each replacement is a decision rather than a port.

**It changes the privacy claim.** The extension's central promise is that
nothing is uploaded, and that is currently provable: no host permissions, no
network call in any conversion path, and a build that fails if a remote resource
appears. A hosted page is served from somewhere. Even with all processing in the
browser, "nothing leaves your machine" becomes a statement about a server's
configuration rather than a property of the artefact. That claim is the reason a
surveyor would trust this with a cadastral sheet, and weakening it to gain a
second distribution channel is a bad trade.

**Nothing needs it yet.** The store route already removes the only real friction
— installing — and a store install works on any machine the user signs into.

### What a web build would need, when the time comes

Roughly, so the estimate is not rediscovered:

1. A fourth Vite entry point, and a storage adapter behind the `chrome.storage`
   calls in `state/store.ts`
2. File saving through the File System Access API, or an anchor download,
   instead of `chrome.downloads`
3. DWG dropped or moved behind an explicit upload — native messaging has no web
   equivalent
4. A privacy statement rewritten to describe hosting honestly, since the current
   one would no longer be true as written
5. A Content Security Policy on the served page that preserves the offline
   guarantee

The engines themselves — every reader, every writer, the CRS layer, QA,
prediction, measurement, snapping — need no change.

---

## Also out of scope, for now

| | Why |
|---|---|
| Firefox / Safari extensions | Different manifest dialects and review processes. Chromium first. |
| A desktop app (Electron, Tauri) | The extension already runs locally; a desktop shell adds an installer to maintain and removes nothing. |
| A server-side conversion API | Directly contradicts the local-processing rule (R8) that the product is built around. |
| Mobile | No file-system story worth having on either platform. |

---

## How to change this

Edit this file in the same commit as the work. A scope decision that lives only
in a conversation is one the next person re-litigates from scratch.
