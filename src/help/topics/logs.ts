export const logsTopics = {
  "logs.groups": {
    title: "Log groups",
    body: `The region's log groups, with retention, bytes stored, class, metric filters and creation date. AWS hands them out page by page, so the pager says "Page 2 of more" until you reach the last page. The tree shows the groups on the current page.

- **Filter**: type the start of a group name, such as \`/aws/lambda/\`, and press Enter. AWS does the filtering, so it covers every group.
- **Open** a group: Enter or double-click.

This view only reads logs, so it works the same in read-only mode.`,
  },
  "logs.events": {
    title: "Log events",
    body: `Events show **newest first** for a time range, from the last 5 minutes up to 30 days, or a **Custom range…**. The first search returns up to 1,000 of the newest. **Load older** fetches the next 1,000 back, and the bar under the list says how far back you've got.

### Filter pattern

Applied by AWS. Press Enter or **Search**. Search also moves a "Last …" range up to now.

| Pattern | Matches |
|---|---|
| \`ERROR\` | A word |
| \`"timed out"\` | A phrase |
| \`ERROR -health\` | Has ERROR, doesn't have health |
| \`{ $.level = "error" }\` | A JSON field |

### Other controls

- **Follow**: checks for new events every 3 seconds and adds them at the top. It works with "Last …" ranges, and keeps up to 20,000 events.
- **Click an event**: its full message shows below, with **Copy**. JSON gets a tree. Drag the bar above the message to resize it; double-click the bar to reset.
- **Download…**: saves every matching event in the range to a text file, oldest first, with times in UTC.
- **Show all streams**: appears when you've narrowed to certain streams, and goes back to the whole group.`,
  },
  "logs.streams": {
    title: "Log streams",
    body: `The group's streams, with last event, first event and creation times, most recent activity first.

- **Filter**: type a stream name prefix and press Enter. The list is then sorted by name, because AWS can't combine the two.
- **Double-click** a stream to see its events.
- **Select several** (up to 100) and press **Show events** to see only theirs in the Events tab.

**Show all streams** in the Events tab goes back to the whole group.`,
  },
};
