# ProjQik changelog

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
