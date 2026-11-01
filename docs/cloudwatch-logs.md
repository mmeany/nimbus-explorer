# CloudWatch Logs

Amazon CloudWatch Logs log groups, streams and events. Open **CloudWatch
Logs** in the tree under your profile. It uses the region chosen in the
toolbar's **Region** list. This view only reads logs: nothing in it changes
AWS, so it works the same in read-only mode.

The same log viewer appears in Lambda and ECS for their functions' and
containers' logs.

## Log groups

The list shows **Log group, Retention, Stored** (bytes stored), **Class**
(Standard or Infrequent access), **Metric filters** and **Created**, a page
at a time: choose 100, 500 or 1,000 per page and step with First / Previous /
Next. AWS hands out log groups page by page, so the pager says "Page 2 of
more" until you reach the last page. The tree shows the groups on the
current page.

Type the start of a group name in the **Filter** box (for example
`/aws/lambda/`) and press **Enter**; AWS does the filtering, so it covers
every group. Filters are remembered per profile and region (the last 10).

Open a group (Enter, double-click or click it in the tree). Its header shows
retention, stored bytes, class, encryption and **Copy ARN**, above two tabs:
**Events** and **Streams**.

## Events

Events are shown **newest first** for a time range: the last 5 minutes up to
the last 30 days, or a **Custom range…**. The first search returns up to
1,000 of the newest events in the range; **Load older** fetches the next
1,000 back in time. The bar under the list says how far back you've got.

- **Filter pattern**: CloudWatch Logs filter syntax, applied by AWS. A word
  (`ERROR`), a quoted phrase (`"timed out"`), several terms (`ERROR -health`),
  or a JSON test (`{ $.level = "error" }`). Press **Enter** or **Search**.
  Search also moves a "Last …" range up to now.
- **Follow**: checks for new events every 3 seconds and adds them at the
  top (works with the "Last …" ranges). Up to 20,000 events are kept; the
  oldest drop off.
- Click an event to see its full message below the list, with **Copy**.
  JSON messages get a collapsible tree.
- **Download…** saves every matching event in the range, oldest first, to a
  text file: one line per event, `time<TAB>stream<TAB>message` (no stream
  column for a single stream). Times are UTC.

## Streams

The **Streams** tab lists the group's streams with the **Last event**, **First
event** and **Created** times, most recent activity first (paged like the
groups). Type a stream name prefix and press **Enter** to filter (then
they're sorted by name; AWS can't combine the two).

Double-click a stream, or select several (up to 100) and press **Show
events**, to see only their events in the Events tab. **Show all streams**
goes back to the whole group.

## Keyboard shortcuts

| Keys | Action |
|---|---|
| Enter / double-click | Open log group / show a stream's events |
| F5 | Refresh |

## Permissions

The profile needs `logs:DescribeLogGroups`, `logs:DescribeLogStreams` and
`logs:FilterLogEvents` on the log groups you open.
