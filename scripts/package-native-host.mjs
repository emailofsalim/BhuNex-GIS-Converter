/**
 * Packages the DWG helper as its own release asset.
 *
 * WHY IT IS NOT IN THE EXTENSION ZIP
 *
 * The extension archive is what a browser loads through "Load unpacked", and it
 * is checked against the Chrome Web Store and Edge Add-ons rules before it is
 * published. Python scripts have no business in it: they cannot run there, they
 * would be dead weight in every download, and an executable script inside an
 * extension package is exactly the sort of thing a store review flags.
 *
 * WHY IT IS NOT LEFT IN THE REPOSITORY ONLY
 *
 * Because the Help dialog now offers the helper as a download, and that offer
 * has to be true. Before this, `native-host/` was tracked in git and absent
 * from every release archive: someone who followed the release-page route —
 * which is the route the install instructions recommend — got no helper at all
 * and no hint that they were looking in the wrong place.
 *
 * So it ships beside the extension as its own small ZIP, carrying its own
 * README so the folder explains itself once it is unzipped away from this
 * repository.
 */

import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDeflateRaw } from 'node:zlib';
import { Buffer } from 'node:buffer';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = join(root, 'native-host');
const outDir = join(root, 'dist-zip');

const manifest = JSON.parse(await readFile(join(root, 'extension', 'manifest.json'), 'utf8'));
const version = manifest.version;
const outPath = join(outDir, `bhunex-native-host-${version}.zip`);

/** CRC-32, table-driven. A ZIP entry is rejected without it. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function deflate(buffer) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    const stream = createDeflateRaw({ level: 9 });
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolvePromise(Buffer.concat(chunks)));
    stream.on('error', reject);
    stream.end(buffer);
  });
}

const README = `BhuNex DWG helper
=================

A Chrome or Edge extension cannot execute a file converter. This small program
runs on your own machine, and the extension hands it DWG bytes over Chrome's
native-messaging channel. It drives the ODA File Converter you install
separately, and returns DXF.

IT IS ENTIRELY OPTIONAL. Everything else in BhuNex GIS Converter — every other
import and export format, every QA check, every edit — runs in the browser with
nothing installed. Install this only if you need to read or write DWG.

NOTHING LEAVES YOUR MACHINE. The helper is a local process. It makes no network
request; it reads the bytes the extension passes it, calls a converter already
on your disk, and passes the result back.

BEFORE YOU START
----------------

1. Python 3.9 or newer.
2. ODA File Converter, a free download from the Open Design Alliance. Install
   it and note where it went.

INSTALL
-------

    python install.py

That registers this helper with Chrome and Edge for this extension only.

If ODA File Converter did not land in one of the usual places, open
host-config.json and put its full path in "odaExecutable".

CHECK IT WORKED
---------------

Open the converter workspace. The top bar reads:

    Native engine: ready        the helper answered
    Native engine: unknown      it has not been asked yet
    Native engine: unavailable  it is not installed, or not reachable

If it says unavailable after installing, the usual causes are a Python that is
not on PATH, or an "odaExecutable" path that does not exist.

REMOVING IT
-----------

    python install.py --uninstall

DWG support switches off. Nothing else changes.
`;

await rm(outPath, { force: true });
await mkdir(outDir, { recursive: true });

const entries = [];
for (const name of (await readdir(sourceDir)).sort()) {
  entries.push({ name, bytes: await readFile(join(sourceDir, name)) });
}
entries.push({ name: 'README.txt', bytes: Buffer.from(README, 'utf8') });

if (entries.length < 4) {
  throw new Error(`Expected the helper's files plus a README; found ${entries.length}.`);
}

const chunks = [];
const central = [];
let offset = 0;

for (const entry of entries) {
  const nameBytes = Buffer.from(entry.name, 'utf8');
  const crc = crc32(entry.bytes);
  const compressed = await deflate(entry.bytes);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt16LE(0, 10);
  local.writeUInt16LE(0, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(entry.bytes.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  local.writeUInt16LE(0, 28);

  chunks.push(local, nameBytes, compressed);

  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(8, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt16LE(0, 14);
  header.writeUInt32LE(crc, 16);
  header.writeUInt32LE(compressed.length, 20);
  header.writeUInt32LE(entry.bytes.length, 24);
  header.writeUInt16LE(nameBytes.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  // 0o644 for a plain file, 0o755 for the installer: a helper that unzips
  // without its execute bit is a support question nobody should have to ask.
  const mode = entry.name.endsWith('.py') ? 0o755 : 0o644;
  header.writeUInt32LE((mode << 16) >>> 0, 38);
  header.writeUInt32LE(offset, 42);
  central.push(Buffer.concat([header, nameBytes]));

  offset += local.length + nameBytes.length + compressed.length;
}

const centralBuffer = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(0, 4);
end.writeUInt16LE(0, 6);
end.writeUInt16LE(entries.length, 8);
end.writeUInt16LE(entries.length, 10);
end.writeUInt32LE(centralBuffer.length, 12);
end.writeUInt32LE(offset, 16);
end.writeUInt16LE(0, 20);

await new Promise((resolvePromise, reject) => {
  const out = createWriteStream(outPath);
  out.on('error', reject);
  out.on('finish', resolvePromise);
  out.end(Buffer.concat([...chunks, centralBuffer, end]));
});

const total = entries.reduce((sum, entry) => sum + entry.bytes.length, 0);
console.log(
  `Helper packaged — ${entries.length} files, ${(total / 1024).toFixed(1)} kB uncompressed, at dist-zip/bhunex-native-host-${version}.zip`
);
