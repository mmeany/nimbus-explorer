export const bookmarksTopics = {
  bookmarks: {
    title: "Bookmarks",
    body: `The bookmarks bar sits under the address bar. Show or hide it with **Ctrl+Shift+B**.

### What's on the bar

- **Pinned bookmarks** come first, as one-click buttons.
- **Feature folders**, one per service that has bookmarks (S3, Parameter Store, …). Every bookmark is always in its service's folder, sorted by name.
- **Your folders** come last, in the order you set. A folder can hold bookmarks from any service.

Only the **current profile's** bookmarks show. One of your folders with nothing for this profile stays on the bar, dimmed. When the window is too narrow, what doesn't fit moves into the **»** menu.

A folder's description is its tooltip and the first line of its drop-down. Drop-downs with more than 15 bookmarks get a filter box.

### Adding a bookmark

- Click the **☆** at the end of the address bar, or press **Ctrl+D**. It bookmarks the current location and, if exactly one row is selected, that item too. The star is filled when the location is already bookmarked, and opens it for editing.
- Right-click a row or tree node and choose **Add bookmark**. Folders, buckets, queues, tables and so on bookmark that place; files, parameters, secrets and similar items bookmark their folder with the item selected.
- In **History** (Ctrl+H), select an entry and click **Bookmark**.

### Opening a bookmark

Click it. The app goes there and selects the item when it's on the page. A bookmark from another region switches the region and says so in the status bar (the drop-down shows a region tag). S3 and IAM bookmarks have no region.

### Arranging the bar

Drag your folders and pinned bookmarks left or right along the bar to reorder them. Drag a bookmark, from the bar or a drop-down, onto one of your folders to add it to that folder. Feature folders keep the service order.

Everything else, including bookmarks of other profiles, is in **Manage bookmarks** (**Ctrl+Shift+O**, or the last entry of every drop-down).

Bookmarks are stored on this computer and work in read-only mode.`,
  },
  "bookmarks.edit": {
    title: "Add or edit a bookmark",
    body: `- **Location**, **Selects**, **Profile** and **Region** show what the bookmark opens. They're fixed. Bookmark the place again from another profile to have it there too.
- **Name**: 1 to 100 characters. It defaults to the item or location name.
- **Description**: optional, up to 200 characters. Shown under the name in drop-downs and as the tooltip.
- **Pin to the bookmarks bar**: also show it as a button at the left of the bar.
- **Folders**: the bookmark is always in its service's folder. Tick any of your own folders too, or click **New folder…**.

There's one bookmark per profile, location and item: adding the same one again opens it here. **Delete** removes the bookmark from every folder.`,
  },
  "bookmarks.manager": {
    title: "Manage bookmarks",
    body: `Every bookmark, for every profile. Pick a folder on the left to see its bookmarks on the right.

### Filter

**Profile** shows one profile's bookmarks or all of them. Profiles that are no longer in your AWS config are marked *(missing)*.

### Bookmarks

- **Open** (or double-click) goes there. For another profile, the app asks before switching, and the new connection starts read-only.
- **Edit…** changes the name, description, pin and folders.
- **Pin / Unpin** puts it on the bar or takes it off.
- **Move up / Move down** reorder it in one of your folders. Feature folders are sorted by name.
- **Remove from folder** (your folders only) keeps the bookmark everywhere else.
- **Delete** removes the bookmark from every folder.

### Folders

- **New folder…**, **Edit folder…** (name and description; for a feature folder, its description), **Delete folder** (your folders; the bookmarks stay), and **Move up / Move down** for your folders' order on the bar.
- Folder names are 1 to 40 characters and unique. Up to 100 folders and 5,000 bookmarks.

### Export and import

Tick folders in the list and click **Export…**, or export everything when nothing is ticked. The **Profile** filter applies. **Import…** shows a preview first; see its help.`,
  },
  "bookmarks.import": {
    title: "Import bookmarks",
    body: `The preview lists every bookmark in the file:

- **New**: it will be added.
- **Duplicate**: the same profile, location and item is already bookmarked, so it's skipped. Its folders are still merged.
- **Profile not found**: the profile isn't in your AWS config. It's imported anyway and shows as missing in the manager until you have that profile.

**Profiles**: keep the profiles stored in the file, or put every bookmark on one of your profiles, for example to use a colleague's bookmarks with your own profile name.

Folders with the same name (ignoring case) are merged; other folders are added at the end. Pinned bookmarks stay pinned, and feature-folder descriptions are taken only where you have none. The import is recorded in History.`,
  },
};
