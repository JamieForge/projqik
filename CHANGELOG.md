# ProjQik changelog

## 3.2.0
- Launch splash screen: ProjQik opens with a short cinematic welcome (Freedom Forge AI credit, the
  ProjQik mark slowly zooming in, then a fade into the app). Click or press any key to skip. It plays
  at every launch, can be turned off in Preferences, and respects macOS "Reduce motion".
- New "Steel" color scheme (cool brushed-metal gray) as a fourth option.
- Clone a tile: a new button on every tile duplicates the whole tile (path, icon, note, Chrome profile)
  right next to the original. The old "Copy path" button is still there.
- New "Custom" filter next to Links: pick exactly which tiles in a project belong to it with
  "Choose tiles…" - handy for presenting. Each project has its own Custom group.
- Icons: new "Choose from Finder…" button in the tile icon picker opens a real file chooser inside your
  icon library (subfolders and all). Pictures from elsewhere are copied into the library.
- Application tiles now show the app's own icon (read from the app itself, nothing sent anywhere),
  filled in automatically for existing tiles shortly after launch. "Fetch icons for my existing links
  and apps" in Preferences re-checks everything.
- Fixed: "Open folder" left you unable to choose an icon; the new Finder chooser does that.
- Bundled font (Orbitron, SIL Open Font License) so the splash looks the same offline.

## 3.1.0
- Icon and background libraries now support subfolders, with a folder filter in both pickers, an
  "Open folder" button (reveals the library in Finder) and an "Import folder…" button that copies a
  whole folder of images in (oversized icons are scaled down; backgrounds are never resized).
  Filenames with spaces, parentheses and accents now work everywhere.
- Drag a link from a web page (or the address bar) onto the window to create a link tile.
- Link tiles automatically pick up the website's own icon and, for dragged links, its page title.
  Contacts only the linked site (no third-party service, no cookies); can be turned off in
  Preferences, with a one-time "Fetch icons for my existing links" button.
- Per-tile notes: a small note icon on every tile; tiles with notes show it at all times. Notes are
  searchable and are kept when duplicate tiles are merged.
- Chrome profile choice in the edit-tile box is now a list whose long names wrap instead of
  overflowing.
- Up to 30 projects (5 new tab colors).
- Fixed: the edit-tile box could grow taller than the window and hide the Save button; it now scrolls.
- Hardened: a dropped link or file can no longer navigate the app window away; backup import
  rejects any entry that tries to write outside the library.
