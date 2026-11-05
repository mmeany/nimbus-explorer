# History

Nimbus Explorer keeps a history of what you do, per profile, on your own
computer. Use it to answer "what did I change, and where?" and to go straight
back to that place.

Open it with the clock button in the toolbar (next to help) or **Ctrl+H**.

## What's recorded

- **Changes** made through the app, in every service: uploads, deletes,
  copies and moves, edits, settings, tags, policies, sends and publishes,
  purges, invokes, scaling, restores and so on. Failed attempts are recorded
  too, with the error (for example "Access denied").
- **Local writes**: downloads and exports (files, listings, log files, code,
  SQL results).
- **App events**: connecting to a profile, and allowing changes or locking
  read-only mode again.

Not recorded:

- Reads: browsing, previews, PartiQL `SELECT` statements, and SQL runs made
  read-only (they're always rolled back).
- Anything refused by the read-only lock (nothing was attempted).
- **Values, ever**: parameter and secret values, message bodies, item
  contents, environment variables, Lambda payloads, SQL and PartiQL text.
  Entries hold names, keys, ARNs, locations, counts and results only.
  DynamoDB item keys (`pk=…`) count as names and are recorded.

Each entry has the time, profile, region (for the regional services), service,
action, target, result and a short detail.

## Going back to where it happened

Double-click an entry, or select it and click **Go to location**:

1. If the entry belongs to another profile, the app asks before switching.
   The new connection starts read-only, as every connection does.
2. If the entry's region differs from the current one, the region switches.
3. The app opens the place: the S3 folder, Parameter Store or Secrets Manager
   folder, queue, topic, table, database, ECS service or task, task definition
   family, function or log group. The item is selected when it's on the visible
   page.

Nothing is run again. History has no replay or undo.

After a delete, the location is the folder or list the item was in. If a place
no longer exists, the view shows it empty or with its usual "not found"
message, and Up takes you to its parent.

## Filters

Choose a **profile** (any profile with history), a **service**, text to look
for (in action, target, detail and error), a **From** / **To** date range (your
local days) or **Failures only**. 200 entries load at a time; **Load older**
fetches the next 200.

## Files

History lives in `history\<profile>\` inside the app's settings folder
(Windows: `%APPDATA%\dev.example.s3explorer\history\`). **Open folder** opens it.

- Files are JSON Lines: one JSON object per line, only ever appended to. If
  the app stops mid-write, at most the last line is damaged, and it's skipped
  when reading (the dialog says how many lines it skipped).
- File names follow the period: `2026-11-05.jsonl` (day), `2026-W45.jsonl`
  (ISO week), `2026-11.jsonl` (month) or `2026.jsonl` (year), in UTC. When a
  file reaches the size limit, the next one in the same period is
  `2026-11.2.jsonl`, and so on.

### Settings

Click **Settings…** in the dialog:

| Setting | Default | Meaning |
|---|---|---|
| Record history | on | Off stops recording; existing files stay. |
| Start a new file | every month | Every day, week, month or year. Applies to new entries. |
| … and at | 10 MB | Also start a new file once the current one reaches this size (0 = no limit, at most 1,024). |
| Keep the newest | 24 files | Older files of each profile are deleted (0 = keep all). Applied when you save and whenever a new file starts. |

The settings are saved in `settings.json` with the rest of the app's settings.

## Export and clear

- **Export…** writes the entries matching the current filters, newest first,
  as CSV, or as JSON if the file name ends in `.json`.
- **Clear…** permanently deletes every history file of the selected profile,
  after you type the profile name. Other profiles are untouched.

## For developers

- `src-tauri/src/history.rs`: writing, rollover, retention, paging, export.
  Dates are worked out without a date crate.
- `src/history/rules.ts`: one rule per command, naming the action, target and
  location from the command's arguments. `src/history/recorder.ts` sees every
  `call` (`setCallObserver` in `api/core.ts`) and records commands that have a
  rule.
- Every command that calls `ensure_writable` must have a rule. The Rust test
  `every_write_command_has_a_history_rule` fails otherwise.
- "Go to location" selects the row through `state/reveal.ts`, which the first
  `FileList` showing a row with that key picks up.
