/**
 * The slice of FlatBuffers that FlatGeobuf needs, read and written by hand.
 *
 * WHY THIS EXISTS AT ALL. The registry recorded FlatGeobuf as `requiresWasm`,
 * with the note "decoding it needs a generated schema reader that is not part
 * of this build". The second half was true and the first half was not:
 * FlatBuffers is a plain little-endian binary layout over a DataView, with no
 * compression, no allocator and no runtime. What was missing was a few hundred
 * lines, not a WebAssembly module — and the difference matters, because
 * `requiresWasm` is what kept the format off the export list.
 *
 * THE LAYOUT, since the rest of this file assumes it:
 *
 *   A TABLE is a position in the buffer whose first four bytes are a SIGNED
 *   offset BACKWARDS to its vtable. Everything else is looked up through that
 *   vtable, which is what makes the format both forwards and backwards
 *   compatible: a field the writer omitted has offset 0 and reads as its
 *   default, and a field the reader does not know about is simply never asked
 *   for.
 *
 *   A VTABLE is: uint16 its own size, uint16 the table's size, then one uint16
 *   per field giving where that field sits relative to the table start.
 *
 *   SCALARS live inline at that position. STRINGS, VECTORS and TABLES live
 *   elsewhere and are referenced by a uint32 offset FORWARDS from the field.
 *
 * Everything is little-endian and every value is aligned to its own size.
 */

const SIZEOF_INT = 4;
const SIZEOF_SHORT = 2;
/** A vtable always has at least its two uint16 headers. */
const VTABLE_HEADER_BYTES = 4;

// ------------------------------------------------------------------- reading

/**
 * A view over one FlatBuffers table.
 *
 * Deliberately not a generated class. The FlatGeobuf schema has four tables and
 * about thirty fields between them, and hand-reading them by index keeps the
 * whole format visible in one file rather than behind a code generator that
 * would have to be run and committed.
 */
export class FlatTable {
  readonly view: DataView;
  readonly position: number;
  private readonly vtable: number;
  private readonly vtableSize: number;

  constructor(view: DataView, position: number) {
    this.view = view;
    this.position = position;
    // The offset to the vtable is SIGNED and subtracted: vtables usually sit
    // after the tables that use them, so the value is typically negative.
    this.vtable = position - view.getInt32(position, true);
    this.vtableSize = view.getUint16(this.vtable, true);
  }

  /**
   * Where field `index` sits, relative to the table, or 0 when it is absent.
   *
   * Absent is normal rather than exceptional — a writer omits every field left
   * at its default — so this returns 0 and the callers supply the default.
   */
  fieldOffset(index: number): number {
    const voffset = VTABLE_HEADER_BYTES + index * SIZEOF_SHORT;
    if (voffset >= this.vtableSize) return 0;
    return this.view.getUint16(this.vtable + voffset, true);
  }

  /** Follows a uint32 forward reference from `at` to the object it names. */
  private indirect(at: number): number {
    return at + this.view.getUint32(at, true);
  }

  bool(index: number, fallback = false): boolean {
    const offset = this.fieldOffset(index);
    return offset ? this.view.getUint8(this.position + offset) !== 0 : fallback;
  }

  uint8(index: number, fallback = 0): number {
    const offset = this.fieldOffset(index);
    return offset ? this.view.getUint8(this.position + offset) : fallback;
  }

  uint16(index: number, fallback = 0): number {
    const offset = this.fieldOffset(index);
    return offset ? this.view.getUint16(this.position + offset, true) : fallback;
  }

  int32(index: number, fallback = 0): number {
    const offset = this.fieldOffset(index);
    return offset ? this.view.getInt32(this.position + offset, true) : fallback;
  }

  /**
   * A 64-bit field as a JavaScript number.
   *
   * FlatGeobuf uses uint64 for the feature count, which cannot exceed what a
   * double represents exactly (2^53) in any file this tool can open — a file
   * with more features than that would be petabytes. Reading it as a BigInt and
   * converting would be the same value with more ceremony.
   */
  uint64(index: number, fallback = 0): number {
    const offset = this.fieldOffset(index);
    if (!offset) return fallback;
    return Number(this.view.getBigUint64(this.position + offset, true));
  }

  string(index: number): string | null {
    const offset = this.fieldOffset(index);
    if (!offset) return null;
    const at = this.indirect(this.position + offset);
    const length = this.view.getUint32(at, true);
    const bytes = new Uint8Array(this.view.buffer, this.view.byteOffset + at + SIZEOF_INT, length);
    return new TextDecoder().decode(bytes);
  }

  /** The element count of a vector field, 0 when absent. */
  vectorLength(index: number): number {
    const offset = this.fieldOffset(index);
    if (!offset) return 0;
    return this.view.getUint32(this.indirect(this.position + offset), true);
  }

  /** Where a vector's elements begin. */
  vectorStart(index: number): number {
    const offset = this.fieldOffset(index);
    if (!offset) return 0;
    return this.indirect(this.position + offset) + SIZEOF_INT;
  }

  /**
   * A vector of doubles, copied out.
   *
   * Copied rather than viewed, because a FlatBuffers vector is aligned to its
   * element size only when the writer bothered, and `new Float64Array(buffer,
   * byteOffset)` throws on a misaligned offset. A copy always works and the
   * coordinate arrays here are read once.
   */
  doubles(index: number): Float64Array {
    const count = this.vectorLength(index);
    if (count === 0) return new Float64Array(0);
    const start = this.vectorStart(index);
    const out = new Float64Array(count);
    for (let i = 0; i < count; i++) out[i] = this.view.getFloat64(start + i * 8, true);
    return out;
  }

  /** A vector of uint32, copied out for the same alignment reason. */
  uint32s(index: number): Uint32Array {
    const count = this.vectorLength(index);
    if (count === 0) return new Uint32Array(0);
    const start = this.vectorStart(index);
    const out = new Uint32Array(count);
    for (let i = 0; i < count; i++) out[i] = this.view.getUint32(start + i * 4, true);
    return out;
  }

  /** A vector of raw bytes, as a view — no alignment constraint on bytes. */
  bytes(index: number): Uint8Array {
    const count = this.vectorLength(index);
    if (count === 0) return new Uint8Array(0);
    return new Uint8Array(this.view.buffer, this.view.byteOffset + this.vectorStart(index), count);
  }

  /** A nested table field. */
  table(index: number): FlatTable | null {
    const offset = this.fieldOffset(index);
    if (!offset) return null;
    return new FlatTable(this.view, this.indirect(this.position + offset));
  }

  /** Element `at` of a vector of tables. */
  tableAt(index: number, at: number): FlatTable {
    const start = this.vectorStart(index) + at * SIZEOF_INT;
    return new FlatTable(this.view, start + this.view.getUint32(start, true));
  }
}

/** The root table of a buffer, at `base` (0, or 4 past a size prefix). */
export function rootTable(view: DataView, base = 0): FlatTable {
  return new FlatTable(view, base + view.getUint32(base, true));
}

// ------------------------------------------------------------------- writing

/**
 * Builds a FlatBuffers buffer.
 *
 * FlatBuffers is written BACK TO FRONT: every object is complete before
 * anything that refers to it, so an offset only ever points forwards into
 * already-written bytes and nothing has to be patched afterwards. That is why
 * strings and vectors must be created before `startObject`, and why the whole
 * thing lives at the END of the working buffer until `finish` trims it.
 */
export class FlatBuilder {
  private buffer: Uint8Array;
  private view: DataView;
  /** Unused bytes at the FRONT. Writing moves this down. */
  private space: number;
  private minAlign = 1;

  /** Field offsets of the object currently being built, indexed by field. */
  private currentVtable: number[] = [];
  private objectStart = 0;
  /** Positions of every vtable written, so identical ones can be shared. */
  private vtables: number[] = [];
  private nested = false;

  constructor(initialSize = 1024) {
    this.buffer = new Uint8Array(initialSize);
    this.view = new DataView(this.buffer.buffer);
    this.space = initialSize;
  }

  /** How many bytes have been written — also the position of the next one. */
  private get offset(): number {
    return this.buffer.length - this.space;
  }

  private grow(needed: number): void {
    while (this.space < needed) {
      const previous = this.buffer;
      // Doubling and copying to the END keeps every already-written byte at the
      // same distance from the end, so no offset already recorded moves.
      const next = new Uint8Array(previous.length * 2);
      next.set(previous, previous.length);
      this.space += previous.length;
      this.buffer = next;
      this.view = new DataView(next.buffer);
    }
  }

  /**
   * Reserves room for a value of `size` bytes plus `additional` bytes that will
   * follow it, padding so the value lands on its natural alignment.
   */
  private prep(size: number, additional: number): void {
    if (size > this.minAlign) this.minAlign = size;
    const alignBytes = (~(this.offset + additional) + 1) & (size - 1);
    this.grow(alignBytes + size + additional);
    for (let i = 0; i < alignBytes; i++) this.buffer[--this.space] = 0;
  }

  private writeUint8(value: number): void {
    this.buffer[--this.space] = value & 0xff;
  }

  private writeUint16(value: number): void {
    this.space -= 2;
    this.view.setUint16(this.space, value, true);
  }

  private writeInt32(value: number): void {
    this.space -= 4;
    this.view.setInt32(this.space, value, true);
  }

  private writeUint32(value: number): void {
    this.space -= 4;
    this.view.setUint32(this.space, value, true);
  }

  private writeFloat64(value: number): void {
    this.space -= 8;
    this.view.setFloat64(this.space, value, true);
  }

  private writeBigUint64(value: number): void {
    this.space -= 8;
    this.view.setBigUint64(this.space, BigInt(Math.max(0, Math.trunc(value))), true);
  }

  // --- objects -------------------------------------------------------------

  startObject(fieldCount: number): void {
    if (this.nested) throw new Error('FlatBuilder: an object was started inside another object.');
    this.nested = true;
    this.currentVtable = new Array(fieldCount).fill(0);
    this.objectStart = this.offset;
  }

  private slot(field: number): void {
    this.currentVtable[field] = this.offset;
  }

  addBool(field: number, value: boolean, fallback = false): void {
    if (value === fallback) return;
    this.prep(1, 0);
    this.writeUint8(value ? 1 : 0);
    this.slot(field);
  }

  addUint8(field: number, value: number, fallback = 0): void {
    if (value === fallback) return;
    this.prep(1, 0);
    this.writeUint8(value);
    this.slot(field);
  }

  addUint16(field: number, value: number, fallback = 0): void {
    if (value === fallback) return;
    this.prep(2, 0);
    this.writeUint16(value);
    this.slot(field);
  }

  addInt32(field: number, value: number, fallback = 0): void {
    if (value === fallback) return;
    this.prep(4, 0);
    this.writeInt32(value);
    this.slot(field);
  }

  addUint64(field: number, value: number, fallback = 0): void {
    if (value === fallback) return;
    this.prep(8, 0);
    this.writeBigUint64(value);
    this.slot(field);
  }

  /** References an already-written string, vector or table. */
  addOffset(field: number, target: number): void {
    if (target === 0) return;
    this.prep(SIZEOF_INT, 0);
    // Stored as the distance from here to there, so it survives the buffer
    // being reallocated and moved.
    this.writeUint32(this.offset - target + SIZEOF_INT);
    this.slot(field);
  }

  /**
   * Closes the object and writes its vtable, sharing an identical one.
   *
   * The sharing is not a micro-optimisation: a FlatGeobuf file is one Feature
   * table per feature, all with the same shape, so without dedup a
   * 40,000-parcel file carries 40,000 identical vtables.
   */
  endObject(): number {
    if (!this.nested) throw new Error('FlatBuilder: endObject without startObject.');
    this.writeInt32(0); // placeholder for the offset back to the vtable
    const objectEnd = this.offset;

    let last = this.currentVtable.length;
    while (last > 0 && this.currentVtable[last - 1] === 0) last--;

    for (let i = last - 1; i >= 0; i--) {
      this.writeUint16(this.currentVtable[i] === 0 ? 0 : objectEnd - this.currentVtable[i]);
    }
    this.writeUint16(objectEnd - this.objectStart);
    this.writeUint16((last + 2) * SIZEOF_SHORT);

    const vtableStart = this.offset;
    let existing = 0;
    for (const candidate of this.vtables) {
      if (this.sameVtable(vtableStart, candidate)) {
        existing = candidate;
        break;
      }
    }

    if (existing) {
      // Drop the vtable just written and point at the one already there.
      this.space = this.buffer.length - vtableStart;
      this.view.setInt32(this.buffer.length - objectEnd, existing - objectEnd, true);
    } else {
      this.vtables.push(vtableStart);
      this.view.setInt32(this.buffer.length - objectEnd, vtableStart - objectEnd, true);
    }

    this.nested = false;
    return objectEnd;
  }

  private sameVtable(a: number, b: number): boolean {
    const positionA = this.buffer.length - a;
    const positionB = this.buffer.length - b;
    const size = this.view.getUint16(positionA, true);
    if (size !== this.view.getUint16(positionB, true)) return false;
    for (let i = SIZEOF_SHORT; i < size; i += SIZEOF_SHORT) {
      if (this.view.getUint16(positionA + i, true) !== this.view.getUint16(positionB + i, true)) return false;
    }
    return true;
  }

  // --- strings and vectors -------------------------------------------------

  createString(value: string): number {
    const bytes = new TextEncoder().encode(value);
    // The trailing NUL is part of the format: it lets a C++ reader hand the
    // bytes straight to anything expecting a null-terminated string.
    this.prep(SIZEOF_INT, bytes.length + 1);
    this.writeUint8(0);
    this.space -= bytes.length;
    this.buffer.set(bytes, this.space);
    this.writeUint32(bytes.length);
    return this.offset;
  }

  createByteVector(bytes: Uint8Array): number {
    this.prep(SIZEOF_INT, bytes.length);
    this.space -= bytes.length;
    this.buffer.set(bytes, this.space);
    this.writeUint32(bytes.length);
    return this.offset;
  }

  createDoubleVector(values: ArrayLike<number>): number {
    this.prep(SIZEOF_INT, values.length * 8);
    this.prep(8, 0);
    for (let i = values.length - 1; i >= 0; i--) this.writeFloat64(values[i]);
    this.writeUint32(values.length);
    return this.offset;
  }

  createUint32Vector(values: ArrayLike<number>): number {
    this.prep(SIZEOF_INT, values.length * 4);
    for (let i = values.length - 1; i >= 0; i--) this.writeUint32(values[i]);
    this.writeUint32(values.length);
    return this.offset;
  }

  /** A vector of offsets to already-written objects. */
  createOffsetVector(offsets: number[]): number {
    this.prep(SIZEOF_INT, offsets.length * SIZEOF_INT);
    for (let i = offsets.length - 1; i >= 0; i--) {
      this.writeUint32(this.offset - offsets[i] + SIZEOF_INT);
    }
    this.writeUint32(offsets.length);
    return this.offset;
  }

  // --- finishing -----------------------------------------------------------

  /** Completes the buffer with `root` as its root table. */
  finish(root: number): Uint8Array {
    this.prep(this.minAlign, SIZEOF_INT);
    this.writeUint32(this.offset - root + SIZEOF_INT);
    return this.buffer.subarray(this.space);
  }
}
