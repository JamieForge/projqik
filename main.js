const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, nativeImage } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
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
  backgrounds: path.join(app.getPath('userData'), 'backgrounds'),
  favicons: path.join(app.getPath('userData'), 'favicons') // cache of website icons for link tiles
};
const APP_INDEX_URL = pathToFileURL(path.join(__dirname, 'renderer', 'index.html')).href;
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
  await fs.mkdir(ASSET_DIRS.favicons, { recursive: true });
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

// Resolves a library-relative path (an array of already-decoded segments) to an absolute path that
// is guaranteed to sit inside the given library folder, or returns null if it can't be trusted.
// Every segment is rejected if it's empty, a dot segment, hidden, or contains a path separator or
// NUL, and the fully resolved path must still be strictly inside the library folder. This is what
// keeps a crafted URL or a backup-zip entry name (e.g. "..%2F..%2Fmain.js") from ever reaching
// outside it — while allowing ordinary names with spaces, parentheses, accents, and subfolders.
function safeAssetPath(kind, segments){
  const base = ASSET_DIRS[kind];
  if(!base || !Array.isArray(segments) || segments.length === 0 || segments.length > 6) return null;
  for(const seg of segments){
    if(typeof seg !== 'string' || !seg || seg === '.' || seg === '..' || seg.charAt(0) === '.' || /[\/\\\0]/.test(seg)) return null;
  }
  const resolved = path.resolve(base, ...segments);
  if(!resolved.startsWith(base + path.sep)) return null;
  return resolved;
}

// Builds the pqasset:// URL the renderer uses as an <img> source. Each segment is percent-encoded,
// so names with spaces or special characters round-trip safely.
function assetUrl(kind, segments){
  // encodeURIComponent leaves ! ' ( ) * alone; encode those too so a name like "Logo (final).png"
  // is safe inside an HTML attribute, a CSS url(...), or a single-quoted string alike.
  const encode = function(s){ return encodeURIComponent(s).replace(/[!'()*]/g, function(c){ return '%' + c.charCodeAt(0).toString(16).toUpperCase(); }); };
  return 'pqasset://' + kind + '/' + segments.map(encode).join('/');
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
  if(sub === 'x-icon' || sub === 'vnd.microsoft.icon') sub = 'ico';
  const ext = '.' + sub;
  return IMAGE_MIME_TYPES[ext] ? ext : null;
}

function registerAssetProtocol(){
  const notFound = () => new Response('Not found', { status: 404 });
  protocol.handle('pqasset', async (request) => {
    try{
      const url = new URL(request.url);
      const kind = url.hostname; // 'icons', 'backgrounds' or 'favicons'
      if(!ASSET_DIRS[kind]) return notFound();
      const segments = url.pathname.split('/').slice(1).map(decodeURIComponent);
      const filePath = safeAssetPath(kind, segments);
      if(!filePath) return notFound();
      const ext = path.extname(filePath).toLowerCase();
      const mime = IMAGE_MIME_TYPES[ext];
      if(!mime) return notFound();
      const data = await fs.readFile(filePath);
      const headers = { 'content-type': mime, 'content-length': String(data.length) };
      // Defense in depth: even though these are only ever shown through <img> (where scripts never
      // run), an SVG served from here gets a policy that forbids anything active.
      if(ext === '.svg') headers['content-security-policy'] = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
      return new Response(data, { headers });
    }catch(err){
      return notFound();
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

  // The app is a single page that never navigates anywhere else. Without this, dropping a link (or
  // a file) onto the window could replace the whole app with that page. Anything other than the
  // app's own page is blocked, and nothing is allowed to open extra windows.
  win.webContents.on('will-navigate', (event, url) => {
    try{
      const target = new URL(url);
      const own = new URL(APP_INDEX_URL);
      if(target.protocol === own.protocol && target.pathname === own.pathname) return;
    }catch(err){ /* fall through and block */ }
    event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

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

// ---------- IPC: icon & background asset library ----------
async function saveAsset(kind, dataUrl){
  const match = /^data:image\/[a-zA-Z0-9+.-]+;base64,(.+)$/.exec(dataUrl || '');
  const ext = extensionFromDataUrl(dataUrl);
  if(!match || !ext) return { ok:false, error:'That doesn\u2019t look like a supported image.' };
  const filename = generateAssetFilename(ext);
  const filePath = safeAssetPath(kind, [filename]);
  if(!filePath) return { ok:false, error:'Could not save that image.' };
  try{
    await fs.writeFile(filePath, Buffer.from(match[1], 'base64'));
    return { ok:true, filename: filename, url: assetUrl(kind, [filename]) };
  }catch(err){
    return { ok:false, error:'Could not save that image.' };
  }
}

ipcMain.handle('save-icon-asset', (event, dataUrl) => saveAsset('icons', dataUrl));
ipcMain.handle('save-background-asset', (event, dataUrl) => saveAsset('backgrounds', dataUrl));

const LIST_MAX_FILES = 5000;
const LIST_MAX_DEPTH = 4;

// Walks a library folder (including subfolders) and collects every image and every folder path.
// Hidden entries (like .DS_Store) and symlinks are skipped on purpose.
async function walkAssets(kind, dirSegments, depth, out){
  if(depth > LIST_MAX_DEPTH || out.files.length >= LIST_MAX_FILES) return;
  const dirPath = dirSegments.length ? path.join(ASSET_DIRS[kind], ...dirSegments) : ASSET_DIRS[kind];
  let entries;
  try{ entries = await fs.readdir(dirPath, { withFileTypes: true }); }catch(err){ return; }
  entries.sort(function(a, b){ return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }); });
  for(const entry of entries){
    if(entry.name.charAt(0) === '.') continue;
    if(entry.isDirectory()){
      out.folders.push(dirSegments.concat(entry.name).join('/'));
      await walkAssets(kind, dirSegments.concat(entry.name), depth + 1, out);
    }else if(entry.isFile()){
      const ext = path.extname(entry.name).toLowerCase();
      if(!IMAGE_MIME_TYPES[ext]) continue;
      out.files.push({ filename: entry.name, folder: dirSegments.join('/'), url: assetUrl(kind, dirSegments.concat(entry.name)) });
      if(out.files.length >= LIST_MAX_FILES) return;
    }
  }
}

async function listAssets(kind){
  const out = { files: [], folders: [] };
  try{
    await walkAssets(kind, [], 0, out);
    return { ok:true, files: out.files, folders: out.folders };
  }catch(err){
    return { ok:false, files: [], folders: [], error:'Could not read the asset library.' };
  }
}

ipcMain.handle('list-icon-assets', () => listAssets('icons'));
ipcMain.handle('list-background-assets', () => listAssets('backgrounds'));

// Reveals the library folder in Finder so images can simply be dropped in (subfolders included).
ipcMain.handle('open-asset-folder', async (event, kind) => {
  if(kind !== 'icons' && kind !== 'backgrounds') return { ok:false, error:'Unknown library.' };
  try{
    await fs.mkdir(ASSET_DIRS[kind], { recursive: true });
    const errorMessage = await shell.openPath(ASSET_DIRS[kind]);
    return errorMessage ? { ok:false, error: errorMessage } : { ok:true };
  }catch(err){
    return { ok:false, error:'Could not open the library folder.' };
  }
});

// Copies every image from a chosen folder (and its subfolders) into the library, keeping the
// folder structure. Oversized PNG/JPEG icons are scaled down to a sensible size so a big
// collection doesn't make the library slow to open.
const IMPORT_MAX_FILES = 3000;
const IMPORT_MAX_BYTES = 30 * 1024 * 1024;
const IMPORT_MAX_DEPTH = 4;
const ICON_MAX_DIMENSION = 512;

async function importFolderTree(kind, srcDir, destSegments, depth, stats){
  if(depth > IMPORT_MAX_DEPTH) return;
  let entries;
  try{ entries = await fs.readdir(srcDir, { withFileTypes: true }); }catch(err){ return; }
  for(const entry of entries){
    if(entry.name.charAt(0) === '.') continue;
    const srcPath = path.join(srcDir, entry.name);
    if(entry.isDirectory()){
      await importFolderTree(kind, srcPath, destSegments.concat(entry.name), depth + 1, stats);
    }else if(entry.isFile()){
      const ext = path.extname(entry.name).toLowerCase();
      if(!IMAGE_MIME_TYPES[ext]){ stats.skipped++; continue; }
      if(stats.imported >= IMPORT_MAX_FILES){ stats.truncated = true; return; }
      const destPath = safeAssetPath(kind, destSegments.concat(entry.name));
      if(!destPath){ stats.skipped++; continue; }
      try{
        const st = await fs.stat(srcPath);
        if(st.size > IMPORT_MAX_BYTES){ stats.skipped++; continue; }
        let alreadyThere = true;
        try{ await fs.access(destPath); }catch(err){ alreadyThere = false; }
        if(alreadyThere){ stats.existing++; continue; }
        await fs.mkdir(path.dirname(destPath), { recursive: true });
        let wrote = false;
        if(kind === 'icons' && (ext === '.png' || ext === '.jpg' || ext === '.jpeg')){
          try{
            const img = nativeImage.createFromPath(srcPath);
            const size = img.getSize();
            if(!img.isEmpty() && (size.width > ICON_MAX_DIMENSION || size.height > ICON_MAX_DIMENSION)){
              const scale = ICON_MAX_DIMENSION / Math.max(size.width, size.height);
              const resized = img.resize({
                width: Math.max(1, Math.round(size.width * scale)),
                height: Math.max(1, Math.round(size.height * scale)),
                quality: 'best'
              });
              await fs.writeFile(destPath, ext === '.png' ? resized.toPNG() : resized.toJPEG(90));
              wrote = true;
              stats.downscaled++;
            }
          }catch(err){ /* couldn't resize — fall back to a plain copy below */ }
        }
        if(!wrote) await fs.copyFile(srcPath, destPath);
        stats.imported++;
      }catch(err){
        stats.skipped++;
      }
    }
  }
}

ipcMain.handle('import-asset-folder', async (event, kind) => {
  if(kind !== 'icons' && kind !== 'backgrounds') return { ok:false, error:'Unknown library.' };
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win, { title: 'Choose a folder of images to add', properties: ['openDirectory'] });
  if(result.canceled || !result.filePaths || result.filePaths.length === 0) return { ok:true, cancelled:true };
  const srcDir = result.filePaths[0];
  const relToLibrary = path.relative(ASSET_DIRS[kind], srcDir);
  if(relToLibrary === '' || (!relToLibrary.startsWith('..') && !path.isAbsolute(relToLibrary))){
    return { ok:false, error:'That folder is already part of your library.' };
  }
  const topFolder = path.basename(srcDir);
  const stats = { imported: 0, skipped: 0, existing: 0, downscaled: 0, truncated: false };
  // Images directly inside the chosen folder land in a category named after it; any subfolders
  // keep their structure beneath that category.
  await importFolderTree(kind, srcDir, [topFolder], 0, stats);
  return Object.assign({ ok:true, cancelled:false, folder: topFolder }, stats);
});

// ---------- IPC: website icon (favicon) and page title for link tiles ----------
// Runs entirely from this app straight to the site the user is already linking to — no
// third-party icon service ever sees which sites are in someone's tiles, and no cookies or
// credentials are sent. Every failure is silent: the tile just keeps its default link icon.
const SITE_META_TIMEOUT_MS = 6000;
const MAX_HTML_BYTES = 256 * 1024;
const MAX_ICON_BYTES = 400 * 1024;
const FAVICON_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const siteMetaInFlight = new Map();

async function readLimited(res, maxBytes){
  const reader = res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null;
  if(!reader){
    const all = Buffer.from(await res.arrayBuffer());
    return all.length > maxBytes ? { buffer: all.subarray(0, maxBytes), truncated: true } : { buffer: all, truncated: false };
  }
  const chunks = [];
  let total = 0;
  let truncated = false;
  while(true){
    const step = await reader.read();
    if(step.done) break;
    chunks.push(Buffer.from(step.value));
    total += step.value.length;
    if(total > maxBytes){
      truncated = true;
      try{ await reader.cancel(); }catch(err){ /* already closing */ }
      break;
    }
  }
  const joined = Buffer.concat(chunks);
  return { buffer: truncated ? joined.subarray(0, maxBytes) : joined, truncated };
}

async function httpGetLimited(url, maxBytes){
  const controller = new AbortController();
  const timer = setTimeout(function(){ controller.abort(); }, SITE_META_TIMEOUT_MS);
  try{
    const res = await net.fetch(url, { signal: controller.signal, redirect: 'follow', credentials: 'omit' });
    if(!res.ok) return null;
    const body = await readLimited(res, maxBytes);
    return { buffer: body.buffer, truncated: body.truncated, finalUrl: res.url || url, contentType: res.headers.get('content-type') || '' };
  }catch(err){
    return null;
  }finally{
    clearTimeout(timer);
  }
}

function decodeHtmlEntities(text){
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, function(whole, entity){
    const e = entity.toLowerCase();
    if(e === 'amp') return '&';
    if(e === 'lt') return '<';
    if(e === 'gt') return '>';
    if(e === 'quot') return '"';
    if(e === 'apos') return "'";
    if(e === 'nbsp') return ' ';
    try{
      const code = e.charAt(1) === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return String.fromCodePoint(code);
    }catch(err){
      return whole;
    }
  });
}

function tagAttribute(tag, name){
  const re = new RegExp('\\s' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i');
  const m = re.exec(tag);
  if(!m) return null;
  return m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3]);
}

// Pulls the page title and a ranked list of candidate icon URLs out of a page's HTML.
function parseSiteHtml(html, baseUrl){
  const result = { title: '', icons: [] };
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if(titleMatch){
    let title = decodeHtmlEntities(titleMatch[1]).replace(/\s+/g, ' ').trim();
    if(title.length > 120) title = title.slice(0, 120).trim() + '\u2026';
    result.title = title;
  }
  const scored = [];
  const linkRe = /<link\b[^>]*>/gi;
  let m;
  while((m = linkRe.exec(html))){
    const tag = m[0];
    const rel = (tagAttribute(tag, 'rel') || '').toLowerCase();
    const href = tagAttribute(tag, 'href');
    if(!rel || !href) continue;
    if(rel.indexOf('mask-icon') !== -1) continue;
    if(rel.indexOf('icon') === -1) continue; // matches "icon", "shortcut icon", "apple-touch-icon"
    let absolute;
    try{ absolute = new URL(decodeHtmlEntities(href), baseUrl).href; }catch(err){ continue; }
    if(!/^https?:/i.test(absolute)) continue;
    const sizes = tagAttribute(tag, 'sizes') || '';
    const type = (tagAttribute(tag, 'type') || '').toLowerCase();
    let score = 32;
    const dims = /(\d+)\s*x\s*(\d+)/i.exec(sizes);
    if(dims) score = Math.max(parseInt(dims[1], 10), parseInt(dims[2], 10));
    if(type.indexOf('svg') !== -1 || /\.svg(\?|#|$)/i.test(absolute)) score = Math.max(score, 300);
    if(rel.indexOf('apple-touch-icon') !== -1) score += 10;
    scored.push({ url: absolute, score: score });
  }
  scored.sort(function(a, b){ return b.score - a.score; });
  result.icons = scored.map(function(s){ return s.url; });
  return result;
}

function sniffImageType(buf){
  if(!buf || buf.length < 4) return null;
  if(buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'png';
  if(buf[0] === 0xFF && buf[1] === 0xD8) return 'jpg';
  if(buf.subarray(0, 3).toString('ascii') === 'GIF') return 'gif';
  if(buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0) return 'ico';
  if(buf.length > 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  const head = buf.subarray(0, 512).toString('utf8').replace(/^\uFEFF/, '').trimStart().toLowerCase();
  if(head.startsWith('<svg') || (head.startsWith('<?xml') && head.indexOf('<svg') !== -1)) return 'svg';
  return null;
}

function faviconBaseName(origin){
  return crypto.createHash('sha1').update(origin).digest('hex').slice(0, 16);
}

async function findCachedFavicon(origin){
  const prefix = faviconBaseName(origin) + '.';
  let names = [];
  try{ names = await fs.readdir(ASSET_DIRS.favicons); }catch(err){ return null; }
  const name = names.find(function(n){ return n.indexOf(prefix) === 0; });
  if(!name) return null;
  try{
    const st = await fs.stat(path.join(ASSET_DIRS.favicons, name));
    return { name: name, fresh: (Date.now() - st.mtimeMs) < FAVICON_TTL_MS };
  }catch(err){
    return null;
  }
}

async function saveFavicon(origin, buffer, type){
  const base = faviconBaseName(origin);
  try{
    const names = await fs.readdir(ASSET_DIRS.favicons);
    for(const n of names){
      if(n.indexOf(base + '.') === 0) await fs.unlink(path.join(ASSET_DIRS.favicons, n)).catch(function(){});
    }
  }catch(err){ /* nothing to clean up */ }
  const filename = base + '.' + type;
  await fs.writeFile(path.join(ASSET_DIRS.favicons, filename), buffer);
  return assetUrl('favicons', [filename]);
}

async function fetchSiteMeta(pageUrl, origin, wantTitle){
  const result = { ok: true };
  const cached = await findCachedFavicon(origin);
  const needIcon = !(cached && cached.fresh);
  if(cached) result.faviconUrl = assetUrl('favicons', [cached.name]);
  if(!needIcon && !wantTitle) return result;

  let candidates = [];
  const page = await httpGetLimited(pageUrl, MAX_HTML_BYTES);
  if(page && /html|xml|text/i.test(page.contentType || 'text/html')){
    const parsed = parseSiteHtml(page.buffer.toString('utf8'), page.finalUrl || pageUrl);
    if(wantTitle && parsed.title) result.title = parsed.title;
    candidates = parsed.icons;
  }
  if(needIcon){
    candidates = candidates.concat([origin + '/favicon.ico']);
    const seen = new Set();
    let tried = 0;
    for(const candidate of candidates){
      if(seen.has(candidate)) continue;
      seen.add(candidate);
      if(tried++ >= 4) break;
      const icon = await httpGetLimited(candidate, MAX_ICON_BYTES);
      if(!icon || icon.truncated || icon.buffer.length < 64) continue;
      const type = sniffImageType(icon.buffer);
      if(!type) continue;
      result.faviconUrl = await saveFavicon(origin, icon.buffer, type);
      break;
    }
  }
  return result;
}

ipcMain.handle('fetch-site-meta', (event, url, options) => {
  if(typeof url !== 'string' || !/^https?:\/\//i.test(url)) return { ok:false };
  let origin;
  try{ origin = new URL(url).origin; }catch(err){ return { ok:false }; }
  const wantTitle = !!(options && options.wantTitle);
  const key = origin + (wantTitle ? '|title' : '');
  if(!siteMetaInFlight.has(key)){
    const job = fetchSiteMeta(url, origin, wantTitle).catch(function(){ return { ok:false }; }).finally(function(){ siteMetaInFlight.delete(key); });
    siteMetaInFlight.set(key, job);
  }
  return siteMetaInFlight.get(key);
});

// ---------- IPC: full backup export/import (state + icon/background library, bundled as a zip) ----------
async function addAssetTreeToZip(zip, kind, dirSegments, depth){
  if(depth > LIST_MAX_DEPTH + 1) return;
  const dirPath = dirSegments.length ? path.join(ASSET_DIRS[kind], ...dirSegments) : ASSET_DIRS[kind];
  let entries;
  try{ entries = await fs.readdir(dirPath, { withFileTypes: true }); }catch(err){ return; }
  for(const entry of entries){
    if(entry.name.charAt(0) === '.') continue;
    if(entry.isDirectory()){
      await addAssetTreeToZip(zip, kind, dirSegments.concat(entry.name), depth + 1);
    }else if(entry.isFile()){
      try{
        const data = await fs.readFile(path.join(dirPath, entry.name));
        zip.addFile([kind].concat(dirSegments, entry.name).join('/'), data);
      }catch(err){ /* skip this one file, keep going */ }
    }
  }
}

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
    for(const kind of ['icons', 'backgrounds', 'favicons']){
      await addAssetTreeToZip(zip, kind, [], 0);
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
      const kind = parts[0];
      if(!ASSET_DIRS[kind]) continue;
      // Every entry name is untrusted input (a zip can contain "../" tricks), so it has to pass
      // the same containment check as everything else, and only real image types are restored.
      const destPath = safeAssetPath(kind, parts.slice(1));
      if(!destPath || !IMAGE_MIME_TYPES[path.extname(destPath).toLowerCase()]) continue;
      let alreadyThere = true;
      try{ await fs.access(destPath); }catch(err){ alreadyThere = false; }
      if(alreadyThere) continue; // a file with this name already exists — assume it's the same asset
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      await fs.writeFile(destPath, entry.getData());
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
