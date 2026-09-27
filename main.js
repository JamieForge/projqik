const { app, BrowserWindow, ipcMain, dialog, shell, protocol } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const { spawn } = require('child_process');
const crypto = require('crypto');
const AdmZip = require('adm-zip');

// IMPORTANT: this app has been renamed twice (Launchpad -> ThrusterPad -> ProjQik). Each rename
// would otherwise make Electron start using a brand-new, empty storage folder (its default
// userData path is derived from the app name), which would make every existing user's saved
// projects and tiles appear to have vanished. Pinning the path explicitly to the original location
// preserves all existing data with zero action required from anyone updating, through any rename.
// NOTE: the exact lowercase "launchpad" matches the very first version's package.json "name"
// field — Electron derives the default userData folder name from "name", not "productName". Using
// the wrong case here would silently defeat this entire fix on case-sensitive filesystems.
app.setPath('userData', path.join(app.getPath('appData'), 'launchpad'));

// A private, standard scheme for serving icon/background asset files straight from disk into
// <img> tags without round-tripping them through IPC as base64 on every render. Must be
// registered before the app is ready.
protocol.registerSchemesAsPrivileged([
  { scheme: 'pqasset', privileges: { secure: true, standard: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
]);

const ASSET_DIRS = {
  icons: path.join(app.getPath('userData'), 'icons'),
  backgrounds: path.join(app.getPath('userData'), 'backgrounds')
};
const BUNDLED_ASSET_DIRS = {
  icons: path.join(__dirname, 'renderer', 'bundled-icons'),
  backgrounds: path.join(__dirname, 'renderer', 'bundled-backgrounds')
};
const SEEDED_MARKER_PATH = path.join(app.getPath('userData'), '.assets-seeded');

const ICON_PATH = path.join(__dirname, 'renderer', 'icon.png');

const IMAGE_MIME_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif'
  // Note: .tif/.tiff are deliberately excluded — Chromium (and therefore Electron) does not
  // reliably decode TIFF in an <img> tag, so including it would show a broken-image icon
  // instead of a real preview, which is worse than the type-icon fallback.
};
const MAX_PREVIEW_BYTES = 30 * 1024 * 1024; // skip embedding thumbnails larger than this

// ---------- icon & background asset library ----------
async function ensureAssetDirs(){
  await fs.mkdir(ASSET_DIRS.icons, { recursive: true });
  await fs.mkdir(ASSET_DIRS.backgrounds, { recursive: true });
}

// Copies the app's built-in starter icons/backgrounds into the user's own asset library exactly
// once (tracked by a marker file) — after that, the user is free to delete any of them without
// them reappearing on next launch.
async function seedBundledAssets(){
  try{
    await fs.access(SEEDED_MARKER_PATH);
    return; // already seeded
  }catch(err){
    // marker doesn't exist yet — fall through and seed
  }
  for(const kind of ['icons', 'backgrounds']){
    try{
      const bundledDir = BUNDLED_ASSET_DIRS[kind];
      const entries = await fs.readdir(bundledDir).catch(() => []);
      for(const entry of entries){
        const src = path.join(bundledDir, entry);
        const dest = path.join(ASSET_DIRS[kind], entry);
        try{ await fs.copyFile(src, dest); }catch(copyErr){ /* skip this one, keep going */ }
      }
    }catch(err){ /* no bundled folder for this kind — fine, nothing to seed */ }
  }
  await fs.writeFile(SEEDED_MARKER_PATH, new Date().toISOString());
}

function isSafeAssetFilename(name){
  // Generated filenames are always simple (see generateAssetFilename); reject anything else,
  // most importantly path separators or ".." which could otherwise escape the asset folder.
  return typeof name === 'string' && /^[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/.test(name);
}

function generateAssetFilename(ext){
  return Date.now().toString(36) + '-' + crypto.randomBytes(6).toString('hex') + ext;
}

function extensionFromDataUrl(dataUrl){
  const match = /^data:image\/([a-zA-Z0-9+.-]+);base64,/.exec(dataUrl || '');
  if(!match) return null;
  let sub = match[1].toLowerCase();
  if(sub === 'jpeg') sub = 'jpg';
  if(sub === 'svg+xml') sub = 'svg';
  return '.' + sub;
}

function registerAssetProtocol(){
  protocol.handle('pqasset', async (request) => {
    try{
      const url = new URL(request.url);
      const kind = url.hostname; // 'icons' or 'backgrounds'
      const filename = decodeURIComponent(url.pathname.replace(/^\//, ''));
      if(!ASSET_DIRS[kind] || !isSafeAssetFilename(filename)){
        return new Response('Not found', { status: 404 });
      }
      const filePath = path.join(ASSET_DIRS[kind], filename);
      const ext = path.extname(filename).toLowerCase();
      const mime = IMAGE_MIME_TYPES[ext] || 'application/octet-stream';
      const data = await fs.readFile(filePath);
      return new Response(data, { headers: { 'content-type': mime, 'content-length': String(data.length) } });
    }catch(err){
      return new Response('Not found', { status: 404 });
    }
  });
}

function createWindow(){
  const win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 760,
    minHeight: 520,
    backgroundColor: '#1B1C19',
    icon: ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  if(!app.isPackaged){
    // Surface renderer console output in the terminal during `npm start` for easier debugging.
    win.webContents.on('console-message', (event, level, message, line, sourceId) => {
      console.log('[renderer]', message, sourceId ? '(' + sourceId + ':' + line + ')' : '');
    });
  }

  return win;
}

app.whenReady().then(async () => {
  if(process.platform === 'darwin' && app.dock){
    app.dock.setIcon(ICON_PATH);
  }

  registerAssetProtocol();
  await ensureAssetDirs();
  await seedBundledAssets();

  createWindow();

  app.on('activate', () => {
    if(BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if(process.platform !== 'darwin') app.quit();
});

// ---------- IPC: native Finder dialog, returns a real absolute path or null if cancelled ----------
ipcMain.handle('browse-path', async (event, kind) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const options = { defaultPath: kind === 'app' ? '/Applications' : app.getPath('home') };

  if(kind === 'folder'){
    options.properties = ['openDirectory'];
  } else {
    // 'file' and 'app' both resolve to a single selectable item in Finder's native picker
    // (macOS shows .app bundles as selectable files, not traversable folders).
    options.properties = ['openFile'];
  }

  const result = await dialog.showOpenDialog(win, options);
  if(result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// ---------- IPC: open a file, folder, or app the same way double-clicking it in Finder would ----------
ipcMain.handle('open-path', async (event, targetPath) => {
  if(typeof targetPath !== 'string' || !targetPath.trim()){
    return { ok:false, error:'No path was provided.' };
  }
  const errorMessage = await shell.openPath(targetPath);
  if(errorMessage){
    return { ok:false, error:errorMessage };
  }
  return { ok:true };
});

// ---------- IPC: open a web link in the user's default browser ----------
ipcMain.handle('open-external', async (event, url) => {
  if(typeof url !== 'string' || !/^https?:\/\//i.test(url)){
    return { ok:false, error:'That doesn\u2019t look like a valid web address.' };
  }
  await shell.openExternal(url);
  return { ok:true };
});

// ---------- IPC: detect installed Chrome profiles for the "Browser Profiles" settings screen ----------
// Reads ONLY the profile directory name, display name, and signed-in account label from Chrome's
// "Local State" file. Deliberately never touches Cookies, Login Data, or any file that could
// contain credentials or session tokens — this handler cannot see or store that information.
ipcMain.handle('get-chrome-profiles', async () => {
  const localStatePath = path.join(app.getPath('home'), 'Library', 'Application Support', 'Google', 'Chrome', 'Local State');
  try{
    const raw = await fs.readFile(localStatePath, 'utf8');
    const data = JSON.parse(raw);
    const cache = (data.profile && data.profile.info_cache) || {};
    const profiles = Object.keys(cache).map(function(directory){
      const info = cache[directory] || {};
      return {
        directory: directory,
        chromeName: typeof info.name === 'string' ? info.name : directory,
        email: typeof info.user_name === 'string' && info.user_name ? info.user_name : (typeof info.gaia_name === 'string' ? info.gaia_name : null)
      };
    });
    return { ok:true, profiles: profiles };
  }catch(err){
    return { ok:false, profiles:[], error:'Could not detect Chrome profiles. Make sure Google Chrome is installed and has been opened at least once.' };
  }
});

// ---------- IPC: open a URL in a specific Chrome profile ----------
// Launches Chrome's executable directly with --profile-directory, forcing a genuinely new process
// (-n) rather than relying on an already-running Chrome instance to honor the flag — Chrome's
// single-instance behavior is well documented to sometimes ignore --profile-directory when
// forwarding to an existing process. This materially improves reliability but isn't a 100%
// guarantee in every Chrome version/state; if the launch fails outright, this falls back to the
// normal default-browser behavior rather than doing nothing.
ipcMain.handle('open-url-with-profile', async (event, url, profileDirectory) => {
  if(typeof url !== 'string' || !/^https?:\/\//i.test(url)){
    return { ok:false, error:'That doesn\u2019t look like a valid web address.' };
  }
  if(typeof profileDirectory !== 'string' || !profileDirectory.trim()){
    await shell.openExternal(url);
    return { ok:true, usedProfile:false };
  }
  try{
    const child = spawn('open', ['-na', 'Google Chrome', '--args', '--profile-directory=' + profileDirectory, url], { detached:true, stdio:'ignore' });
    child.unref();
    return { ok:true, usedProfile:true };
  }catch(err){
    try{
      await shell.openExternal(url);
      return { ok:true, usedProfile:false, fallback:true };
    }catch(fallbackErr){
      return { ok:false, error:'Could not open that link.' };
    }
  }
});

// ---------- IPC: expose the app's version (single source of truth: package.json via Electron) ----------
// ---------- IPC: icon & background asset library ----------
async function saveAsset(kind, dataUrl){
  const match = /^data:image\/[a-zA-Z0-9+.-]+;base64,(.+)$/.exec(dataUrl || '');
  if(!match) return { ok:false, error:'That doesn\u2019t look like a valid image.' };
  const ext = extensionFromDataUrl(dataUrl) || '.png';
  const filename = generateAssetFilename(ext);
  const filePath = path.join(ASSET_DIRS[kind], filename);
  try{
    await fs.writeFile(filePath, Buffer.from(match[1], 'base64'));
    return { ok:true, filename: filename, url: 'pqasset://' + kind + '/' + filename };
  }catch(err){
    return { ok:false, error:'Could not save that image.' };
  }
}

ipcMain.handle('save-icon-asset', (event, dataUrl) => saveAsset('icons', dataUrl));
ipcMain.handle('save-background-asset', (event, dataUrl) => saveAsset('backgrounds', dataUrl));

async function listAssets(kind){
  try{
    const entries = await fs.readdir(ASSET_DIRS[kind]);
    const images = entries.filter(function(name){
      const ext = path.extname(name).toLowerCase();
      return !!IMAGE_MIME_TYPES[ext];
    });
    return { ok:true, files: images.map(function(name){ return { filename: name, url: 'pqasset://' + kind + '/' + name }; }) };
  }catch(err){
    return { ok:false, files: [], error:'Could not read the asset library.' };
  }
}

ipcMain.handle('list-icon-assets', () => listAssets('icons'));
ipcMain.handle('list-background-assets', () => listAssets('backgrounds'));

// ---------- IPC: full backup export/import (state + icon/background library, bundled as a zip) ----------
ipcMain.handle('export-backup', async (event, stateJson) => {
  const result = await dialog.showSaveDialog({
    title: 'Export ProjQik Backup',
    defaultPath: 'projqik-backup-' + new Date().toISOString().slice(0, 10) + '.zip',
    filters: [{ name: 'ProjQik Backup', extensions: ['zip'] }]
  });
  if(result.canceled || !result.filePath) return { ok:true, cancelled:true };
  try{
    const zip = new AdmZip();
    zip.addFile('state.json', Buffer.from(stateJson, 'utf8'));
    for(const kind of ['icons', 'backgrounds']){
      let entries = [];
      try{ entries = await fs.readdir(ASSET_DIRS[kind]); }catch(err){ entries = []; }
      for(const name of entries){
        try{
          const data = await fs.readFile(path.join(ASSET_DIRS[kind], name));
          zip.addFile(kind + '/' + name, data);
        }catch(err){ /* skip this one file, keep going */ }
      }
    }
    zip.writeZip(result.filePath);
    return { ok:true, cancelled:false };
  }catch(err){
    return { ok:false, error:'Could not create the backup file.' };
  }
});

ipcMain.handle('import-backup', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Import ProjQik Backup',
    properties: ['openFile'],
    filters: [{ name: 'ProjQik Backup', extensions: ['zip', 'json'] }]
  });
  if(result.canceled || !result.filePaths || result.filePaths.length === 0) return { ok:true, cancelled:true };
  const filePath = result.filePaths[0];
  try{
    if(filePath.toLowerCase().endsWith('.json')){
      // Backward compatibility: a plain-JSON backup from before v3.0, with no bundled assets.
      const text = await fs.readFile(filePath, 'utf8');
      return { ok:true, cancelled:false, stateJson: text };
    }
    const zip = new AdmZip(filePath);
    const entries = zip.getEntries();
    const stateEntry = entries.find(function(e){ return e.entryName === 'state.json'; });
    if(!stateEntry) return { ok:false, error:'That file doesn\u2019t look like a ProjQik backup.' };
    const stateJson = stateEntry.getData().toString('utf8');
    for(const entry of entries){
      if(entry.isDirectory) continue;
      const parts = entry.entryName.split('/');
      if(parts.length !== 2) continue;
      const kind = parts[0];
      const filename = parts[1];
      if(!ASSET_DIRS[kind] || !isSafeAssetFilename(filename)) continue;
      const destPath = path.join(ASSET_DIRS[kind], filename);
      try{
        await fs.access(destPath);
        continue; // a file with this generated name already exists — assume it's the same asset
      }catch(err){
        await fs.writeFile(destPath, entry.getData());
      }
    }
    return { ok:true, cancelled:false, stateJson: stateJson };
  }catch(err){
    return { ok:false, error:'Could not read that backup file.' };
  }
});

// ---------- IPC: expose the app's version (single source of truth: package.json via Electron) ----------
ipcMain.handle('get-app-version', () => app.getVersion());

// ---------- IPC: quit the app entirely (the "Exit" button) ----------
ipcMain.handle('quit-app', () => {
  app.quit();
});

// ---------- IPC: open a pre-addressed email in the user's default mail client ----------
// The address is hardcoded here, not passed from the renderer, so nothing in the app's data
// (tiles, project names, etc.) can ever influence what address this opens.
const SUPPORT_EMAIL = 'Freedomforgeai@gmail.com';
ipcMain.handle('contact-support', async () => {
  await shell.openExternal('mailto:' + SUPPORT_EMAIL + '?subject=' + encodeURIComponent('ProjQik feedback'));
  return { ok: true };
});

// ---------- IPC: real filesystem metadata + an image thumbnail when available, for the preview panel ----------
ipcMain.handle('get-path-info', async (event, targetPath) => {
  if(typeof targetPath !== 'string' || targetPath.charAt(0) !== '/'){
    return { exists:false };
  }

  let stat;
  try{
    stat = await fs.stat(targetPath);
  }catch(err){
    return { exists:false, error:'Nothing found at that path.' };
  }

  const ext = path.extname(targetPath).toLowerCase();
  const isApp = ext === '.app';
  const isDirectory = stat.isDirectory() && !isApp;
  const kind = isApp ? 'Application' : (isDirectory ? 'Folder' : (ext ? ext.slice(1).toUpperCase() + ' File' : 'File'));

  const info = {
    exists: true,
    name: path.basename(targetPath),
    kind,
    isDirectory,
    sizeBytes: (isDirectory || isApp) ? null : stat.size,
    modifiedAt: stat.mtime.toISOString()
  };

  const mime = IMAGE_MIME_TYPES[ext];
  if(mime && !isDirectory && !isApp && stat.size <= MAX_PREVIEW_BYTES){
    try{
      const buffer = await fs.readFile(targetPath);
      info.imageDataUrl = 'data:' + mime + ';base64,' + buffer.toString('base64');
    }catch(readErr){
      // Thumbnail is a bonus, not required — metadata above is still useful without it.
    }
  }

  // NOTE: an earlier version of this handler also tried app.getFileIcon() as a fallback to show
  // each file's real OS icon (Word/PDF/etc). That call runs in the main process, and on some
  // systems it can crash the entire app rather than fail gracefully — a JS try/catch can't stop
  // that kind of failure. It's been removed for stability; non-image files fall back to the
  // renderer's generic type icon instead.

  return info;
});
