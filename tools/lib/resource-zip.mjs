// Minimal ZIP writer for local UTF-8 text snapshots; no filesystem extraction.
import { deflateRawSync } from 'node:zlib'

const table = new Uint32Array(256)
for (let n=0;n<256;n++) {let c=n;for(let i=0;i<8;i++) c=(c&1)?0xedb88320^(c>>>1):c>>>1;table[n]=c>>>0}
function crc32(bytes) {let c=0xffffffff;for(const b of bytes)c=table[(c^b)&255]^(c>>>8);return (c^0xffffffff)>>>0}

export function makeResourceZip(entries) {
  if (!Array.isArray(entries) || !entries.length || entries.length > 10000) throw Error('资源快照文件数量无效')
  const locals=[],centrals=[],names=new Set();let offset=0,total=0
  for(const entry of entries) {
    if(typeof entry.name !== 'string' || !/^[A-Za-z0-9_.\-/]+$/.test(entry.name) || entry.name.startsWith('/') || entry.name.split('/').some(x=>!x || x==='.' || x==='..') || names.has(entry.name)) throw Error('资源快照文件名无效或重复')
    names.add(entry.name)
    const name=Buffer.from(entry.name,'utf8'),data=Buffer.isBuffer(entry.data)?entry.data:Buffer.from(entry.data,'utf8')
    total+=data.length;if(total>50*1024*1024)throw Error('资源快照超过 50 MiB')
    const compressed=deflateRawSync(data),crc=crc32(data),h=Buffer.alloc(30)
    h.writeUInt32LE(0x04034b50,0);h.writeUInt16LE(20,4);h.writeUInt16LE(0x800,6);h.writeUInt16LE(8,8);h.writeUInt32LE(crc,14);h.writeUInt32LE(compressed.length,18);h.writeUInt32LE(data.length,22);h.writeUInt16LE(name.length,26)
    locals.push(h,name,compressed)
    const d=Buffer.alloc(46);d.writeUInt32LE(0x02014b50,0);d.writeUInt16LE(20,4);d.writeUInt16LE(20,6);d.writeUInt16LE(0x800,8);d.writeUInt16LE(8,10);d.writeUInt32LE(crc,16);d.writeUInt32LE(compressed.length,20);d.writeUInt32LE(data.length,24);d.writeUInt16LE(name.length,28);d.writeUInt32LE(offset,42)
    centrals.push(d,name);offset+=h.length+name.length+compressed.length
  }
  const directory=Buffer.concat(centrals),end=Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16)
  return Buffer.concat([...locals,directory,end])
}
