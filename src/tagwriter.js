'use strict';
/**
 * tagwriter.js — Pure Node.js audio tag writer (no npm deps)
 * Supports: MP3 (ID3v2.3), FLAC (Vorbis Comments + PICTURE block), OGG Vorbis, M4A/AAC (iTunes atoms)
 */
const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function ext(filePath){ return path.extname(filePath).toLowerCase().replace('.',''); }

function encodeUtf8(str){ return Buffer.from(String(str||''), 'utf8'); }

function writeSyncsafe(n){
  // 4-byte syncsafe integer (ID3)
  const b = Buffer.alloc(4);
  b[3] = n & 0x7f; n >>= 7;
  b[2] = n & 0x7f; n >>= 7;
  b[1] = n & 0x7f; n >>= 7;
  b[0] = n & 0x7f;
  return b;
}
function readSyncsafe(buf, off){
  return ((buf[off]&0x7f)<<21)|((buf[off+1]&0x7f)<<14)|((buf[off+2]&0x7f)<<7)|(buf[off+3]&0x7f);
}
function readUint32BE(buf, off){ return buf.readUInt32BE(off); }
function writeUint32BE(n){
  const b = Buffer.alloc(4); b.writeUInt32BE(n>>>0, 0); return b;
}

// ─────────────────────────────────────────────────────────────────────────────
// MP3 / ID3v2.3
// ─────────────────────────────────────────────────────────────────────────────
function makeID3TextFrame(id, text){
  const enc  = Buffer.from([0x03]); // UTF-8
  const data = encodeUtf8(text);
  const size = writeSyncsafe(enc.length + data.length);
  const flags = Buffer.alloc(2);
  return Buffer.concat([Buffer.from(id,'ascii'), size, flags, enc, data]);
}

function makeID3PictureFrame(mimeType, imageData){
  // APIC frame: encoding(1) + mime(z) + 0x00 + picType(1) + desc(z) + 0x00 + data
  const enc      = Buffer.from([0x03]); // UTF-8
  const mime     = Buffer.from(mimeType || 'image/jpeg', 'ascii');
  const nul      = Buffer.from([0x00]);
  const picType  = Buffer.from([0x03]); // Cover (front)
  const desc     = Buffer.from([0x00]); // empty description + null terminator
  const imgBuf   = Buffer.isBuffer(imageData) ? imageData : Buffer.from(imageData, 'base64');
  const payload  = Buffer.concat([enc, mime, nul, picType, desc, imgBuf]);
  const size     = writeSyncsafe(payload.length);
  const flags    = Buffer.alloc(2);
  return Buffer.concat([Buffer.from('APIC','ascii'), size, flags, payload]);
}

function makeID3TXXXFrame(desc, value){
  const enc  = Buffer.from([0x03]);
  const d    = encodeUtf8(desc);
  const nul  = Buffer.from([0x00]);
  const v    = encodeUtf8(value);
  const payload = Buffer.concat([enc, d, nul, v]);
  const size = writeSyncsafe(payload.length);
  const flags = Buffer.alloc(2);
  return Buffer.concat([Buffer.from('TXXX','ascii'), size, flags, payload]);
}

function buildID3Tag(frames){
  const payload = Buffer.concat(frames);
  // ID3v2.3 header: "ID3" + version(2.3) + flags + syncsafe size
  const header = Buffer.concat([
    Buffer.from('ID3'),
    Buffer.from([0x03, 0x00, 0x00]),   // version 2.3, no flags
    writeSyncsafe(payload.length)
  ]);
  return Buffer.concat([header, payload]);
}

/** Find existing ID3v2 tag size in file, return {tagSize, dataOffset} */
function findID3v2(buf){
  if(buf.length < 10) return null;
  if(buf[0]!==0x49||buf[1]!==0x44||buf[2]!==0x33) return null; // "ID3"
  const size = readSyncsafe(buf, 6);
  return { tagSize: size + 10, dataOffset: size + 10 };
}

/** Parse existing ID3v2.3/2.4 frames we want to KEEP (non-text ones except APIC) */
function extractNonTextFrames(buf, tagSize){
  const frames = [];
  let i = 10; // skip header
  while(i + 10 <= tagSize){
    const id = buf.slice(i, i+4).toString('ascii');
    if(id === '\x00\x00\x00\x00') break; // padding
    const size = readSyncsafe(buf, i+4);
    const frameEnd = i + 10 + size;
    // Skip text frames (T***) and APIC — we'll replace those
    if(!id.startsWith('T') && id !== 'APIC' && id !== 'COMM'){
      frames.push(buf.slice(i, frameEnd));
    }
    i = frameEnd;
  }
  return frames;
}

function writeMP3Tags(filePath, changes){
  const buf = fs.readFileSync(filePath);
  const existing = findID3v2(buf);
  const audioData = existing ? buf.slice(existing.dataOffset) : buf;

  // Build frames we want to write
  const frames = [];

  // Standard text frames
  const map = {
    title:  'TIT2', artist: 'TPE1', album: 'TALB',
    year:   'TDRC', genre:  'TCON', albumArtist: 'TPE2',
    track:  'TRCK', disc:   'TPOS',
  };
  for(const [key, id] of Object.entries(map)){
    if(changes[key] !== undefined && changes[key] !== null && changes[key] !== ''){
      frames.push(makeID3TextFrame(id, changes[key]));
    }
  }

  // TXXX for custom fields (rating, mod_duration_data, lib)
  for(const field of ['rating','mod_duration_data','lib']){
    if(changes[field] !== undefined && changes[field] !== null){
      frames.push(makeID3TXXXFrame(field, String(changes[field])));
    }
  }

  // APIC (cover art)
  if(changes.albumArt !== undefined){
    if(changes.albumArt && changes.albumArt.data){
      frames.push(makeID3PictureFrame(changes.albumArt.mimeType, changes.albumArt.data));
    }
    // if null, we simply omit APIC (removes art)
  } else if(existing){
    // preserve existing APIC
    const existingFrames = extractNonTextFrames(buf, existing.tagSize);
    // also grab APIC specifically
    let i = 10;
    while(i + 10 <= existing.tagSize){
      const id = buf.slice(i, i+4).toString('ascii');
      if(id==='\x00\x00\x00\x00') break;
      const size = readSyncsafe(buf, i+4);
      const frameEnd = i + 10 + size;
      if(id === 'APIC') frames.push(buf.slice(i, frameEnd));
      i = frameEnd;
    }
  }

  // Preserve non-text, non-APIC frames from existing tag
  if(existing){
    const kept = extractNonTextFrames(buf, existing.tagSize);
    frames.push(...kept);
  }

  const newTag = buildID3Tag(frames);
  fs.writeFileSync(filePath, Buffer.concat([newTag, audioData]));
}

// ─────────────────────────────────────────────────────────────────────────────
// FLAC — Vorbis Comments + PICTURE metadata block
// ─────────────────────────────────────────────────────────────────────────────
function readFlacBlocks(buf){
  // fLaC marker at 0
  if(buf.slice(0,4).toString('ascii') !== 'fLaC') throw new Error('Not a FLAC file');
  const blocks = [];
  let pos = 4;
  let isLast = false;
  while(!isLast && pos < buf.length){
    const header = buf.readUInt32BE(pos);
    isLast       = !!(header >>> 31);
    const type   = (header >>> 24) & 0x7f;
    const size   = header & 0xFFFFFF;
    blocks.push({ type, size, isLast, dataOffset: pos+4, data: buf.slice(pos+4, pos+4+size) });
    pos += 4 + size;
  }
  return { blocks, audioStart: pos };
}

function buildVorbisComment(fields){
  // fields: [{key,value}, ...]
  const vendor     = encodeUtf8('Aathma');
  const vendorLen  = Buffer.alloc(4); vendorLen.writeUInt32LE(vendor.length, 0);
  const commentCount = Buffer.alloc(4); commentCount.writeUInt32LE(fields.length, 0);
  const commentBufs = fields.map(({key,value})=>{
    const s = encodeUtf8(`${key.toUpperCase()}=${value}`);
    const l = Buffer.alloc(4); l.writeUInt32LE(s.length, 0);
    return Buffer.concat([l, s]);
  });
  return Buffer.concat([vendorLen, vendor, commentCount, ...commentBufs]);
}

function buildFlacPicture(mimeType, imageData){
  // https://www.xiph.org/flac/format.html#metadata_block_picture
  const imgBuf  = Buffer.isBuffer(imageData) ? imageData : Buffer.from(imageData, 'base64');
  const mimeBuf = Buffer.from(mimeType||'image/jpeg','ascii');
  const descBuf = Buffer.alloc(0);
  const b = Buffer.alloc(32 + mimeBuf.length + descBuf.length + imgBuf.length);
  let off = 0;
  b.writeUInt32BE(3, off); off+=4;                    // picture type: front cover
  b.writeUInt32BE(mimeBuf.length, off); off+=4;
  mimeBuf.copy(b, off); off+=mimeBuf.length;
  b.writeUInt32BE(descBuf.length, off); off+=4;
  descBuf.copy(b, off); off+=descBuf.length;
  b.writeUInt32BE(0, off); off+=4;                    // width (unknown)
  b.writeUInt32BE(0, off); off+=4;                    // height
  b.writeUInt32BE(0, off); off+=4;                    // color depth
  b.writeUInt32BE(0, off); off+=4;                    // colors
  b.writeUInt32BE(imgBuf.length, off); off+=4;
  imgBuf.copy(b, off);
  return b;
}

function buildFlacMetaBlock(type, data, isLast){
  const header = Buffer.alloc(4);
  header.writeUInt32BE(((isLast?1:0)<<31) | (type<<24) | data.length, 0);
  return Buffer.concat([header, data]);
}

function writeFLACTags(filePath, changes){
  const buf = fs.readFileSync(filePath);
  const { blocks, audioStart } = readFlacBlocks(buf);
  const audioData = buf.slice(audioStart);

  // Build vorbis comment fields
  const fieldMap = {
    title:'TITLE', artist:'ARTIST', album:'ALBUM',
    year:'DATE', genre:'GENRE', albumArtist:'ALBUMARTIST',
    track:'TRACKNUMBER', disc:'DISCNUMBER',
    rating:'RATING', mod_duration_data:'MOD_DURATION_DATA', lib:'LIB',
  };

  // Start from existing vorbis block if present
  let existingFields = {};
  const vcBlock = blocks.find(b=>b.type===4);
  if(vcBlock){
    // parse existing fields
    let d = vcBlock.data, off = 0;
    const vl = d.readUInt32LE(off); off+=4+vl; // skip vendor
    const cc = d.readUInt32LE(off); off+=4;
    for(let i=0;i<cc;i++){
      const cl = d.readUInt32LE(off); off+=4;
      const s  = d.slice(off, off+cl).toString('utf8'); off+=cl;
      const eq = s.indexOf('=');
      if(eq>0) existingFields[s.slice(0,eq).toUpperCase()] = s.slice(eq+1);
    }
  }

  // Apply changes
  for(const [key,vTag] of Object.entries(fieldMap)){
    if(changes[key]!==undefined && changes[key]!==null && changes[key]!==''){
      existingFields[vTag] = String(changes[key]);
    }
  }

  const fields = Object.entries(existingFields).map(([key,value])=>({key,value}));
  const vcData = buildVorbisComment(fields);

  // Build picture block if needed
  let picData = null;
  if(changes.albumArt !== undefined){
    if(changes.albumArt && changes.albumArt.data){
      picData = buildFlacPicture(changes.albumArt.mimeType, changes.albumArt.data);
    }
  } else {
    // preserve existing PICTURE block
    const pb = blocks.find(b=>b.type===6);
    if(pb) picData = pb.data;
  }

  // Reassemble: STREAMINFO must be first, then VORBIS_COMMENT, then PICTURE, then rest
  const outBlocks = [];
  // STREAMINFO (type 0) — always keep as-is
  const si = blocks.find(b=>b.type===0);
  if(si) outBlocks.push({ type:0, data:si.data });
  // VORBIS_COMMENT (type 4)
  outBlocks.push({ type:4, data:vcData });
  // PICTURE (type 6)
  if(picData) outBlocks.push({ type:6, data:picData });
  // All other blocks except STREAMINFO(0), VORBIS_COMMENT(4), PICTURE(6), PADDING(1)
  for(const b of blocks){
    if(b.type!==0&&b.type!==4&&b.type!==6&&b.type!==1) outBlocks.push({type:b.type,data:b.data});
  }

  const blockBufs = outBlocks.map((b,i)=>buildFlacMetaBlock(b.type, b.data, i===outBlocks.length-1));
  fs.writeFileSync(filePath, Buffer.concat([Buffer.from('fLaC'), ...blockBufs, audioData]));
}

// ─────────────────────────────────────────────────────────────────────────────
// OGG Vorbis — Vorbis Comments in Comment Header packet
// ─────────────────────────────────────────────────────────────────────────────
function writeOGGTags(filePath, changes){
  // OGG is complex to rewrite in-place without a full muxer.
  // Strategy: read all pages, replace the comment header packet, rebuild pages.
  const buf = fs.readFileSync(filePath);

  // Parse OGG pages
  function readPages(b){
    const pages = [];
    let pos = 0;
    while(pos < b.length){
      if(b.slice(pos,pos+4).toString('ascii')!=='OggS') break;
      const headerType = b[pos+5];
      const granule    = b.readBigUInt64LE(pos+6);
      const serial     = b.readUInt32LE(pos+14);
      const seq        = b.readUInt32LE(pos+18);
      const checksum   = b.readUInt32LE(pos+22);
      const numSegs    = b[pos+26];
      const segTable   = b.slice(pos+27, pos+27+numSegs);
      let dataSize = 0;
      for(let i=0;i<numSegs;i++) dataSize+=segTable[i];
      const dataStart = pos+27+numSegs;
      pages.push({ pos, headerType, granule, serial, seq, numSegs, segTable, data:b.slice(dataStart, dataStart+dataSize), totalSize: 27+numSegs+dataSize });
      pos += 27+numSegs+dataSize;
    }
    return pages;
  }

  function buildPage(headerType, granule, serial, seq, data){
    const segments = [];
    let remaining = data.length;
    while(remaining>=255){ segments.push(255); remaining-=255; }
    segments.push(remaining);
    const headerSize = 27+segments.length;
    const page = Buffer.alloc(headerSize+data.length);
    page.write('OggS',0,'ascii');
    page[4]=0; page[5]=headerType;
    page.writeBigUInt64LE(granule,6);
    page.writeUInt32LE(serial,14);
    page.writeUInt32LE(seq,18);
    page.writeUInt32LE(0,22); // checksum placeholder
    page[26]=segments.length;
    for(let i=0;i<segments.length;i++) page[27+i]=segments[i];
    data.copy(page, 27+segments.length);
    // CRC32
    const crc = oggCRC32(page);
    page.writeUInt32LE(crc,22);
    return page;
  }

  function oggCRC32(buf){
    // OGG CRC32 lookup table
    if(!oggCRC32._t){
      oggCRC32._t=new Uint32Array(256);
      for(let i=0;i<256;i++){
        let r=i<<24;
        for(let j=0;j<8;j++) r=(r&0x80000000)?(r<<1)^0x04c11db7:(r<<1);
        oggCRC32._t[i]=r>>>0;
      }
    }
    let crc=0;
    for(let i=0;i<buf.length;i++) crc=((crc<<8)^oggCRC32._t[((crc>>>24)^buf[i])&0xff])>>>0;
    return crc;
  }

  const pages = readPages(buf);

  // The comment header is the 2nd logical bitstream packet (index 1 for vorbis)
  // We find the page whose data starts with \x03vorbis
  let commentPageIdx = -1;
  for(let i=0;i<pages.length;i++){
    if(pages[i].data[0]===0x03 && pages[i].data.slice(1,7).toString('ascii')==='vorbis'){
      commentPageIdx=i; break;
    }
  }
  if(commentPageIdx<0){ throw new Error('OGG comment header not found'); }

  const cp = pages[commentPageIdx];
  const existing = cp.data;

  // Parse existing comment packet
  let off = 7; // skip \x03vorbis
  const vl = existing.readUInt32LE(off); off+=4;
  const vendor = existing.slice(off, off+vl).toString('utf8'); off+=vl;
  const cc = existing.readUInt32LE(off); off+=4;
  let existingFields = {};
  for(let i=0;i<cc;i++){
    const cl=existing.readUInt32LE(off); off+=4;
    const s=existing.slice(off,off+cl).toString('utf8'); off+=cl;
    const eq=s.indexOf('=');
    if(eq>0) existingFields[s.slice(0,eq).toUpperCase()]=s.slice(eq+1);
  }

  // Apply changes
  const fieldMap={title:'TITLE',artist:'ARTIST',album:'ALBUM',year:'DATE',genre:'GENRE',albumArtist:'ALBUMARTIST',rating:'RATING',mod_duration_data:'MOD_DURATION_DATA',lib:'LIB'};
  for(const [key,vTag] of Object.entries(fieldMap)){
    if(changes[key]!==undefined&&changes[key]!==null&&changes[key]!=='') existingFields[vTag]=String(changes[key]);
  }

  // Handle METADATA_BLOCK_PICTURE for cover art in OGG
  if(changes.albumArt!==undefined){
    if(changes.albumArt&&changes.albumArt.data){
      const picBuf=buildFlacPicture(changes.albumArt.mimeType,changes.albumArt.data);
      existingFields['METADATA_BLOCK_PICTURE']=picBuf.toString('base64');
    } else {
      delete existingFields['METADATA_BLOCK_PICTURE'];
    }
  }

  // Rebuild comment packet
  const vendorBuf=encodeUtf8(vendor);
  const entries=Object.entries(existingFields);
  const countBuf=Buffer.alloc(4); countBuf.writeUInt32LE(entries.length,0);
  const vLenBuf=Buffer.alloc(4); vLenBuf.writeUInt32LE(vendorBuf.length,0);
  const commentBufs=entries.map(([k,v])=>{
    const s=encodeUtf8(`${k}=${v}`);
    const l=Buffer.alloc(4); l.writeUInt32LE(s.length,0);
    return Buffer.concat([l,s]);
  });
  const framing=Buffer.from([0x01]); // framing bit
  const newPacket=Buffer.concat([Buffer.from([0x03]),...Buffer.from('vorbis'),vLenBuf,vendorBuf,countBuf,...commentBufs,framing]);

  // Rebuild the comment page
  const newPage=buildPage(cp.headerType,cp.granule,cp.serial,cp.seq,newPacket);

  // Reassemble file
  const parts=[];
  for(let i=0;i<pages.length;i++){
    if(i===commentPageIdx){ parts.push(newPage); }
    else { parts.push(buf.slice(pages[i].pos, pages[i].pos+pages[i].totalSize)); }
  }
  fs.writeFileSync(filePath, Buffer.concat(parts));
}

// ─────────────────────────────────────────────────────────────────────────────
// M4A / AAC — iTunes ilst atoms
// ─────────────────────────────────────────────────────────────────────────────
function writeM4ATags(filePath, changes){
  const buf = fs.readFileSync(filePath);

  function findAtom(b, name, start=0){
    let pos=start;
    while(pos+8<=b.length){
      const size=b.readUInt32BE(pos);
      const n=b.slice(pos+4,pos+8).toString('ascii');
      if(n===name) return {pos,size};
      if(size<8) break;
      pos+=size;
    }
    return null;
  }

  function findAtomInside(b, name, parentStart, parentSize){
    return findAtom(b, name, parentStart+8);
  }

  function buildDataAtom(type, data){
    const header=Buffer.alloc(8);
    header.writeUInt32BE(16+data.length,0);
    header.write('data',4,'ascii');
    const flags=Buffer.alloc(8);
    flags.writeUInt32BE(type,0); // 1=utf8, 13=jpeg, 14=png
    return Buffer.concat([header,flags,data]);
  }

  function buildTextAtom(name, text){
    const data=buildDataAtom(1,encodeUtf8(text));
    const h=Buffer.alloc(8);
    h.writeUInt32BE(8+data.length,0);
    h.write(name,4,'ascii');
    return Buffer.concat([h,data]);
  }

  function buildCoverAtom(mimeType, imgData){
    const imgBuf=Buffer.isBuffer(imgData)?imgData:Buffer.from(imgData,'base64');
    const dataType=mimeType&&mimeType.includes('png')?14:13;
    const data=buildDataAtom(dataType,imgBuf);
    const h=Buffer.alloc(8);
    h.writeUInt32BE(8+data.length,0);
    h.write('covr',4,'ascii');
    return Buffer.concat([h,data]);
  }

  // Find moov > udta > meta > ilst
  const moov=findAtom(buf,'moov');
  if(!moov) throw new Error('No moov atom found');
  const udta=findAtom(buf,'udta',moov.pos+8);
  if(!udta) throw new Error('No udta atom');
  const meta=findAtom(buf,'meta',udta.pos+8);
  if(!meta) throw new Error('No meta atom');
  const metaDataStart=meta.pos+12; // meta has 4-byte version/flags before children
  const ilst=findAtom(buf,'ilst',metaDataStart);

  // Build new ilst content
  const newItems=[];
  const textMap={title:'\xa9nam',artist:'\xa9ART',album:'\xa9alb',year:'\xa9day',genre:'\xa9gen',albumArtist:'aART'};
  
  // Preserve existing ilst items we're not overwriting
  let existingIlst={};
  if(ilst){
    let p=ilst.pos+8;
    while(p+8<=ilst.pos+ilst.size){
      const sz=buf.readUInt32BE(p);
      const nm=buf.slice(p+4,p+8).toString('latin1');
      existingIlst[nm]=buf.slice(p,p+sz);
      if(sz<8) break;
      p+=sz;
    }
  }

  // Apply text changes
  for(const [key,atomName] of Object.entries(textMap)){
    if(changes[key]!==undefined&&changes[key]!==null&&changes[key]!==''){
      existingIlst[atomName]=buildTextAtom(atomName,changes[key]);
    }
  }
  // Cover art
  if(changes.albumArt!==undefined){
    if(changes.albumArt&&changes.albumArt.data){
      existingIlst['covr']=buildCoverAtom(changes.albumArt.mimeType,changes.albumArt.data);
    } else {
      delete existingIlst['covr'];
    }
  }

  // Rebuild ilst
  const ilstContent=Buffer.concat(Object.values(existingIlst));
  const ilstHeader=Buffer.alloc(8);
  ilstHeader.writeUInt32BE(8+ilstContent.length,0);
  ilstHeader.write('ilst',4,'ascii');
  const newIlst=Buffer.concat([ilstHeader,ilstContent]);

  // Patch into file
  if(ilst){
    const before=buf.slice(0,ilst.pos);
    const after=buf.slice(ilst.pos+ilst.size);
    fs.writeFileSync(filePath,Buffer.concat([before,newIlst,after]));
  } else {
    // insert ilst inside meta (after 4-byte meta flags)
    const insertAt=metaDataStart;
    const before=buf.slice(0,insertAt);
    const after=buf.slice(insertAt);
    const newBuf=Buffer.concat([before,newIlst,after]);
    // Update parent atom sizes
    fs.writeFileSync(filePath,newBuf);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WAV — ID3 chunk
// ─────────────────────────────────────────────────────────────────────────────
function writeWAVTags(filePath, changes){
  const buf = fs.readFileSync(filePath);
  // WAV: RIFF....WAVE then chunks
  if(buf.slice(0,4).toString('ascii')!=='RIFF') throw new Error('Not a WAV');
  const chunks=[];
  let pos=12;
  while(pos+8<=buf.length){
    const id=buf.slice(pos,pos+4).toString('ascii');
    const size=buf.readUInt32LE(pos+4);
    chunks.push({id,size,pos,data:buf.slice(pos+8,pos+8+size)});
    pos+=8+size+(size%2); // word-aligned
  }
  // Build new ID3 tag
  const frames=buildID3FramesForChanges(changes, chunks.find(c=>c.id==='id3 '||c.id==='ID3 ')?.data||null);
  const newTag=buildID3Tag(frames);
  // Replace or append id3 chunk
  const id3ChunkIdx=chunks.findIndex(c=>c.id==='id3 '||c.id==='ID3 ');
  const tagChunk=Buffer.alloc(8+newTag.length);
  tagChunk.write('id3 ',0,'ascii');
  tagChunk.writeUInt32LE(newTag.length,4);
  newTag.copy(tagChunk,8);
  const wavChunks=chunks.filter((_,i)=>i!==id3ChunkIdx).map(c=>buf.slice(c.pos,c.pos+8+c.size+(c.size%2)));
  wavChunks.push(tagChunk);
  const wavBody=Buffer.concat(wavChunks);
  const riff=Buffer.alloc(12);
  riff.write('RIFF',0,'ascii');
  riff.writeUInt32LE(4+wavBody.length,4);
  riff.write('WAVE',8,'ascii');
  fs.writeFileSync(filePath,Buffer.concat([riff,wavBody]));
}

function buildID3FramesForChanges(changes, existingTagBuf){
  const frames=[];
  const map={title:'TIT2',artist:'TPE1',album:'TALB',year:'TDRC',genre:'TCON',albumArtist:'TPE2'};
  for(const [key,id] of Object.entries(map)){
    if(changes[key]!==undefined&&changes[key]!==null&&changes[key]!=='') frames.push(makeID3TextFrame(id,changes[key]));
  }
  for(const field of ['rating','mod_duration_data','lib']){
    if(changes[field]!==undefined&&changes[field]!==null) frames.push(makeID3TXXXFrame(field,String(changes[field])));
  }
  if(changes.albumArt!==undefined){
    if(changes.albumArt&&changes.albumArt.data) frames.push(makeID3PictureFrame(changes.albumArt.mimeType,changes.albumArt.data));
  } else if(existingTagBuf){
    const ei=findID3v2(existingTagBuf);
    if(ei){
      let i=10;
      while(i+10<=ei.tagSize){
        const id=existingTagBuf.slice(i,i+4).toString('ascii');
        if(id==='\x00\x00\x00\x00') break;
        const size=readSyncsafe(existingTagBuf,i+4);
        const fe=i+10+size;
        if(id==='APIC') frames.push(existingTagBuf.slice(i,fe));
        i=fe;
      }
    }
  }
  if(existingTagBuf){
    const ei=findID3v2(existingTagBuf);
    if(ei) frames.push(...extractNonTextFrames(existingTagBuf,ei.tagSize));
  }
  return frames;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────
function writeTags(filePath, changes){
  const e = ext(filePath);
  if(e==='mp3')                     writeMP3Tags(filePath, changes);
  else if(e==='flac')               writeFLACTags(filePath, changes);
  else if(e==='ogg'||e==='oga')     writeOGGTags(filePath, changes);
  else if(e==='m4a'||e==='aac'||e==='mp4') writeM4ATags(filePath, changes);
  else if(e==='wav')                writeWAVTags(filePath, changes);
  else throw new Error(`Unsupported format: ${e}`);
}

module.exports = { writeTags };
