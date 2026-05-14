const { app, BrowserWindow, ipcMain, dialog, session } = require('electron');
const path = require('path');
const fs   = require('fs');

// ── STEP 1: userData path — MUST be set before app.ready ─────────────────────
// This is also where localStorage (leveldb) lives in Electron.
// We keep it inside project so permissions are always available on Windows.
const userDataPath = path.join(
  app.isPackaged ? path.dirname(process.execPath) : __dirname,
  '.aathma-cache'
);
fs.mkdirSync(userDataPath, { recursive: true });   // create before setPath
app.setPath('userData', userDataPath);

// ── STEP 2: GPU / disk-cache flags — also before ready ───────────────────────
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('disk-cache-dir', path.join(userDataPath, 'http-cache'));
app.commandLine.appendSwitch('disk-cache-size', '1048576'); // 1 MB max

// ── STEP 3: Load app modules (after path is set) ──────────────────────────────
const { extractMetadata, scanDirectory, parseLRCOrPlain, parseM3U, estimateBitrate, AUDIO_EXTS } = require('./src/metadata');
const { writeTags }    = require('./src/tagwriter');
const { initCache, getCached, putCached, updateCachedMeta, pruneDeleted, cacheStats, closeCache } = require('./src/cache');

// Init SQLite cache (gracefully degrades if better-sqlite3 missing)
initCache(userDataPath);

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200, height: 720,
    minWidth: 800, minHeight: 600,
    frame: false,
    backgroundColor: '#111113',
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  mainWindow.loadFile('src/index.html');
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  closeCache();
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ── Window controls ──────────────────────────────────────────────────────────
ipcMain.on('window-minimize', () => mainWindow.minimize());
ipcMain.on('window-maximize', () => mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize());
ipcMain.on('window-close',    () => mainWindow.close());

// ── File picker ──────────────────────────────────────────────────────────────
ipcMain.handle('open-files', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Audio', extensions: ['mp3','wav','ogg','flac','m4a','aac'] },
      { name: 'Playlist', extensions: ['m3u','m3u8'] },
    ],
  });
  return result.canceled ? [] : result.filePaths;
});

// ── Folder picker + deep scan ─────────────────────────────────────────────────
ipcMain.handle('open-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'multiSelections'],
  });
  if (result.canceled) return { audioFiles:[], playlists:[], folderPaths:[] };
  const all = { audioFiles:[], playlists:[], folderPaths: result.filePaths };
  for (const dir of result.filePaths) {
    const sub = scanDirectory(dir, true);
    all.audioFiles.push(...sub.audioFiles);
    all.playlists.push(...sub.playlists);
  }
  return all;
});

// ── Scan a known folder path (startup restore) ────────────────────────────────
ipcMain.handle('scan-folder', async (event, dirPath) => {
  if (!dirPath || !fs.existsSync(dirPath)) return [];
  const { audioFiles } = scanDirectory(dirPath, true);
  return audioFiles;
});

// ── Scan CWD ─────────────────────────────────────────────────────────────────
ipcMain.handle('scan-cwd', async () => {
  const targetDir = app.isPackaged ? path.dirname(process.execPath) : process.cwd();
  const { audioFiles, playlists } = scanDirectory(targetDir, false);
  return { dir: targetDir, audioFiles, playlists };
});

// ── Parse M3U ────────────────────────────────────────────────────────────────
ipcMain.handle('parse-m3u', async (event, filePath) => {
  return parseM3U(filePath);
});

// ── Remembered dirs: main-process backed store ────────────────────────────────
// localStorage lives in userData which we moved — so we persist remembered
// dirs in a plain JSON file in userDataPath for guaranteed reliability.
const DIRS_FILE = path.join(userDataPath, 'remembered-dirs.json');

function readDirs() {
  try { return JSON.parse(fs.readFileSync(DIRS_FILE, 'utf8')); }
  catch(e) { return []; }
}
function writeDirs(dirs) {
  try { fs.writeFileSync(DIRS_FILE, JSON.stringify(dirs), 'utf8'); }
  catch(e) { console.error('[dirs]', e.message); }
}

ipcMain.handle('dirs-get',    async ()          => readDirs());
ipcMain.handle('dirs-add',    async (e, dir)    => { const d=readDirs(); if(!d.includes(dir)) d.push(dir); writeDirs(d); return d; });
ipcMain.handle('dirs-remove', async (e, dir)    => { const d=readDirs().filter(x=>x!==dir); writeDirs(d); return d; });
ipcMain.handle('dirs-set',    async (e, dirs)   => { writeDirs(dirs); return dirs; });

// ── Last played track (also main-process backed) ──────────────────────────────
const LAST_TRACK_FILE = path.join(userDataPath, 'last-track.json');
ipcMain.handle('last-track-get', async () => {
  try { return JSON.parse(fs.readFileSync(LAST_TRACK_FILE, 'utf8')); } catch(e) { return null; }
});
ipcMain.handle('last-track-set', async (e, data) => {
  try { fs.writeFileSync(LAST_TRACK_FILE, JSON.stringify(data), 'utf8'); } catch(e) {}
});

// ── Batch metadata with SQLite cache-first ────────────────────────────────────
ipcMain.handle('get-metadata-batch', async (event, filePaths) => {
  const results = [];
  let hits = 0, misses = 0;

  for (let i = 0; i < filePaths.length; i++) {
    const fp = filePaths[i];
    let meta = getCached(fp);
    if (meta) {
      hits++;
    } else {
      meta = extractMetadata(fp);
      putCached(fp, meta);
      misses++;
    }
    results.push({ path: fp, ...meta });
    if (i % 10 === 0 || i === filePaths.length - 1) {
      mainWindow.webContents.send('scan-progress', { current: i+1, total: filePaths.length, hits, misses });
    }
  }

  setImmediate(() => pruneDeleted(filePaths));
  console.log(`[cache] ${hits} hits / ${misses} misses / ${filePaths.length} total`);
  return results;
});

// ── Edit / Embed metadata ─────────────────────────────────────────────────────
ipcMain.handle('edit-metadata', async (event, filePath, changes) => {
  try { writeTags(filePath, changes); updateCachedMeta(filePath, changes); return { ok: true }; }
  catch(e) { console.error('[edit-metadata]', e.message); return { ok: false, error: e.message }; }
});
ipcMain.handle('embed-metadata', async (event, filePath, changes) => {
  try { writeTags(filePath, changes); updateCachedMeta(filePath, changes); return { ok: true }; }
  catch(e) { console.error('[embed-metadata]', e.message); return { ok: false, error: e.message }; }
});

// ── Sidecar / overrides ───────────────────────────────────────────────────────
ipcMain.handle('read-overrides', async (event, filePath) => {
  const sidecar = filePath + '.aathma.json';
  try { return JSON.parse(fs.readFileSync(sidecar,'utf8')); } catch(e) { return {}; }
});
ipcMain.handle('load-sidecar', async (event, filePath) => {
  const base = filePath.replace(/\.[^/.]+$/, '');
  for (const ext of ['.lrc','.txt']) {
    const sidecar = base + ext;
    if (fs.existsSync(sidecar)) return fs.readFileSync(sidecar, 'utf8');
  }
  return null;
});

// ── Estimate bitrate ──────────────────────────────────────────────────────────
ipcMain.handle('estimate-bitrate', async (event, filePath, durationSec) => {
  return estimateBitrate(filePath, durationSec);
});

// ── Cache management ──────────────────────────────────────────────────────────
ipcMain.handle('cache-stats', async () => cacheStats());
ipcMain.handle('cache-clear', async () => {
  try {
    closeCache();
    const dbPath = path.join(userDataPath, 'aathma-meta.db');
    for (const p of [dbPath, dbPath+'-wal', dbPath+'-shm']) {
      try { fs.unlinkSync(p); } catch(e) {}
    }
    initCache(userDataPath);
    return { ok: true };
  } catch(e) { return { ok: false, error: e.message }; }
});
