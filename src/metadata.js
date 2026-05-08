/**
 * Aathma Player - Enhanced Metadata Extractor
 * Supports: MP3 (ID3v2/v1), OGG/FLAC (Vorbis), MP4/M4A, M3U/M3U8 playlists
 * Extracts: title, artist, album, year, rating, bitrate, album art, lyrics
 */

const fs = require('fs');
const path = require('path');

// ─── ID3v2 (MP3) ──────────────────────────────────────────────────────────────

function parseID3v2(buf) {
  if (buf.length < 10) return null;
  if (buf.slice(0, 3).toString('ascii') !== 'ID3') return null;
  const version = buf[3];
  const flags = buf[5];
  const tagSize =
    ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) |
    ((buf[8] & 0x7f) << 7)  |  (buf[9] & 0x7f);
  const frames = {};
  let offset = 10;
  if (version >= 3 && (flags & 0x40)) {
    const extSize = buf.readUInt32BE(offset);
    offset += 4 + extSize;
  }
  const end = Math.min(10 + tagSize, buf.length);
  while (offset < end - 10) {
    const frameId = buf.slice(offset, offset + (version >= 3 ? 4 : 3)).toString('ascii');
    if (!frameId || frameId[0] === '\x00') break;
    let frameSize, frameHeaderLen;
    if (version >= 3) {
      frameSize = version >= 4
        ? ((buf[offset+4]&0x7f)<<21)|((buf[offset+5]&0x7f)<<14)|((buf[offset+6]&0x7f)<<7)|(buf[offset+7]&0x7f)
        : buf.readUInt32BE(offset + 4);
      frameHeaderLen = 10;
    } else {
      frameSize = (buf[offset+3]<<16)|(buf[offset+4]<<8)|buf[offset+5];
      frameHeaderLen = 6;
    }
    if (frameSize <= 0 || offset + frameHeaderLen + frameSize > end) break;
    frames[frameId] = buf.slice(offset + frameHeaderLen, offset + frameHeaderLen + frameSize);
    offset += frameHeaderLen + frameSize;
  }
  return frames;
}

function decodeTextFrame(data) {
  if (!data || data.length === 0) return '';
  const enc = data[0];
  const content = data.slice(1);
  try {
    if (enc === 0) return content.toString('latin1').replace(/\x00.*$/, '').trim();
    if (enc === 1 || enc === 2) return content.toString('utf16le').replace(/\x00$/, '').trim();
    if (enc === 3) return content.toString('utf8').replace(/\x00.*$/, '').trim();
  } catch(e) {}
  return content.toString('utf8').replace(/\x00.*$/, '').trim();
}

function parseUSLT(data) {
  if (!data || data.length < 5) return null;
  const enc = data[0];
  let offset = 4;
  while (offset < data.length) {
    if (enc === 1 || enc === 2) {
      if (data[offset] === 0 && data[offset+1] === 0) { offset += 2; break; }
      offset += 2;
    } else {
      if (data[offset] === 0) { offset += 1; break; }
      offset += 1;
    }
  }
  const lyricsData = data.slice(offset);
  try {
    if (enc === 0) return lyricsData.toString('latin1').trim();
    if (enc === 1 || enc === 2) return lyricsData.toString('utf16le').trim();
    if (enc === 3) return lyricsData.toString('utf8').trim();
  } catch(e) {}
  return lyricsData.toString('utf8').trim();
}

function parseSYLT(data) {
  if (!data || data.length < 6) return null;
  const enc = data[0];
  let offset = 6;
  while (offset < data.length) {
    if (enc === 1 || enc === 2) {
      if (data[offset] === 0 && data[offset+1] === 0) { offset += 2; break; }
      offset += 2;
    } else {
      if (data[offset] === 0) { offset += 1; break; }
      offset += 1;
    }
  }
  const results = [];
  while (offset < data.length - 5) {
    let text = '', textEnd = offset;
    if (enc === 1 || enc === 2) {
      while (textEnd < data.length - 1 && !(data[textEnd] === 0 && data[textEnd+1] === 0)) textEnd += 2;
      text = data.slice(offset, textEnd).toString('utf16le').trim();
      offset = textEnd + 2;
    } else {
      while (textEnd < data.length && data[textEnd] !== 0) textEnd++;
      text = data.slice(offset, textEnd).toString(enc === 3 ? 'utf8' : 'latin1').trim();
      offset = textEnd + 1;
    }
    if (offset + 4 > data.length) break;
    const timestamp = data.readUInt32BE(offset); offset += 4;
    if (text) results.push({ time: timestamp / 1000, text });
  }
  return results.length > 0 ? results : null;
}

function extractAPIC(data) {
  if (!data || data.length < 4) return null;
  try {
    const enc = data[0];
    let offset = 1;
    let mimeEnd = offset;
    while (mimeEnd < data.length && data[mimeEnd] !== 0) mimeEnd++;
    const mimeType = data.slice(offset, mimeEnd).toString('ascii');
    offset = mimeEnd + 1;
    offset += 1; // picture type
    while (offset < data.length) {
      if (enc === 1 || enc === 2) {
        if (data[offset] === 0 && data[offset+1] === 0) { offset += 2; break; }
        offset += 2;
      } else {
        if (data[offset] === 0) { offset += 1; break; }
        offset += 1;
      }
    }
    const imageData = data.slice(offset);
    return { mimeType: mimeType || 'image/jpeg', imageData };
  } catch(e) { return null; }
}

function extractMP3Meta(filePath) {
  const result = { title:'', artist:'', album:'', year:'', rating:0, bitrate:0, lyrics:null, albumArt:null };
  try {
    const stat = fs.statSync(filePath);
    const readSize = Math.min(stat.size, 1024*1024);
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, 0);
    fs.closeSync(fd);

    const frames = parseID3v2(buf);
    if (frames) {
      result.title  = decodeTextFrame(frames['TIT2'] || frames['TT2']) || '';
      result.artist = decodeTextFrame(frames['TPE1'] || frames['TP1']) || '';
      result.album  = decodeTextFrame(frames['TALB'] || frames['TAL']) || '';
      result.year   = (decodeTextFrame(frames['TDRC'] || frames['TYER'] || frames['TYE']) || '').slice(0,4);

      if (frames['POPM']) {
        const popm = frames['POPM'];
        let i = 0;
        while (i < popm.length && popm[i] !== 0) i++;
        i++;
        if (i < popm.length) result.rating = Math.round(popm[i] / 51);
      }

      if (frames['APIC']) {
        const art = extractAPIC(frames['APIC']);
        if (art && art.imageData.length > 0) {
          result.albumArt = { mimeType: art.mimeType, data: art.imageData.toString('base64') };
        }
      }

      if (frames['SYLT']) {
        const synced = parseSYLT(frames['SYLT']);
        if (synced && synced.length > 0) result.lyrics = synced;
      }
      if (!result.lyrics && frames['USLT']) {
        const raw = parseUSLT(frames['USLT']);
        if (raw && raw.trim()) result.lyrics = parseLRCOrPlain(raw);
      }
      if (!result.lyrics) {
        for (const key of Object.keys(frames)) {
          if (key.startsWith('USLT') && key !== 'USLT') {
            const raw = parseUSLT(frames[key]);
            if (raw && raw.trim()) { result.lyrics = parseLRCOrPlain(raw); break; }
          }
        }
      }

      if (frames['TLEN']) {
        const durationMs = parseInt(decodeTextFrame(frames['TLEN']));
        if (durationMs > 0) result.bitrate = Math.round((stat.size * 8) / durationMs);
      }
    }

    if (stat.size > 128) {
      const fd2 = fs.openSync(filePath, 'r');
      const tail = Buffer.alloc(128);
      fs.readSync(fd2, tail, 0, 128, stat.size - 128);
      fs.closeSync(fd2);
      if (tail.slice(0,3).toString('ascii') === 'TAG') {
        if (!result.title)  result.title  = tail.slice(3,33).toString('latin1').replace(/\x00.*$/,'').trim();
        if (!result.artist) result.artist = tail.slice(33,63).toString('latin1').replace(/\x00.*$/,'').trim();
        if (!result.album)  result.album  = tail.slice(63,93).toString('latin1').replace(/\x00.*$/,'').trim();
        if (!result.year)   result.year   = tail.slice(93,97).toString('latin1').replace(/\x00.*$/,'').trim();
      }
    }
  } catch(e) {}
  return result;
}

function parseFLACPicture(buf) {
  try {
    let offset = 4;
    const mimeLen = buf.readUInt32BE(offset); offset += 4;
    const mimeType = buf.slice(offset, offset+mimeLen).toString('ascii'); offset += mimeLen;
    const descLen = buf.readUInt32BE(offset); offset += 4 + descLen;
    offset += 16;
    const dataLen = buf.readUInt32BE(offset); offset += 4;
    const imageData = buf.slice(offset, offset+dataLen);
    if (imageData.length > 0) return { mimeType: mimeType||'image/jpeg', data: imageData.toString('base64') };
  } catch(e) {}
  return null;
}

function extractVorbisMeta(filePath) {
  const result = { title:'', artist:'', album:'', year:'', rating:0, bitrate:0, lyrics:null, albumArt:null };
  try {
    const stat = fs.statSync(filePath);
    const readSize = Math.min(stat.size, 2*1024*1024);
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, 0);
    fs.closeSync(fd);

    let commentData = null, pictureData = null;
    const isFLAC = buf.slice(0,4).toString('ascii') === 'fLaC';
    const isOGG  = buf.slice(0,4).toString('ascii') === 'OggS';

    if (isFLAC) {
      let offset = 4;
      while (offset < buf.length - 4) {
        const blockType = buf[offset] & 0x7f;
        const isLast = (buf[offset] & 0x80) !== 0;
        const blockSize = (buf[offset+1]<<16)|(buf[offset+2]<<8)|buf[offset+3];
        offset += 4;
        if (blockType === 4) commentData = buf.slice(offset, offset+blockSize);
        if (blockType === 6) pictureData = buf.slice(offset, offset+blockSize);
        if (isLast) break;
        offset += blockSize;
      }
    } else if (isOGG) {
      const marker = Buffer.from([0x03,0x76,0x6f,0x72,0x62,0x69,0x73]);
      const idx = buf.indexOf(marker);
      if (idx !== -1) commentData = buf.slice(idx + 7);
    }

    if (commentData) {
      let offset = 0;
      const vendorLen = commentData.readUInt32LE(offset); offset += 4 + vendorLen;
      const commentCount = commentData.readUInt32LE(offset); offset += 4;
      for (let i = 0; i < commentCount && offset < commentData.length; i++) {
        const len = commentData.readUInt32LE(offset); offset += 4;
        if (offset + len > commentData.length) break;
        const comment = commentData.slice(offset, offset+len).toString('utf8');
        offset += len;
        const eqIdx = comment.indexOf('=');
        if (eqIdx === -1) continue;
        const key = comment.slice(0, eqIdx).toUpperCase();
        const val = comment.slice(eqIdx + 1);
        if (key === 'TITLE') result.title = val;
        else if (key === 'ARTIST') result.artist = val;
        else if (key === 'ALBUM') result.album = val;
        else if (key === 'DATE' || key === 'YEAR') result.year = val.slice(0,4);
        else if (key === 'RATING') result.rating = Math.min(5, Math.max(0, parseInt(val)||0));
        else if (key === 'LYRICS' || key === 'UNSYNCEDLYRICS' || key === 'SYNCEDLYRICS') result.lyrics = parseLRCOrPlain(val);
        else if (key === 'METADATA_BLOCK_PICTURE') {
          try { const pic = parseFLACPicture(Buffer.from(val,'base64')); if (pic) result.albumArt = pic; } catch(e) {}
        }
      }
    }
    if (pictureData && !result.albumArt) {
      const pic = parseFLACPicture(pictureData);
      if (pic) result.albumArt = pic;
    }
  } catch(e) {}
  return result;
}

function extractMP4Meta(filePath) {
  const result = { title:'', artist:'', album:'', year:'', rating:0, bitrate:0, lyrics:null, albumArt:null };
  try {
    const stat = fs.statSync(filePath);
    const readSize = Math.min(stat.size, 4*1024*1024);
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, 0);
    fs.closeSync(fd);

    function findAtom(data, name, offset=0) {
      while (offset < data.length - 8) {
        const size = data.readUInt32BE(offset);
        if (size < 8 || offset + size > data.length) break;
        if (data.slice(offset+4, offset+8).toString('ascii') === name) return { offset, size };
        offset += size;
      }
      return null;
    }

    const moovAtom = findAtom(buf, 'moov');
    if (!moovAtom) return result;
    const moovData = buf.slice(moovAtom.offset+8, moovAtom.offset+moovAtom.size);
    const udtaAtom = findAtom(moovData, 'udta');
    if (!udtaAtom) return result;
    const udtaData = moovData.slice(udtaAtom.offset+8, udtaAtom.offset+udtaAtom.size);
    const metaAtom = findAtom(udtaData, 'meta');
    if (!metaAtom) return result;
    const metaData = udtaData.slice(metaAtom.offset+12, udtaAtom.offset+metaAtom.size);
    const ilstAtom = findAtom(metaData, 'ilst');
    if (!ilstAtom) return result;
    const ilstData = metaData.slice(ilstAtom.offset+8, ilstAtom.offset+ilstAtom.size);

    function readIlstItem(data, atomName) {
      const atom = findAtom(data, atomName);
      if (!atom) return null;
      const inner = data.slice(atom.offset+8, atom.offset+atom.size);
      const dataAtom = findAtom(inner, 'data');
      if (!dataAtom) return null;
      return inner.slice(dataAtom.offset+16, dataAtom.offset+dataAtom.size);
    }

    const titleBuf  = readIlstItem(ilstData, '\xa9nam');
    const artistBuf = readIlstItem(ilstData, '\xa9ART');
    const albumBuf  = readIlstItem(ilstData, '\xa9alb');
    const yearBuf   = readIlstItem(ilstData, '\xa9day');
    const lyricsBuf = readIlstItem(ilstData, '\xa9lyr');
    const coverBuf  = readIlstItem(ilstData, 'covr');

    if (titleBuf)  result.title  = titleBuf.toString('utf8').trim();
    if (artistBuf) result.artist = artistBuf.toString('utf8').trim();
    if (albumBuf)  result.album  = albumBuf.toString('utf8').trim();
    if (yearBuf)   result.year   = yearBuf.toString('utf8').trim().slice(0,4);
    if (lyricsBuf) result.lyrics = parseLRCOrPlain(lyricsBuf.toString('utf8').trim());
    if (coverBuf && coverBuf.length > 0) {
      result.albumArt = { mimeType: 'image/jpeg', data: coverBuf.toString('base64') };
    }
  } catch(e) {}
  return result;
}

function parseLRCOrPlain(text) {
  if (!text || !text.trim()) return null;
  const lines = text.split(/\r?\n/);
  const timeRe = /\[(\d+):(\d+)[.:](\d+)\](.*)/;
  const timed = [], plain = [];
  for (const line of lines) {
    const m = line.match(timeRe);
    if (m) {
      const time = parseInt(m[1])*60 + parseInt(m[2]) + parseInt(m[3])/100;
      const txt = m[4].trim();
      if (txt) timed.push({ time, text: txt });
    } else if (line.trim() && !line.startsWith('[')) {
      plain.push({ text: line.trim() });
    }
  }
  if (timed.length > 0) return timed.sort((a,b) => a.time - b.time);
  if (plain.length > 0) return plain;
  return null;
}

function parseM3U(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split(/\r?\n/);
    const dir = path.dirname(filePath);
    const tracks = [];
    let pending = { title:'', artist:'' };
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === '#EXTM3U') continue;
      if (trimmed.startsWith('#EXTINF:')) {
        const info = trimmed.slice(8);
        const commaIdx = info.indexOf(',');
        if (commaIdx !== -1) {
          const meta = info.slice(commaIdx+1).trim();
          const dashIdx = meta.indexOf(' - ');
          if (dashIdx !== -1) { pending.artist = meta.slice(0,dashIdx).trim(); pending.title = meta.slice(dashIdx+3).trim(); }
          else pending.title = meta;
        }
        continue;
      }
      if (trimmed.startsWith('#')) continue;
      if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) { pending = {title:'',artist:''}; continue; }
      const resolved = path.isAbsolute(trimmed) ? trimmed : path.join(dir, trimmed);
      if (fs.existsSync(resolved)) tracks.push({ path: resolved, m3uTitle: pending.title, m3uArtist: pending.artist });
      pending = { title:'', artist:'' };
    }
    return tracks;
  } catch(e) { return []; }
}

const AUDIO_EXTS = /\.(mp3|wav|ogg|flac|m4a|aac|mp4)$/i;
const PLAYLIST_EXTS = /\.(m3u|m3u8)$/i;

function scanDirectory(dirPath, recursive=true) {
  const audioFiles = [], playlists = [];
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory() && recursive) {
        const sub = scanDirectory(fullPath, true);
        audioFiles.push(...sub.audioFiles);
        playlists.push(...sub.playlists);
      } else if (entry.isFile()) {
        if (AUDIO_EXTS.test(entry.name)) audioFiles.push(fullPath);
        else if (PLAYLIST_EXTS.test(entry.name)) playlists.push(fullPath);
      }
    }
  } catch(e) {}
  return { audioFiles, playlists };
}

function estimateBitrate(filePath, durationSec) {
  if (!durationSec || durationSec <= 0) return 0;
  try {
    const stat = fs.statSync(filePath);
    return Math.round((stat.size * 8) / (durationSec * 1000));
  } catch(e) { return 0; }
}

function extractMetadata(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  try {
    if (ext === 'mp3') return extractMP3Meta(filePath);
    if (ext === 'ogg' || ext === 'flac') return extractVorbisMeta(filePath);
    if (ext === 'm4a' || ext === 'mp4' || ext === 'aac') return extractMP4Meta(filePath);
  } catch(e) {}
  return { title:'', artist:'', album:'', year:'', rating:0, bitrate:0, lyrics:null, albumArt:null };
}

module.exports = { extractMetadata, scanDirectory, parseLRCOrPlain, parseM3U, estimateBitrate, AUDIO_EXTS };
