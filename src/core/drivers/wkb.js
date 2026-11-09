'use strict';
// MySQL/MariaDB geometry (4-byte SRID + WKB) to WKT text, so a GEOMETRY cell reads as POINT(1 2), not bytes.

function wkbToWkt(buf, withSrid) {
  let off = 0;
  let srid = 0;
  if (withSrid) { srid = buf.readUInt32LE(0); off = 4; }
  const out = read();
  return srid ? `SRID=${srid};${out}` : out;

  function read() {
    const le = buf[off] === 1; off += 1;
    const u32 = () => { const v = le ? buf.readUInt32LE(off) : buf.readUInt32BE(off); off += 4; return v; };
    const f64 = () => { const v = le ? buf.readDoubleLE(off) : buf.readDoubleBE(off); off += 8; return v; };
    const pt = () => `${num(f64())} ${num(f64())}`;
    const ring = () => { const n = u32(); if (n > 1e7) throw new Error('bad wkb'); const a = []; for (let i = 0; i < n; i++) a.push(pt()); return `(${a.join(', ')})`; };
    const type = u32() % 1000;
    switch (type) {
      case 1: return `POINT(${pt()})`;
      case 2: { const n = u32(); const a = []; for (let i = 0; i < n; i++) a.push(pt()); return `LINESTRING(${a.join(', ')})`; }
      case 3: { const n = u32(); const a = []; for (let i = 0; i < n; i++) a.push(ring()); return `POLYGON(${a.join(', ')})`; }
      case 4: case 5: case 6: case 7: {
        const n = u32();
        const parts = [];
        for (let i = 0; i < n; i++) parts.push(read());
        const name = { 4: 'MULTIPOINT', 5: 'MULTILINESTRING', 6: 'MULTIPOLYGON', 7: 'GEOMETRYCOLLECTION' }[type];
        if (type === 7) return `${name}(${parts.join(', ')})`;
        return `${name}(${parts.map((p) => p.replace(/^[A-Z]+/, '')).join(', ')})`;
      }
      default: throw new Error('unknown wkb type ' + type);
    }
  }
}

function num(x) {
  return Number.isInteger(x) ? String(x) : String(+x.toPrecision(15));
}

module.exports = { wkbToWkt };
