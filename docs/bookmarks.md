# Bookmarks

Bookmarks take you straight back to a place in any service: an S3 folder, a
Parameter Store path, a queue, a table, a function, an ECS service and so on,
optionally with one item selected. Opening one works like going to a History
entry: nothing is run, the app only navigates.

Bookmarks are one set for the whole app, kept on this computer. Each bookmark
remembers the profile and region it was made in.

## The bookmarks bar

The bar is the row under the address bar. Show or hide it with **Ctrl+Shift+B**
(remembered).

From left to right:

1. **Pinned bookmarks**: one-click buttons.
2. **Feature folders**: one per service that has bookmarks (S3, Parameter
   Store, SQS…), in the service order. Every bookmark is always in its service's
   feature folder, sorted by name.
3. **Your folders**, in your order. A folder can mix services.

Click a folder for its drop-down. The folder's description is its tooltip and
the first line of the drop-down. More than 15 bookmarks adds a filter box, and
long lists scroll. The last entry is **Manage bookmarks…**.

The bar shows only the **current profile's** bookmarks. One of your folders that
has nothing for this profile stays on the bar, dimmed, so the layout doesn't
jump when you switch profiles. When the window is too narrow, what doesn't fit
moves into the **»** menu at the right.

### Opening

Click a bookmark. The app goes to its place and selects its item when the item
is on the visible page. If the bookmark was made in another region, the region
switches and the status bar says so; the drop-down marks such bookmarks with a
region tag. S3 bookmarks have no region (buckets use their own).

Bookmarks of other profiles open from the manager, which asks before
switching profile. The new connection starts read-only, as every connection
does.

If the place no longer exists, the view shows it empty or with its usual "not
found" message.

### Dragging on the bar

- Drag **your folders** and **pinned bookmarks** left or right to reorder
  them. Feature folders keep the service order.
- Drag a bookmark (a pinned one, or one from any drop-down) onto **one of your
  folders** to add it to that folder.
- Esc cancels a drag.

## Adding bookmarks

- The **☆** at the end of the address bar, or **Ctrl+D**, bookmarks the
  current location. If exactly one row is selected in the list, that item is
  remembered too. The star is filled when the location is already bookmarked.
- **Right-click** a list row or tree node and choose **Add bookmark…**, in any
  service. Containers (bucket, folder, queue, topic, table, database, cluster,
  service, function, log group) bookmark that place. Items (S3 file, parameter,
  secret, ECS task) bookmark their folder or list with the item selected.
- In **History** (Ctrl+H), select an entry and click **Bookmark…**. It
  bookmarks where the entry happened, for that entry's profile and region.

The **Add bookmark** dialog shows the location, the item, profile and region,
and has:

- **Name**: 1 to 100 characters, defaulting to the item or location name.
- **Description**: optional, up to 200 characters.
- **Pin to the bookmarks bar**.
- **Folders**: its service's folder always; tick any of yours, or **New
  folder…**.

There's one bookmark per profile, location and item. Adding it again opens the
same dialog to edit it, with **Delete**.

## Managing bookmarks

**Manage bookmarks** (**Ctrl+Shift+O**, or the end of any drop-down) shows
every bookmark for every profile.

- **Profile** filter: one profile or all. Profiles that are no longer in your
  AWS config are marked *(missing)*.
- Left: feature folders and your folders, with counts. Right: the selected
  folder's bookmarks.
- Bookmark buttons: **Open** (or double-click), **Edit…**, **Pin / Unpin**,
  **Move up / down** (your folders), **Remove from folder** (your folders: the
  bookmark stays elsewhere), **Delete** (from every folder).
- Folder buttons: **New folder…**, **Edit folder…** (name and description; for a
  feature folder, its description), **Delete folder** (your folders; its
  bookmarks stay in their feature folders and other folders), **Move up /
  down** (the order on the bar).

Limits: names 1 to 100 characters, descriptions up to 200, folder names 1 to 40
and unique (ignoring case), at most 100 folders and 5,000 bookmarks.

## Export and import

- **Export…** in the manager writes the folders you've ticked (their
  bookmarks, plus their folder structure), or everything when nothing is
  ticked. The **Profile** filter applies. The file is JSON.
- **Import…** reads such a file (or a copied `bookmarks.json`) and shows a
  preview with a status per bookmark:
  - **New**: added.
  - **Duplicate**: the same profile, location and item already exists, so it's
    skipped. Its folder memberships still merge.
  - **Profile not found**: added, and shown as missing in the manager until
    that profile exists.

  Choose **Keep the profiles in the file**, or **Put every bookmark on profile**
  to use, for example, a colleague's bookmarks with your own profile. Folders
  with the same name merge; others are added at the end. Pins carry over, and
  feature-folder descriptions are used only where you have none.

Exports and imports are recorded in History. Adding, editing and organising
bookmarks isn't, since it changes nothing in AWS.

## Storage

`bookmarks.json` in the app's settings folder (Windows:
`%APPDATA%\dev.example.s3explorer\`). It's written atomically, and every save is
checked in the app's backend. If the file can't be read, bookmarks stay
unavailable rather than being overwritten. Fix or move the file and restart.
Whether the bar is shown is saved in `settings.json` (`hideBookmarksBar`).

Bookmarks work in read-only mode: they're local and change nothing in AWS.

## For developers

- `src-tauri/src/bookmarks.rs`: the file, `normalise` (limits, unique folder
  names, one bookmark per profile + place + item, dangling ids dropped), export
  and read-for-import.
- `src/state/bookmarks.ts`: the in-memory store (`useBookmarks`), saved whole;
  a refused save is rolled back.
- `src/components/BookmarksBar.tsx` (bar, drop-downs, overflow, pointer-event
  dragging), `BookmarkDialog.tsx`, `BookmarkManager.tsx`,
  `BookmarkTransfer.tsx` (export subset, import plan and preview).
- Opening shares `openLocation` in `App.tsx` with History. The item is
  selected through `state/reveal.ts`, and the star learns the selected row
  from `state/selection.ts`, which the main view's `FileList` reports to.
- Services add **Add bookmark…** to their menus with `shell.addBookmark(place,
  select, label)`.
