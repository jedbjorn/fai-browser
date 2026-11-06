// A small ZIP writer and reader with no dependencies, for the add-on packages (scripts/package.mjs) and for checking a
// signed .xpi before the launcher installs it (src/launcher/addon.js).
//
// The writer is reproducible: entries are sorted by name, every entry has the same timestamp (SOURCE_DATE_EPOCH, or
// FIXED_ZIP_TIME), the same permissions (0644) and no extra fields, and deflate runs at a fixed level. The same files
// give the same bytes with the same Node major version (zlib is bundled with Node).
// The reader handles what the writer and web-ext/AMO produce: stored and deflated entries, no ZIP64, no encryption.
import { deflateRawSync, inflateRawSync } from 'node:zlib';

/** 2000-01-01T00:00:00Z: the entry time when SOURCE_DATE_EPOCH is not set. */
export const FIXED_ZIP_TIME = Date.UTC(2000, 0, 1);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** The entry time: SOURCE_DATE_EPOCH (seconds) when set, else FIXED_ZIP_TIME. */
export function zipTime(env = process.env) {
  const epoch = Number(env.SOURCE_DATE_EPOCH);
  return Number.isFinite(epoch) && epoch > 0 ? epoch * 1000 : FIXED_ZIP_TIME;
}

// MS-DOS date and time fields, from the UTC calendar fields (so the bytes do not depend on the time zone).
function dosDateTime(ms) {
  const date = new Date(Math.max(ms, Date.UTC(1980, 0, 1)));
  const time = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2);
  const day = ((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
  return { time, day };
}

/**
 * A ZIP archive of `entries` ([{ name, data }], data a Buffer or string; names use "/"): a Buffer. Entries are sorted
 * by name; duplicate names throw.
 */
export function createZip(entries, { time = zipTime() } = {}) {
  const sorted = [...entries].map(entry => ({ name: entry.name, data: Buffer.from(entry.data) }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const { time: dosTime, day: dosDay } = dosDateTime(time);
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (let index = 0; index < sorted.length; index++) {
    const { name, data } = sorted[index];
    if (!name || name.startsWith('/') || name.includes('\\') || name.split('/').includes('..')) {
      throw new Error(`Bad zip entry name: ${name}`);
    }
    if (index && sorted[index - 1].name === name) throw new Error(`Duplicate zip entry: ${name}`);
    const nameBytes = Buffer.from(name, 'utf8');
    const deflated = deflateRawSync(data, { level: 9 });
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDay, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by: Unix, 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDay, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(((0o100644 << 16) >>> 0), 38); // regular file, rw-r--r--
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

/** The entries of a ZIP archive: [{ name, method, size, compressedSize, read() }] (read() inflates one entry). */
export function readZip(buffer) {
  const zip = Buffer.from(buffer);
  let end = -1;
  for (let at = zip.length - 22; at >= Math.max(0, zip.length - 22 - 0xffff); at--) {
    if (zip.readUInt32LE(at) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new Error('Not a zip archive');
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const entries = [];
  for (let index = 0; index < count; index++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error('Corrupt zip central directory');
    const method = zip.readUInt16LE(at + 10);
    const crc = zip.readUInt32LE(at + 16);
    const compressedSize = zip.readUInt32LE(at + 20);
    const size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const localOffset = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    at += 46 + nameLength + extraLength + commentLength;
    entries.push({
      name, method, size, compressedSize, crc,
      read() {
        if (zip.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`Corrupt zip entry ${name}`);
        const start = localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
        const raw = zip.subarray(start, start + compressedSize);
        let data;
        if (method === 0) data = Buffer.from(raw);
        else if (method === 8) data = inflateRawSync(raw);
        else throw new Error(`Unsupported zip method ${method} for ${name}`);
        if (data.length !== size || crc32(data) !== crc) throw new Error(`Zip entry ${name} fails its checksum`);
        return data;
      },
    });
  }
  return entries;
}
