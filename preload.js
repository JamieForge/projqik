const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('projqik', {
  // Opens a native Finder dialog scoped to the given kind ('file' | 'folder' | 'app').
  // Resolves to a real absolute path, or null if the user cancelled.
  browsePath: (kind) => ipcRenderer.invoke('browse-path', kind),

  // Opens a file, folder, or app exactly like double-clicking it in Finder.
  // Resolves to { ok: true } or { ok: false, error: string }.
  openPath: (targetPath) => ipcRenderer.invoke('open-path', targetPath),

  // Opens a URL in the user's default browser.
  // Resolves to { ok: true } or { ok: false, error: string }.
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // Reads real filesystem metadata (and an image thumbnail when applicable) for the preview panel.
  getPathInfo: (targetPath) => ipcRenderer.invoke('get-path-info', targetPath),

  // Returns the app's version string (e.g. "1.1.0"), read from package.json.
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),

  // Resolves the real absolute path of a File object dragged in from Finder/Desktop.
  // Synchronous, and safe to call from the renderer even under contextIsolation — this is the
  // officially supported replacement for the old (removed) File.path property.
  getPathForFile: (file) => webUtils.getPathForFile(file),

  // Quits the app entirely (the sidebar "Exit" button).
  quitApp: () => ipcRenderer.invoke('quit-app'),

  // Opens a pre-addressed feedback email in the user's default mail client.
  contactSupport: () => ipcRenderer.invoke('contact-support'),

  // Detects installed Chrome profiles (directory name, Chrome display name, signed-in account).
  getChromeProfiles: () => ipcRenderer.invoke('get-chrome-profiles'),

  // Opens a URL under a specific Chrome profile directory (e.g. "Profile 2").
  // Resolves to { ok: true, usedProfile: boolean } or { ok: false, error: string }.
  openUrlWithProfile: (url, profileDirectory) => ipcRenderer.invoke('open-url-with-profile', url, profileDirectory),

  // Saves a data-URL image into the shared icon library. Resolves to
  // { ok: true, filename, url } (url is a pqasset:// reference usable directly as an <img src>)
  // or { ok: false, error }.
  saveIconAsset: (dataUrl) => ipcRenderer.invoke('save-icon-asset', dataUrl),

  // Same as saveIconAsset, for the shared background image library.
  saveBackgroundAsset: (dataUrl) => ipcRenderer.invoke('save-background-asset', dataUrl),

  // Opens a Finder chooser that starts inside the icon library. Resolves to
  // { ok: true, cancelled: true } or { ok: true, url, inLibrary } or { ok: false, error }.
  chooseIconFromFinder: () => ipcRenderer.invoke('choose-icon-from-finder'),

  // Reads an Application tile's own icon. Resolves to { ok: true, url } or { ok: false }.
  getAppIcon: (appPath, force) => ipcRenderer.invoke('get-app-icon', appPath, !!force),

  // Lists everything currently in the icon library. Resolves to { ok: true, files: [{filename, url}] }.
  listIconAssets: () => ipcRenderer.invoke('list-icon-assets'),

  // Lists everything currently in the background image library. Resolves to { ok: true, files: [{filename, url}] }.
  listBackgroundAssets: () => ipcRenderer.invoke('list-background-assets'),

  // Exports a full backup (app state + the icon/background library) as a single .zip, via a
  // native Save dialog. Resolves to { ok: true, cancelled: boolean } or { ok: false, error }.
  exportBackup: (stateJson) => ipcRenderer.invoke('export-backup', stateJson),

  // Imports a backup via a native Open dialog — accepts either the new .zip format or an older
  // plain .json backup for backward compatibility. Resolves to
  // { ok: true, cancelled: boolean, stateJson? } or { ok: false, error }.
  importBackup: () => ipcRenderer.invoke('import-backup'),

  // Reveals the icon or background library folder ('icons' | 'backgrounds') in Finder.
  // Resolves to { ok: true } or { ok: false, error }.
  openAssetFolder: (kind) => ipcRenderer.invoke('open-asset-folder', kind),

  // Lets the user pick a folder of images and copies them (subfolders included) into the icon or
  // background library. Resolves to { ok: true, cancelled, folder, imported, skipped, existing,
  // downscaled, truncated } or { ok: false, error }.
  importAssetFolder: (kind) => ipcRenderer.invoke('import-asset-folder', kind),

  // Looks up a link's website icon and (optionally) its page title, straight from that site.
  // Resolves to { ok: true, faviconUrl?, title? }. Never throws for ordinary failures — a site that
  // has no icon, is offline, or is slow just resolves without those fields.
  fetchSiteMeta: (url, options) => ipcRenderer.invoke('fetch-site-meta', url, options)
});
