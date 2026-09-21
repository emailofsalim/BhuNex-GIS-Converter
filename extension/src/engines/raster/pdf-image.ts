/**
 * Pulling the scanned image out of a PDF page (phase G).
 *
 * ---------------------------------------------------------------------------
 * THE HONEST SUBSET, DECIDED UP FRONT
 *
 * A scanned survey sheet is, almost always, ONE raster image in a PDF wrapper:
 * a page whose entire content stream is "draw this XObject across the page".
 * Extracting that image needs an object parser and a stream decoder — a few
 * hundred lines — and the image itself is JPEG or Flate, both of which the
 * browser decodes natively.
 *
 * A VECTOR PDF is a completely different problem: a content-stream interpreter
 * with fonts, paths, clipping, transparency groups and blend modes. That is
 * what pdf.js is, it is over a megabyte, and bundling it would break R15 (no
 * runtime download) and the zero-dependency rule in the same stroke.
 *
 * So: a page whose content is a wrapped raster is supported, and a vector page
 * is REFUSED BY NAME with the reason and a way forward. That is the subset the
 * owner actually described — an old scanned sheet the tiles do not match — and
 * refusing the rest by name is better than a half-rendered page that looks like
 * a rendering bug.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS PARSER IS AND IS NOT
 *
 * It reads the file's objects by scanning for `N G obj … endobj`, which is the
 * simple path and works on the overwhelming majority of real PDFs, including
 * every scanner-produced one seen. It does NOT walk the cross-reference table,
 * so it does not depend on the xref being correct — which is fortunate,
 * because a PDF that has been appended to, signed, or repaired often has an
 * xref that no longer matches its objects.
 *
 * Encrypted PDFs are refused. Object streams (`/ObjStm`, PDF 1.5 compressed
 * objects) hold their page tree inside a Flate stream; images referenced from
 * such a page are still found by the scan, because an IMAGE is never inside an
 * object stream — only dictionaries are — so the practical effect is that page
 * ORDER may be unavailable while the images themselves are not. That is stated
 * rather than papered over.
 */

import { ConversionError } from '../../core/errors';
import { inflate } from './tiff-codec';
import { buildPng } from './png';

export interface PdfPageImage {
  /** 1-based page number this image was found on, or the image's order when unknown. */
  page: number;
  /** The encoded bytes, ready for `createImageBitmap` or a Blob URL. */
  bytes: Uint8Array;
  /** `image/jpeg` or `image/png`. */
  mimeType: string;
  width: number;
  height: number;
  /** How the PDF stored it, for the report. */
  filter: string;
}

export interface PdfScan {
  images: PdfPageImage[];
  /** How many pages the document declares, when it could be determined. */
  pageCount: number | null;
  notes: string[];
}

const ASCII = new TextDecoder('latin1');

/**
 * Finds the raster images in a PDF.
 *
 * Throws a `ConversionError` naming the reason when the file is encrypted or
 * holds no extractable raster — never returns an empty result silently, because
 * "nothing appeared" is indistinguishable on screen from "the import failed".
 */
export async function readPdfImages(bytes: Uint8Array): Promise<PdfScan> {
  const text = ASCII.decode(bytes);

  if (!text.startsWith('%PDF-')) {
    throw new ConversionError({
      code: 'PDF_NOT_A_PDF',
      what: 'This file does not begin with a PDF header.',
      why: 'Every PDF starts with %PDF-. This one does not, so it is a different format or the file is truncated.',
      action: 'Check the file, or import the sheet as a PNG or JPEG instead.',
    });
  }

  if (/\/Encrypt\b/.test(text)) {
    throw new ConversionError({
      code: 'PDF_ENCRYPTED',
      what: 'This PDF is encrypted.',
      why: 'Its streams are encrypted, so the image inside cannot be read without the password and the decryption this tool does not implement.',
      action: 'Remove the protection in a PDF reader and export the page again, or save the sheet as a PNG or JPEG.',
    });
  }

  const notes: string[] = [];
  const pageCount = countPages(text);
  const images = await extractImages(bytes, text, notes);

  if (images.length === 0) {
    throw new ConversionError({
      code: 'PDF_NO_RASTER',
      what: 'This PDF page holds drawn geometry, not a scanned image.',
      why:
        'It is a VECTOR PDF — lines, text and fills described as instructions rather than pixels. Rendering that needs a full content-stream interpreter with font handling, which is roughly a megabyte of engine and would have to be downloaded at runtime. This extension is built to work with the network disabled, so it is not bundled.',
      action:
        'Two ways forward, both quick: open the PDF and export the page as a PNG or JPEG, then import that; or, if the PDF came from CAD or GIS, export the source as DXF or Shapefile and convert it properly — a vector backdrop traced by hand is worse than the vectors you already have.',
    });
  }

  return { images, pageCount, notes };
}

/** How many pages the document says it has, or null when it cannot be told. */
function countPages(text: string): number | null {
  const counts = [...text.matchAll(/\/Type\s*\/Pages\b[^]{0,400}?\/Count\s+(\d+)/g)].map((match) => Number(match[1]));
  if (counts.length > 0) return Math.max(...counts);
  // Fall back to counting page objects, which is right for a simple document
  // and an under-count for one whose page tree lives in an object stream.
  const pages = [...text.matchAll(/\/Type\s*\/Page[^s]/g)].length;
  return pages > 0 ? pages : null;
}

interface RawObject {
  number: number;
  dict: string;
  streamStart: number;
  streamEnd: number;
}

/** Scans `N G obj … endobj` blocks, with their stream byte ranges. */
function scanObjects(bytes: Uint8Array, text: string): RawObject[] {
  const out: RawObject[] = [];
  const pattern = /(\d+)\s+(\d+)\s+obj\b/g;

  for (const match of text.matchAll(pattern)) {
    const start = match.index! + match[0].length;
    const end = text.indexOf('endobj', start);
    if (end < 0) continue;

    const body = text.slice(start, end);
    const streamAt = body.indexOf('stream');
    if (streamAt < 0) {
      out.push({ number: Number(match[1]), dict: body, streamStart: -1, streamEnd: -1 });
      continue;
    }

    // `stream` is followed by CRLF or LF, and exactly one of them — a parser
    // that assumes CRLF eats the first byte of a JPEG on a Unix-produced file,
    // which decodes as a corrupt image rather than as an error.
    let dataStart = start + streamAt + 'stream'.length;
    if (bytes[dataStart] === 0x0d) dataStart++;
    if (bytes[dataStart] === 0x0a) dataStart++;

    const dict = body.slice(0, streamAt);
    const endstream = text.indexOf('endstream', dataStart);
    const fallbackEnd = endstream < 0 ? end : endstream;

    out.push({
      number: Number(match[1]),
      dict,
      streamStart: dataStart,
      streamEnd: streamEndOf(dict, dataStart, fallbackEnd, bytes),
    });
  }
  return out;
}

function dictNumber(dict: string, key: string): number | null {
  const match = new RegExp(`/${key}\\s+(\\d+)`).exec(dict);
  return match ? Number(match[1]) : null;
}

/**
 * Where a stream's data actually ends.
 *
 * `/Length` is authoritative and is used when it is a direct integer. It often
 * is not: PDF permits `/Length 12 0 R`, an indirect reference whose value lives
 * in another object — and a naive `/Length\s+(\d+)` reads that as the object
 * NUMBER, which would truncate the stream to a dozen bytes. So the indirect
 * form is detected and rejected rather than half-understood.
 *
 * Without a usable `/Length`, the data ends just before `endstream` MINUS the
 * end-of-line that precedes it. That EOL is required by the specification and
 * is not part of the data. Including it appends a stray byte: harmless on a
 * JPEG, whose decoder stops at the end-of-image marker, and corrupting on a
 * Flate stream, where the inflater reads it as the start of another block.
 */
function streamEndOf(dict: string, dataStart: number, beforeEndstream: number, bytes: Uint8Array): number {
  // The `\b` is load-bearing. Without it, `/Length 12 0 R` still matches:
  // the engine tries `12`, the lookahead rejects it, and it BACKTRACKS to `1`
  // — which the lookahead then accepts, because `2 0 R` does not start with
  // whitespace. The result is a stream truncated to one byte. The boundary
  // stops the digits being shortened, so the whole number is what gets tested.
  const declared = /\/Length\s+(\d+)\b(?!\s+\d+\s+R)/.exec(dict);
  if (declared) {
    const length = Number(declared[1]);
    const end = dataStart + length;
    // Trusted only when it lands inside the file and at or before `endstream`.
    // A wrong /Length is common in hand-edited and repaired PDFs, and reading
    // past `endstream` would splice the next object into the image.
    if (Number.isFinite(length) && length >= 0 && end <= beforeEndstream && end <= bytes.length) return end;
  }

  let end = beforeEndstream;
  if (end > dataStart && bytes[end - 1] === 0x0a) end--;
  if (end > dataStart && bytes[end - 1] === 0x0d) end--;
  return end;
}

/** Every image XObject in the file, decoded as far as the browser can take it. */
async function extractImages(bytes: Uint8Array, text: string, notes: string[]): Promise<PdfPageImage[]> {
  const out: PdfPageImage[] = [];
  let skippedUnsupported = 0;

  for (const object of scanObjects(bytes, text)) {
    if (!/\/Subtype\s*\/Image\b/.test(object.dict)) continue;
    if (object.streamStart < 0) continue;

    const width = dictNumber(object.dict, 'Width');
    const height = dictNumber(object.dict, 'Height');
    if (!width || !height) continue;

    const filter = /\/Filter\s*(?:\[\s*)?\/(\w+)/.exec(object.dict)?.[1] ?? 'none';
    const data = bytes.subarray(object.streamStart, object.streamEnd);

    if (filter === 'DCTDecode') {
      // A JPEG, stored verbatim. The browser decodes it as-is.
      out.push({ page: out.length + 1, bytes: data.slice(), mimeType: 'image/jpeg', width, height, filter });
      continue;
    }

    if (filter === 'FlateDecode') {
      // Flate-compressed raw samples. Wrapped as a PNG rather than decoded
      // here: PNG's IDAT is the same zlib stream, so this is a re-container
      // rather than a re-encode, and the browser does the pixel work.
      const png = await flateImageToPng(data, object.dict, width, height);
      if (png) {
        out.push({ page: out.length + 1, bytes: png, mimeType: 'image/png', width, height, filter });
        continue;
      }
    }

    // JPXDecode (JPEG 2000), JBIG2Decode, CCITTFaxDecode: each needs its own
    // decoder. Counted and named rather than silently dropped.
    skippedUnsupported++;
  }

  if (skippedUnsupported > 0) {
    notes.push(
      `${skippedUnsupported} image(s) use a compression this build cannot decode — JPEG 2000, JBIG2 or CCITT fax. Re-export the page as a PNG or JPEG to use it as a backdrop.`
    );
  }
  return out;
}

/**
 * Re-containers a Flate-compressed image as a PNG.
 *
 * PNG's IDAT chunk holds exactly a zlib stream, and a PDF's FlateDecode stream
 * is exactly a zlib stream — but of UNFILTERED rows, while PNG expects a filter
 * byte at the start of each row. So the samples are inflated, the filter bytes
 * inserted, and the result re-deflated is avoided by storing the rows
 * uncompressed in a stored-block zlib wrapper. That trades file size for not
 * needing a compressor, which is the right trade for something that lives in
 * memory for one editing session.
 *
 * Returns null for anything but 8-bit RGB or grey, which are what a scanner
 * produces. An indexed or CMYK image needs its palette or its colour transform
 * applied, and guessing would produce a picture in the wrong colours that still
 * looks like a scan.
 */
async function flateImageToPng(
  data: Uint8Array,
  dict: string,
  width: number,
  height: number
): Promise<Uint8Array | null> {
  const bits = dictNumber(dict, 'BitsPerComponent');
  if (bits !== 8) return null;

  const space = /\/ColorSpace\s*\/(\w+)/.exec(dict)?.[1] ?? '';
  const channels = space === 'DeviceRGB' ? 3 : space === 'DeviceGray' ? 1 : 0;
  if (channels === 0) return null;

  let samples: Uint8Array;
  try {
    samples = await inflate(data);
  } catch {
    return null;
  }
  if (samples.length < width * height * channels) return null;

  const stride = width * channels;
  const raw = new Uint8Array((stride + 1) * height);
  for (let row = 0; row < height; row++) {
    raw[row * (stride + 1)] = 0; // filter type 0: none
    raw.set(samples.subarray(row * stride, (row + 1) * stride), row * (stride + 1) + 1);
  }

  return buildPng(raw, width, height, channels === 3 ? 2 : 0);
}


