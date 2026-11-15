/**
 * Little endian NBT, the flavour Bedrock uses on disk for .mcstructure files and level.dat.
 * Values keep their tag type so a read and write round trip gives the same bytes back.
 */
export type Tag =
  | { type: "byte"; value: number }
  | { type: "short"; value: number }
  | { type: "int"; value: number }
  | { type: "long"; value: bigint }
  | { type: "float"; value: number }
  | { type: "double"; value: number }
  | { type: "byteArray"; value: Int8Array }
  | { type: "string"; value: string }
  | { type: "list"; value: { type: TagType; items: Tag[] } }
  | { type: "compound"; value: Record<string, Tag> }
  | { type: "intArray"; value: Int32Array }
  | { type: "longArray"; value: BigInt64Array };

export type TagType = Tag["type"] | "end";

const IDS: TagType[] = [
  "end", "byte", "short", "int", "long", "float", "double", "byteArray", "string", "list", "compound", "intArray", "longArray",
];

export class NbtError extends Error {}

class Reader {
  off = 0;
  constructor(private readonly buf: Buffer) {}
  need(n: number) {
    if (this.off + n > this.buf.length) throw new NbtError(`unexpected end of NBT data at byte ${this.off}`);
  }
  u8() { this.need(1); return this.buf.readUInt8(this.off++); }
  i8() { this.need(1); return this.buf.readInt8(this.off++); }
  i16() { this.need(2); const v = this.buf.readInt16LE(this.off); this.off += 2; return v; }
  u16() { this.need(2); const v = this.buf.readUInt16LE(this.off); this.off += 2; return v; }
  i32() { this.need(4); const v = this.buf.readInt32LE(this.off); this.off += 4; return v; }
  i64() { this.need(8); const v = this.buf.readBigInt64LE(this.off); this.off += 8; return v; }
  f32() { this.need(4); const v = this.buf.readFloatLE(this.off); this.off += 4; return v; }
  f64() { this.need(8); const v = this.buf.readDoubleLE(this.off); this.off += 8; return v; }
  str() { const n = this.u16(); this.need(n); const s = this.buf.toString("utf8", this.off, this.off + n); this.off += n; return s; }
  len() {
    const n = this.i32();
    if (n < 0 || n > 64 * 1024 * 1024) throw new NbtError(`bad array length ${n}`);
    return n;
  }

  payload(type: TagType, depth: number): Tag {
    if (depth > 512) throw new NbtError("NBT nested too deep");
    switch (type) {
      case "byte": return { type, value: this.i8() };
      case "short": return { type, value: this.i16() };
      case "int": return { type, value: this.i32() };
      case "long": return { type, value: this.i64() };
      case "float": return { type, value: this.f32() };
      case "double": return { type, value: this.f64() };
      case "string": return { type, value: this.str() };
      case "byteArray": {
        const n = this.len(); this.need(n);
        const v = new Int8Array(n);
        for (let i = 0; i < n; i++) v[i] = this.buf.readInt8(this.off + i);
        this.off += n;
        return { type, value: v };
      }
      case "intArray": {
        const n = this.len(); this.need(n * 4);
        const v = new Int32Array(n);
        for (let i = 0; i < n; i++) v[i] = this.i32();
        return { type, value: v };
      }
      case "longArray": {
        const n = this.len(); this.need(n * 8);
        const v = new BigInt64Array(n);
        for (let i = 0; i < n; i++) v[i] = this.i64();
        return { type, value: v };
      }
      case "list": {
        const id = this.u8();
        const itemType = IDS[id];
        if (!itemType) throw new NbtError(`unknown list tag id ${id}`);
        const n = this.len();
        const items: Tag[] = [];
        for (let i = 0; i < n; i++) items.push(this.payload(itemType, depth + 1));
        return { type, value: { type: itemType, items } };
      }
      case "compound": {
        const value: Record<string, Tag> = {};
        for (;;) {
          const id = this.u8();
          if (id === 0) break;
          const t = IDS[id];
          if (!t) throw new NbtError(`unknown tag id ${id} at byte ${this.off - 1}`);
          const name = this.str();
          value[name] = this.payload(t, depth + 1);
        }
        return { type, value };
      }
      default:
        throw new NbtError(`cannot read tag type ${type}`);
    }
  }
}

/** Reads one named root tag. Returns the parsed tag and how many bytes it used. */
export function readNbt(buf: Buffer, offset = 0): { name: string; tag: Tag; length: number } {
  const r = new Reader(buf);
  r.off = offset;
  const id = r.u8();
  const t = IDS[id];
  if (!t || t === "end") throw new NbtError(`bad root tag id ${id}`);
  const name = r.str();
  const tag = r.payload(t, 0);
  return { name, tag, length: r.off - offset };
}

class Writer {
  private chunks: Buffer[] = [];
  private cur = Buffer.alloc(64 * 1024);
  private off = 0;
  ensure(n: number) {
    if (this.off + n <= this.cur.length) return;
    this.chunks.push(this.cur.subarray(0, this.off));
    this.cur = Buffer.alloc(Math.max(64 * 1024, n));
    this.off = 0;
  }
  u8(v: number) { this.ensure(1); this.cur.writeUInt8(v, this.off++); }
  i8(v: number) { this.ensure(1); this.cur.writeInt8(v, this.off++); }
  i16(v: number) { this.ensure(2); this.cur.writeInt16LE(v, this.off); this.off += 2; }
  i32(v: number) { this.ensure(4); this.cur.writeInt32LE(v, this.off); this.off += 4; }
  i64(v: bigint) { this.ensure(8); this.cur.writeBigInt64LE(v, this.off); this.off += 8; }
  f32(v: number) { this.ensure(4); this.cur.writeFloatLE(v, this.off); this.off += 4; }
  f64(v: number) { this.ensure(8); this.cur.writeDoubleLE(v, this.off); this.off += 8; }
  str(s: string) {
    const b = Buffer.from(s, "utf8");
    if (b.length > 0xffff) throw new NbtError("NBT string longer than 65535 bytes");
    this.ensure(2 + b.length);
    this.cur.writeUInt16LE(b.length, this.off);
    this.off += 2;
    b.copy(this.cur, this.off);
    this.off += b.length;
  }
  payload(t: Tag) {
    switch (t.type) {
      case "byte": return this.i8(t.value);
      case "short": return this.i16(t.value);
      case "int": return this.i32(t.value);
      case "long": return this.i64(t.value);
      case "float": return this.f32(t.value);
      case "double": return this.f64(t.value);
      case "string": return this.str(t.value);
      case "byteArray": this.i32(t.value.length); for (const v of t.value) this.i8(v); return;
      case "intArray": this.i32(t.value.length); for (const v of t.value) this.i32(v); return;
      case "longArray": this.i32(t.value.length); for (const v of t.value) this.i64(v); return;
      case "list":
        // hmm, empty lists still need a type id, Bedrock writes "end" for those and so do we
        this.u8(IDS.indexOf(t.value.items.length ? t.value.type : "end"));
        this.i32(t.value.items.length);
        for (const it of t.value.items) this.payload(it);
        return;
      case "compound":
        for (const [k, v] of Object.entries(t.value)) {
          this.u8(IDS.indexOf(v.type));
          this.str(k);
          this.payload(v);
        }
        this.u8(0);
        return;
    }
  }
  done(): Buffer {
    this.chunks.push(this.cur.subarray(0, this.off));
    return Buffer.concat(this.chunks);
  }
}

export function writeNbt(tag: Tag, name = ""): Buffer {
  const w = new Writer();
  w.u8(IDS.indexOf(tag.type));
  w.str(name);
  w.payload(tag);
  return w.done();
}

// small builders so callers don't drown in { type, value } noise
export const nbt = {
  byte: (value: number): Tag => ({ type: "byte", value }),
  short: (value: number): Tag => ({ type: "short", value }),
  int: (value: number): Tag => ({ type: "int", value }),
  long: (value: bigint | number): Tag => ({ type: "long", value: BigInt(value) }),
  float: (value: number): Tag => ({ type: "float", value }),
  string: (value: string): Tag => ({ type: "string", value }),
  list: (type: TagType, items: Tag[]): Tag => ({ type: "list", value: { type, items } }),
  compound: (value: Record<string, Tag>): Tag => ({ type: "compound", value }),
};

/** Turns a tag into plain JSON friendly values, longs become strings. */
export function toPlain(t: Tag): unknown {
  switch (t.type) {
    case "long": return t.value.toString();
    case "byteArray": case "intArray": return Array.from(t.value);
    case "longArray": return Array.from(t.value, (v) => v.toString());
    case "list": return t.value.items.map(toPlain);
    case "compound": return Object.fromEntries(Object.entries(t.value).map(([k, v]) => [k, toPlain(v)]));
    default: return t.value;
  }
}
