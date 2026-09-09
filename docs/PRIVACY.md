# Privacy Policy — BhuNex GIS Converter

**Last updated: 7 September 2026**
**Applies to: BhuNex GIS Converter browser extension, all versions**

---

## The short version

**This extension collects nothing, sends nothing, and contacts no server.**

Every file you open is read, converted and written inside your own browser, on
your own computer. No file, no fragment of a file, no filename, no coordinate
and no measurement is transmitted anywhere. There is no account, no login, no
analytics, no telemetry, no crash reporting and no advertising.

This is not a policy choice that could quietly change in a later version. It is
enforced by how the extension is built, and the enforcement is described below
so you can verify it rather than take our word for it.

---

## What data is processed, and where

| Data | What happens to it | Where it goes |
|---|---|---|
| Files you open (DXF, Shapefile, LAS, GeoTIFF, CSV, KML …) | Read into memory, converted, written back out | Your computer only. Never transmitted. |
| Coordinates, attributes, survey measurements | Transformed by the conversion engines | Your computer only. Never transmitted. |
| Your settings (output format, precision, CRS, layout) | Saved so the extension remembers them | `chrome.storage.local` on your computer |
| Recently used formats and CRS codes | Saved to order the pickers usefully | `chrome.storage.local` on your computer |
| Converted output | Written to your Downloads folder when you click Download | Your computer only |

Nothing in that table leaves your machine.

---

## What is NOT collected

To be explicit, because "we may collect" clauses are where policies usually hide
things. This extension does **not** collect, transmit, sell, share or store:

- Personally identifiable information — name, address, email, phone, ID numbers
- Health information
- Financial or payment information
- Authentication information — passwords, tokens, credentials
- Personal communications — email, messages, chat
- Location — neither your device location nor the geographic content of your files
- Web history, browsing activity, or the contents of any web page
- User activity — clicks, scrolls, keystrokes, mouse position
- Any file content, filename, file size or file count
- Any identifier that could be used to recognise you or your device
- Anything at all, of any kind, by any means

There is no analytics package, no error reporting service, no A/B testing, no
usage counter and no "anonymous statistics".

---

## How you can verify this

You do not have to trust this document.

**1. The extension declares no host permissions.**
Open `chrome://extensions`, find this extension, click **Details**. Under *Site
access* you will see that it requests access to no websites at all. A browser
extension physically cannot send your data to a server it has no permission to
contact.

**2. Watch the network yourself.**
Open the converter workspace, press **F12** for developer tools, go to the
**Network** tab, and convert a file. You will see no requests, because none are
made.

**3. Turn the network off.**
Disconnect from the internet or Wi-Fi entirely and convert a file. Everything
works exactly the same. The extension is built to run offline and is tested
that way.

**4. Read the source.**
The complete source is public at
<https://github.com/emailofsalim/Universal-Converter>. The build pipeline runs a
check (`scripts/assert-offline.mjs`) that **fails the build** if any remote
script, stylesheet, font or network call appears in the packaged extension —
including a map tile URL from a service that has not been reviewed.

---

## The one thing that can make a network request: the map basemap

There is exactly one optional feature that contacts a server, and it is **off
until you turn it on**.

If you enable **Settings → Map basemap**, the workspace draws map tiles
underneath your data so you can see where it sits. To do that it asks a tile
server (OpenStreetMap by default) for the map squares covering the area on
screen.

| | |
|---|---|
| **What is sent** | Tile coordinates — a zoom level and a grid reference, the same request any web map makes. |
| **What is never sent** | File bytes. File names. Attribute values. Coordinates from your data. Anything identifying you beyond the ordinary IP address of any web request. |
| **What the server can infer** | Roughly which area of the world you are looking at. If the *location* of your survey is itself confidential, leave this off. |
| **Effect on conversion** | None. No conversion, QA check, measurement or exported file is affected by the basemap in any way, and turning it on cannot change a single byte of any output. |
| **With no network** | Nothing is drawn, and everything else behaves exactly as it always does. |

Tiles are drawn from an `<img>` element, which is why the extension still
declares **no host permissions**: it cannot read a response, only display an
image. You can revoke the whole capability at any time by switching the setting
off, and it stays off across restarts.

Google, Bing and Esri imagery are **not** offered as built-in options, because
their tile endpoints are not licensed for direct use outside their own APIs.
Wiring one in would work and would put you in breach of terms you never agreed
to. If you hold a key or a licence for one, there is a custom URL field where
you can use it under the terms you actually hold.

---

## Permissions, and why each one exists

Browsers ask you to approve permissions without explaining what they are for.
Here is every permission this extension requests and the reason for it.

### Granted at install

| Permission | Why it is needed | What it does NOT allow |
|---|---|---|
| `storage` | Remembers your settings — output format, precision, CRS, layout — between sessions | Cannot read anything outside this extension's own storage |
| `unlimitedStorage` | Lifts the 5 MB storage cap so a large point cloud or raster can be held while converting | Same as above; only this extension's storage |
| `downloads` | Saves your converted file when you click Download | Cannot read your existing downloads or browse your disk |
| `sidePanel` | Draws the side panel for quick conversions beside a page | Cannot read the page it sits beside |

**No host permissions are requested.** The extension cannot read, modify or
access any website you visit. It has no content scripts.

### Requested only if you use it

| Permission | Why | When |
|---|---|---|
| `nativeMessaging` | DWG has no browser-readable format, so DWG conversion talks to a small helper program **you install yourself** that drives **your own** copy of ODA File Converter | Asked for the first time you convert a DWG file, and never before |

This permission is **optional**. If you never convert a DWG, it is never
requested and never granted. If you decline it, every other format continues to
work normally. The helper is a program on your own computer — it is not a
server, and it has no network access of its own.

---

## Data retention and deletion

Because nothing is collected, there is nothing held to delete.

Your settings live in your browser's local storage on your own device. To erase
them, remove the extension: `chrome://extensions` → **Remove**. That deletes
everything the extension has ever stored.

Your converted files are yours; they are wherever you saved them.

---

## Children

The extension collects no data from anyone, of any age.

---

## Third parties

There are none. The extension bundles no third-party analytics, no advertising
SDK, no crash reporter and no runtime dependency of any kind. It uses only the
browser's own built-in capabilities.

No data is sold, rented, shared or disclosed to anyone, because none is
collected.

---

## Changes to this policy

If this policy ever changes, the change will be published in this file with a
new date, and the version history is public in the repository's git log — so
any change is permanently visible rather than quietly swapped in.

A future version that collected data would be a different product, and would
require your explicit consent through a new permission prompt that the browser
itself would show you.

---

## Contact

Questions, or a privacy problem to report:

- **Issues:** <https://github.com/emailofsalim/Universal-Converter/issues>
- **Repository:** <https://github.com/emailofsalim/Universal-Converter>

---

## Compliance statements

**Chrome Web Store — Limited Use disclosure.** This extension's use of
information received from Google APIs adheres to the
[Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq/),
including the Limited Use requirements. In practice this extension receives no
information from any Google API, and transmits no user data at all.

**Data handling certification.** The developer certifies that this extension:
does not sell user data to third parties; does not use or transfer user data for
purposes unrelated to the item's single purpose; and does not use or transfer
user data to determine creditworthiness or for lending purposes. These are true
by construction, since no user data is collected or transmitted.

**GDPR.** No personal data is collected or processed by the developer, so there
is no controller, no processor and no lawful-basis question to answer. Files you
convert are processed locally by software running on your own device, under your
own control.
