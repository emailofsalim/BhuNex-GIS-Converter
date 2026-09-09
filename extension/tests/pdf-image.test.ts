/**
 * Getting the scan out of a PDF (phase G).
 *
 * The PDFs here are built byte by byte rather than checked in as fixtures, so
 * every structural detail a test depends on is visible in the test: where the
 * stream starts, which newline follows `stream`, what the dictionary says. A
 * binary fixture would make a failure here mean "something in the file changed"
 * rather than pointing at the rule that broke.
 *
 * The behaviour that matters most is the REFUSAL. A vector PDF is out of scope
 * by an explicit decision — rendering one needs a content-stream interpreter
 * with font handling, which is about a megabyte of engine and would have to be
 * downloaded at runtime, breaking the offline rule. So it must be refused BY
 * NAME with a way forward, never half-rendered.
 */

import { describe, expect, it } from 'vitest';
import { ConversionError } from '@core/errors';
import { readPdfImages } from '@engines/raster/pdf-image';

const encoder = new TextEncoder();

function bytes(...parts: (string | Uint8Array)[]): Uint8Array {
  const encoded = parts.map((part) => (typeof part === 'string' ? encoder.encode(part) : part));
  const total = encoded.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of encoded) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** The first bytes of a JPEG: SOI plus an APP0 marker. Enough to be recognisable. */
const JPEG_BODY = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);

function jpegPdf(options: { newline?: string; pages?: number } = {}): Uint8Array {
  const newline = options.newline ?? '\n';
  return bytes(
    '%PDF-1.4\n',
    `1 0 obj\n<< /Type /Pages /Count ${options.pages ?? 1} >>\nendobj\n`,
    '2 0 obj\n<< /Type /XObject /Subtype /Image /Width 640 /Height 480 /BitsPerComponent 8 /ColorSpace /DeviceRGB /Filter /DCTDecode /Length 14 >>\nstream',
    newline,
    JPEG_BODY,
    '\nendstream\nendobj\n',
    '%%EOF\n'
  );
}

describe('finding the scan', () => {
  it('extracts a JPEG page image with its dimensions', async () => {
    const scan = await readPdfImages(jpegPdf());
    expect(scan.images).toHaveLength(1);
    expect(scan.images[0].mimeType).toBe('image/jpeg');
    expect(scan.images[0].width).toBe(640);
    expect(scan.images[0].height).toBe(480);
    expect(scan.images[0].filter).toBe('DCTDecode');
  });

  it('extracts the JPEG bytes intact, starting at the SOI marker', async () => {
    const scan = await readPdfImages(jpegPdf());
    expect(scan.images[0].bytes[0]).toBe(0xff);
    expect(scan.images[0].bytes[1]).toBe(0xd8);
    expect(scan.images[0].bytes).toEqual(JPEG_BODY);
  });

  it('handles a CRLF after `stream` without eating the first byte', async () => {
    // The classic off-by-one in a PDF parser: `stream` is followed by CRLF or
    // by LF, and exactly one of them. Assuming the wrong one truncates the
    // JPEG's SOI marker, and the result decodes as a corrupt image rather than
    // as an error anybody can act on.
    const scan = await readPdfImages(jpegPdf({ newline: '\r\n' }));
    expect(scan.images[0].bytes[0]).toBe(0xff);
    expect(scan.images[0].bytes[1]).toBe(0xd8);
    expect(scan.images[0].bytes).toEqual(JPEG_BODY);
  });

  it('trims the end-of-line that precedes `endstream`', async () => {
    // The specification requires that EOL and it is not part of the data.
    // Including it appends a stray byte: harmless on a JPEG, whose decoder
    // stops at the end-of-image marker, and corrupting on a Flate stream where
    // the inflater reads it as the start of another block. Here /Length is
    // absent, so the trim is the only thing that gets it right.
    const noLength = bytes(
      '%PDF-1.4\n',
      '1 0 obj\n<< /Type /Pages /Count 1 >>\nendobj\n',
      '2 0 obj\n<< /Subtype /Image /Width 8 /Height 8 /Filter /DCTDecode >>\nstream\n',
      JPEG_BODY,
      '\nendstream\nendobj\n',
      '%%EOF\n'
    );
    const scan = await readPdfImages(noLength);
    expect(scan.images[0].bytes).toEqual(JPEG_BODY);
  });

  it('does not read an indirect /Length as the stream length', async () => {
    // `/Length 12 0 R` points at another object. A naive `/Length\s+(\d+)`
    // reads 12 and truncates a 14-byte image to a dozen bytes — which decodes
    // as a corrupt scan rather than as an error.
    const indirect = bytes(
      '%PDF-1.4\n',
      '1 0 obj\n<< /Type /Pages /Count 1 >>\nendobj\n',
      '2 0 obj\n<< /Subtype /Image /Width 8 /Height 8 /Filter /DCTDecode /Length 12 0 R >>\nstream\n',
      JPEG_BODY,
      '\nendstream\nendobj\n',
      '%%EOF\n'
    );
    const scan = await readPdfImages(indirect);
    expect(scan.images[0].bytes).toEqual(JPEG_BODY);
    expect(scan.images[0].bytes).toHaveLength(14);
  });

  it('ignores a /Length that would read past `endstream`', async () => {
    // A wrong /Length is common in hand-edited and repaired PDFs. Trusting one
    // that overruns would splice the next object into the image.
    const tooLong = bytes(
      '%PDF-1.4\n',
      '1 0 obj\n<< /Type /Pages /Count 1 >>\nendobj\n',
      '2 0 obj\n<< /Subtype /Image /Width 8 /Height 8 /Filter /DCTDecode /Length 9999 >>\nstream\n',
      JPEG_BODY,
      '\nendstream\nendobj\n',
      '%%EOF\n'
    );
    const scan = await readPdfImages(tooLong);
    expect(scan.images[0].bytes).toEqual(JPEG_BODY);
  });

  it('reports the page count so the picker has pages to offer', async () => {
    expect((await readPdfImages(jpegPdf({ pages: 7 }))).pageCount).toBe(7);
  });

  it('finds every image in a multi-page scan', async () => {
    const twoPages = bytes(
      '%PDF-1.4\n',
      '1 0 obj\n<< /Type /Pages /Count 2 >>\nendobj\n',
      '2 0 obj\n<< /Subtype /Image /Width 100 /Height 50 /Filter /DCTDecode /Length 14 >>\nstream\n',
      JPEG_BODY,
      '\nendstream\nendobj\n',
      '3 0 obj\n<< /Subtype /Image /Width 200 /Height 80 /Filter /DCTDecode /Length 14 >>\nstream\n',
      JPEG_BODY,
      '\nendstream\nendobj\n',
      '%%EOF\n'
    );
    const scan = await readPdfImages(twoPages);
    expect(scan.images.map((image) => image.width)).toEqual([100, 200]);
    expect(scan.images.map((image) => image.page)).toEqual([1, 2]);
  });
});

describe('what it refuses, and how clearly', () => {
  it('refuses a vector PDF by name, with two ways forward', async () => {
    // The decision this module is built around. A user whose sheet is vector
    // must find that out immediately and be told what to do, not watch a blank
    // backdrop and conclude the import is broken.
    const vector = bytes(
      '%PDF-1.4\n',
      '1 0 obj\n<< /Type /Pages /Count 1 >>\nendobj\n',
      '2 0 obj\n<< /Type /Page /Contents 3 0 R >>\nendobj\n',
      '3 0 obj\n<< /Length 40 >>\nstream\n0 0 m 100 100 l S\nendstream\nendobj\n',
      '%%EOF\n'
    );
    await expect(readPdfImages(vector)).rejects.toThrow(ConversionError);
    try {
      await readPdfImages(vector);
    } catch (error) {
      const structured = (error as ConversionError).toJSON();
      expect(structured.code).toBe('PDF_NO_RASTER');
      expect(structured.why).toContain('VECTOR PDF');
      // The reason must name the trade-off rather than just saying no.
      expect(structured.why).toContain('network disabled');
      // And the action must be usable without knowing anything about PDFs.
      expect(structured.action).toContain('PNG or JPEG');
      expect(structured.action).toContain('DXF');
    }
  });

  it('refuses an encrypted PDF rather than producing noise', async () => {
    const encrypted = bytes(
      '%PDF-1.4\n',
      '1 0 obj\n<< /Type /Pages /Count 1 >>\nendobj\n',
      'trailer\n<< /Encrypt 9 0 R >>\n',
      '%%EOF\n'
    );
    await expect(readPdfImages(encrypted)).rejects.toThrow(/encrypted/i);
  });

  it('refuses a file that is not a PDF at all', async () => {
    await expect(readPdfImages(encoder.encode('GIF89a not a pdf'))).rejects.toThrow(/PDF header/);
  });

  it('names an unsupported compression instead of dropping it silently', async () => {
    // JPEG 2000 in a PDF is real and needs its own decoder. The user gets a
    // note saying which, so re-exporting the page is an obvious next step.
    const mixed = bytes(
      '%PDF-1.4\n',
      '1 0 obj\n<< /Type /Pages /Count 1 >>\nendobj\n',
      '2 0 obj\n<< /Subtype /Image /Width 100 /Height 50 /Filter /JPXDecode /Length 4 >>\nstream\n',
      new Uint8Array([1, 2, 3, 4]),
      '\nendstream\nendobj\n',
      '3 0 obj\n<< /Subtype /Image /Width 640 /Height 480 /Filter /DCTDecode /Length 14 >>\nstream\n',
      JPEG_BODY,
      '\nendstream\nendobj\n',
      '%%EOF\n'
    );
    const scan = await readPdfImages(mixed);
    expect(scan.images).toHaveLength(1);
    expect(scan.notes.join(' ')).toContain('JPEG 2000');
  });

  it('skips an image object with no dimensions rather than guessing them', async () => {
    const noSize = bytes(
      '%PDF-1.4\n',
      '1 0 obj\n<< /Type /Pages /Count 1 >>\nendobj\n',
      '2 0 obj\n<< /Subtype /Image /Filter /DCTDecode /Length 14 >>\nstream\n',
      JPEG_BODY,
      '\nendstream\nendobj\n',
      '%%EOF\n'
    );
    await expect(readPdfImages(noSize)).rejects.toThrow(/PDF_NO_RASTER|vector/i);
  });
});
