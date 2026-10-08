# ProjQik

A native macOS project launcher by Freedom Forge AI — one-click access to the files, folders, apps and
links for each of your projects, organized in up to 30 color-coded project tabs.

Current version: **3.2.2** (see `CHANGELOG.md`).

## Installing (for people using the app)

1. Download the zip that matches your Mac — **Apple Silicon** (M1/M2/M3/M4…) or **Intel** — and unzip it.
2. Drag **ProjQik** into your **Applications** folder.
3. Double-click it to open.

A properly signed and notarized build opens with a plain double-click, with no warnings.

*Only if macOS says the app "can't be opened" or is "damaged"* (this can only happen with an unsigned
test build): open **Terminal** and run

```
xattr -cr /Applications/ProjQik.app
```

then open it again.

**Your data stays put.** ProjQik keeps everything in a folder that has deliberately never changed
across any rename, so updating never loses projects. To update, replace the app in Applications with
the new one. Use **Preferences → Backup → Export** any time to save a full backup.

## What it does

- Up to 30 project tabs, each with its own color; archive, merge and undo
- Tiles for files, folders, apps and web links; drag from Finder, or drag a link from a web page
- Per-tile notes (searchable), one-click tile cloning, and a "Custom" tab for your own hand-picked group (star a tile or drag it onto the tab)
- Real icons for Application tiles (read from the app itself)
- Four color schemes (Graphite, Slate, Paper, Steel) and a launch splash screen you can turn off
- Automatic website icons and titles for link tiles (only ever contacts the linked site; can be turned
  off in Preferences)
- Shared icon and background libraries with subfolders, "Open folder" and "Import folder…"
- Chrome multi-profile routing — each link opens under the right Google identity (reads only profile
  names and emails, never cookies or passwords)
- Full backup and restore as a single zip

## For developers

```
npm install
npm start          # run in development
npm run dist       # build unsigned zips into dist/ (macOS output; signing needs a Mac)
```

- `main.js` — main process (windows, dialogs, filesystem, asset library, Chrome launching, backups)
- `preload.js` — the only bridge to the page (`contextBridge`)
- `renderer/index.html` — the whole UI (vanilla JS, no framework)
- **Do not change the pinned `userData` folder name** (`launchpad`) in `main.js` or the storage key
  (`launchpad.v1`) — doing so would make every existing user's data appear to vanish.

### Signed releases (GitHub Actions)

The workflow `.github/workflows/build-mac.yml` is run manually (**Actions → Build macOS App → Run
workflow**). It signs with the Developer ID certificate and notarizes with Apple when these repository
secrets exist: `APPLE_CERTIFICATE_P12_BASE64`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`. See `APPLE-SIGNING-SETUP.md`.

After a run, open the **"Report signing status"** step and look for
`Authority=Developer ID Application: Freedom Forge AI LLC (463G38UCAX)` and a Gatekeeper result of
`accepted`; the **"Build macOS app"** step should contain `notarization successful`. The finished zips
are attached to the run as the `projqik-mac-builds` artifact.

## Support

Freedomforgeai@gmail.com
