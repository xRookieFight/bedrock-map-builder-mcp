import { deflateSync } from "node:zlib";

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
}

/** Simple RGBA canvas that encodes to PNG, enough for map previews. */
export class Canvas {
  readonly data: Uint8Array;
  constructor(readonly width: number, readonly height: number, bg: [number, number, number, number] = [0, 0, 0, 0]) {
    this.data = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) this.data.set(bg, i * 4);
  }

  set(x: number, y: number, c: [number, number, number] | [number, number, number, number]) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 4;
    const a = (c[3] ?? 255) / 255;
    if (a >= 1) {
      this.data[i] = c[0];
      this.data[i + 1] = c[1];
      this.data[i + 2] = c[2];
      this.data[i + 3] = 255;
      return;
    }
    this.data[i] = Math.round(c[0] * a + this.data[i] * (1 - a));
    this.data[i + 1] = Math.round(c[1] * a + this.data[i + 1] * (1 - a));
    this.data[i + 2] = Math.round(c[2] * a + this.data[i + 2] * (1 - a));
    this.data[i + 3] = Math.max(this.data[i + 3], Math.round(a * 255));
  }

  rect(x: number, y: number, w: number, h: number, c: [number, number, number] | [number, number, number, number]) {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) this.set(xx, yy, c);
  }

  png(): Buffer {
    const raw = Buffer.alloc((this.width * 4 + 1) * this.height);
    for (let y = 0; y < this.height; y++) {
      raw[y * (this.width * 4 + 1)] = 0;
      Buffer.from(this.data.buffer, this.data.byteOffset + y * this.width * 4, this.width * 4).copy(raw, y * (this.width * 4 + 1) + 1);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(this.width, 0);
    ihdr.writeUInt32BE(this.height, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", Buffer.alloc(0)),
    ]);
  }
}
