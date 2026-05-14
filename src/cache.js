/**
 * Aathma Player — SQLite Metadata Cache
 *
 * Strategy:
 *   - Cache key  = absolute file path
 *   - Freshness  = file mtime (modified time) + file size
 *     → agar dono match karein, file nahi padhi jaati — cache se return
 *     → agar kuch bhi badla, file dobara parse hoti hai aur cache update hota hai
 *   - Artwork    = BLOB column (binary, base64 encoded string as TEXT)
 *   - Lyrics     = JSON TEXT column
 *   - mod_duration_data = TEXT column (ST:/ET: tag)
 *
 * Requires: better-sqlite3  (npm install better-sqlite3)
 */

'use strict';

const path    = require('path');
const fs      = require('fs');
let Database;
try { Database = require('better-sqlite3'); }
catch(e) {
  console.warn('[cache] better-sqlite3 not found — caching disabled. Run: npm install better-sqlite3');
  Database = null;
}

const SCHEMA_VERSION = 2; // bump this to force full cache rebuild on schema changes

let db = null;

// ─── Init ─────────────────────────────────────────────────────────────────────
function initCache(userDataPath) {
  if (!Database) return false;
  try {
    const dbPath = path.join(userDataPath, 'aathma-meta.db');
    db = new Database(dbPath);

    // WAL mode: much faster concurrent reads/writes
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('cache_size = -8000');   // 8 MB page cache
    db.pragma('temp_store = MEMORY');

    // Version table — schema migration guard
    db.exec(`CREATE TABLE IF NOT EXISTS meta_version (version INTEGER PRIMARY KEY)`);
    const row = db.prepare('SELECT version FROM meta_version LIMIT 1').get();
    if (!row) {
      db.prepare('INSERT INTO meta_version VALUES (?)').run(SCHEMA_VERSION);
    } else if (row.version < SCHEMA_VERSION) {
      // Schema changed — wipe and rebuild
      console.log(`[cache] Schema v${row.version} → v${SCHEMA_VERSION}: rebuilding cache.`);
      db.exec('DROP TABLE IF EXISTS tracks');
      db.prepare('UPDATE meta_version SET version = ?').run(SCHEMA_VERSION);
    }

    // Main tracks table
    db.exec(`
      CREATE TABLE IF NOT EXISTS tracks (
        path              TEXT PRIMARY KEY,
        mtime             INTEGER NOT NULL,
        fsize             INTEGER NOT NULL,
        title             TEXT,
        artist            TEXT,
        album             TEXT,
        year              TEXT,
        genre             TEXT,
        rating            INTEGER DEFAULT 0,
        bitrate           INTEGER DEFAULT 0,
        mod_duration_data TEXT,
        lyrics_json       TEXT,
        artwork_mime      TEXT,
        artwork_data      TEXT,
        cached_at         INTEGER
      )
    `);

    // Indexes for fast lookups
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_tracks_mtime ON tracks(mtime);
      CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist);
      CREATE INDEX IF NOT EXISTS idx_tracks_album  ON tracks(album);
    `);

    // Prepared statements (reused for speed)
    db._stmtGet    = db.prepare(`SELECT * FROM tracks WHERE path = ?`);
    db._stmtUpsert = db.prepare(`
      INSERT INTO tracks
        (path, mtime, fsize, title, artist, album, year, genre, rating, bitrate,
         mod_duration_data, lyrics_json, artwork_mime, artwork_data, cached_at)
      VALUES
        (@path, @mtime, @fsize, @title, @artist, @album, @year, @genre, @rating, @bitrate,
         @mod_duration_data, @lyrics_json, @artwork_mime, @artwork_data, @cached_at)
      ON CONFLICT(path) DO UPDATE SET
        mtime = excluded.mtime, fsize = excluded.fsize,
        title = excluded.title, artist = excluded.artist,
        album = excluded.album, year = excluded.year,
        genre = excluded.genre, rating = excluded.rating,
        bitrate = excluded.bitrate,
        mod_duration_data = excluded.mod_duration_data,
        lyrics_json  = excluded.lyrics_json,
        artwork_mime = excluded.artwork_mime,
        artwork_data = excluded.artwork_data,
        cached_at    = excluded.cached_at
    `);
    db._stmtDelete = db.prepare(`DELETE FROM tracks WHERE path = ?`);
    db._stmtPrune  = db.prepare(`DELETE FROM tracks WHERE path NOT IN (SELECT value FROM json_each(?))`);
    db._stmtCount  = db.prepare(`SELECT COUNT(*) AS n FROM tracks`);

    console.log(`[cache] SQLite ready → ${dbPath}`);
    return true;
  } catch(e) {
    console.error('[cache] init failed:', e.message);
    db = null;
    return false;
  }
}

// ─── File freshness check ─────────────────────────────────────────────────────
function fileStamp(filePath) {
  try {
    const s = fs.statSync(filePath);
    return { mtime: Math.floor(s.mtimeMs), fsize: s.size };
  } catch(e) { return null; }
}

// ─── Get from cache (returns null if stale/missing) ──────────────────────────
function getCached(filePath) {
  if (!db) return null;
  try {
    const stamp = fileStamp(filePath);
    if (!stamp) return null;
    const row = db._stmtGet.get(filePath);
    if (!row) return null;
    // Stale check: mtime ya size badla to re-parse
    if (row.mtime !== stamp.mtime || row.fsize !== stamp.fsize) return null;

    // Deserialise back into the shape extractMetadata returns
    return {
      title:             row.title   || '',
      artist:            row.artist  || '',
      album:             row.album   || '',
      year:              row.year    || '',
      genre:             row.genre   || '',
      rating:            row.rating  || 0,
      bitrate:           row.bitrate || 0,
      mod_duration_data: row.mod_duration_data || '',
      lyrics:            row.lyrics_json ? JSON.parse(row.lyrics_json) : null,
      albumArt:          row.artwork_data
                           ? { mimeType: row.artwork_mime, data: row.artwork_data }
                           : null,
    };
  } catch(e) {
    console.warn('[cache] getCached error:', e.message);
    return null;
  }
}

// ─── Write to cache ───────────────────────────────────────────────────────────
function putCached(filePath, meta) {
  if (!db) return;
  try {
    const stamp = fileStamp(filePath);
    if (!stamp) return;
    db._stmtUpsert.run({
      path:              filePath,
      mtime:             stamp.mtime,
      fsize:             stamp.fsize,
      title:             meta.title   || '',
      artist:            meta.artist  || '',
      album:             meta.album   || '',
      year:              meta.year    || '',
      genre:             meta.genre   || '',
      rating:            meta.rating  || 0,
      bitrate:           meta.bitrate || 0,
      mod_duration_data: meta.mod_duration_data || '',
      lyrics_json:       meta.lyrics  ? JSON.stringify(meta.lyrics) : null,
      artwork_mime:      meta.albumArt ? meta.albumArt.mimeType : null,
      artwork_data:      meta.albumArt ? meta.albumArt.data     : null,
      cached_at:         Date.now(),
    });
  } catch(e) {
    console.warn('[cache] putCached error:', e.message);
  }
}

// ─── Update only the metadata fields that saveEdit changes (no re-scan) ───────
function updateCachedMeta(filePath, changes) {
  if (!db) return;
  try {
    const row = db._stmtGet.get(filePath);
    if (!row) return; // not in cache yet, nothing to patch
    const merged = {
      path:              filePath,
      mtime:             row.mtime,
      fsize:             row.fsize,
      title:             changes.title             ?? row.title,
      artist:            changes.artist            ?? row.artist,
      album:             changes.album             ?? row.album,
      year:              changes.year              ?? row.year,
      genre:             changes.genre             ?? row.genre,
      rating:            changes.rating            ?? row.rating,
      bitrate:           row.bitrate,
      mod_duration_data: changes.mod_duration_data ?? row.mod_duration_data,
      lyrics_json:       row.lyrics_json,
      artwork_mime:      changes.albumArt !== undefined
                           ? (changes.albumArt ? changes.albumArt.mimeType : null)
                           : row.artwork_mime,
      artwork_data:      changes.albumArt !== undefined
                           ? (changes.albumArt ? changes.albumArt.data     : null)
                           : row.artwork_data,
      cached_at:         Date.now(),
    };
    db._stmtUpsert.run(merged);
  } catch(e) {
    console.warn('[cache] updateCachedMeta error:', e.message);
  }
}

// ─── Prune stale rows (files that no longer exist on disk) ───────────────────
// Call after a full scan to keep DB lean.
function pruneDeleted(livePaths) {
  if (!db || !livePaths.length) return 0;
  try {
    const info = db._stmtPrune.run(JSON.stringify(livePaths));
    if (info.changes > 0)
      console.log(`[cache] Pruned ${info.changes} deleted file(s) from cache.`);
    return info.changes;
  } catch(e) {
    console.warn('[cache] pruneDeleted error:', e.message);
    return 0;
  }
}

// ─── Stats (for debug / settings panel) ──────────────────────────────────────
function cacheStats() {
  if (!db) return { enabled: false };
  try {
    const { n } = db._stmtCount.get();
    return { enabled: true, rows: n };
  } catch(e) { return { enabled: false }; }
}

function closeCache() {
  if (db) { try { db.close(); } catch(e) {} db = null; }
}

module.exports = { initCache, getCached, putCached, updateCachedMeta, pruneDeleted, cacheStats, closeCache };
