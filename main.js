const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs   = require('fs');
const { extractMetadata, scanDirectory, parseLRCOrPlain, parseM3U, estimateBitrate, AUDIO_EXTS } = require('./src/metadata');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200, height: 720,
    minWidth: 900, minHeight: 580,
    frame: false,
    backgroundColor: '#111113',
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  mainWindow.loadFile('src/index.html');
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
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
  if (result.canceled) return { audioFiles:[], playlists:[] };
  const all = { audioFiles:[], playlists:[] };
  for (const dir of result.filePaths) {
    const sub = scanDirectory(dir, true);
    all.audioFiles.push(...sub.audioFiles);
    all.playlists.push(...sub.playlists);
  }
  return all;
});

// ── Scan CWD ─────────────────────────────────────────────────────────────────
ipcMain.handle('scan-cwd', async () => {
  const targetDir = app.isPackaged ? path.dirname(process.execPath) : process.cwd();
  const { audioFiles, playlists } = scanDirectory(targetDir, false); // shallow for cwd
  return { dir: targetDir, audioFiles, playlists };
});

// ── Parse M3U ────────────────────────────────────────────────────────────────
ipcMain.handle('parse-m3u', async (event, filePath) => {
  return parseM3U(filePath);
});

// ── Batch metadata with progress ─────────────────────────────────────────────
ipcMain.handle('get-metadata-batch', async (event, filePaths) => {
  const results = [];
  for (let i = 0; i < filePaths.length; i++) {
    const meta = extractMetadata(filePaths[i]);
    results.push({ path: filePaths[i], ...meta });
    if (i % 5 === 0 || i === filePaths.length - 1)
      mainWindow.webContents.send('scan-progress', { current: i+1, total: filePaths.length });
  }
  return results;
});

// ── Edit metadata (write tags) ─────────────────────────────────────────────
// We use a lightweight approach: for MP3 only, we update the ID3 title/artist
// by re-reading existing tag, modifying text frames, and writing back.
ipcMain.handle('edit-metadata', async (event, filePath, changes) => {
  // For now: return success, actual tag-writing needs node-id3 or similar
  // but we store changes in a JSON sidecar so it persists without needing npm deps
  const sidecar = filePath + '.aathma.json';
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(sidecar,'utf8')); } catch(e) {}
  Object.assign(existing, changes);
  fs.writeFileSync(sidecar, JSON.stringify(existing), 'utf8');
  return { ok: true };
});

// ── Read sidecar overrides ────────────────────────────────────────────────────
ipcMain.handle('read-overrides', async (event, filePath) => {
  const sidecar = filePath + '.aathma.json';
  try { return JSON.parse(fs.readFileSync(sidecar,'utf8')); } catch(e) { return {}; }
});

// ── Load .lrc / .txt sidecar ─────────────────────────────────────────────────
ipcMain.handle('load-sidecar', async (event, filePath) => {
  const base = filePath.replace(/\.[^/.]+$/, '');
  for (const ext of ['.lrc','.txt']) {
    const sidecar = base + ext;
    if (fs.existsSync(sidecar)) return fs.readFileSync(sidecar, 'utf8');
  }
  return null;
});

// ── Estimate bitrate post-duration ─────────────────────────────────────────
ipcMain.handle('estimate-bitrate', async (event, filePath, durationSec) => {
  return estimateBitrate(filePath, durationSec);
});
