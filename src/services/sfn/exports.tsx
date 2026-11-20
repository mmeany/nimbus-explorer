// Export actions: executions (of a machine or map run) and an execution's
// event history, as JSON lines or CSV. Saving is a local write, so it works
// in read-only mode.
import { api } from "../../api/s3";
import { sfnApi, type ExportFormat } from "../../api/sfn";
import type { Shell } from "../../shell/shell";

/** File names can't hold ":" or "/" on Windows. */
const safe = (s: string) => s.replace(/[\\/:*?"<>|]+/g, "-");

async function chooseFormat(shell: Shell, title: string, what: string): Promise<ExportFormat | null> {
  const f = await shell.ask(
    title,
    <>
      <p>{what}</p>
      <p className="hint">JSON lines keeps every field as AWS returns it, one record per line. CSV gives the common fields as columns (opens in a spreadsheet).</p>
    </>,
    [
      { label: "JSON lines", value: "jsonl" },
      { label: "CSV", value: "csv" },
      { label: "Cancel", value: "" },
    ],
    "",
  );
  return f === "jsonl" || f === "csv" ? f : null;
}

/** `arn` is a machine or a map run; `status` the list's filter ("" for any). */
export async function exportExecutions(shell: Shell, arn: string, status: string, baseName: string) {
  const format = await chooseFormat(shell, "Export executions", status ? `Every ${status.toLowerCase().replace(/_/g, " ")} execution, newest first.` : "Every execution, newest first (not just the page on screen).");
  if (!format) return;
  const dest = await api.pickSaveAs("Export executions", `${safe(baseName)}-executions${status ? `-${status.toLowerCase()}` : ""}.${format}`);
  if (!dest) return;
  shell.setWorking("Exporting executions…");
  try {
    const n = await sfnApi.exportExecutions(arn, status || null, format, dest);
    shell.showFlash(`Exported ${n.toLocaleString()} execution${n === 1 ? "" : "s"} to ${dest}.`);
  } catch (e) {
    shell.showError(e);
  } finally {
    shell.setWorking(null);
  }
}

export async function exportHistory(shell: Shell, arn: string, baseName: string) {
  const format = await chooseFormat(shell, "Export event history", "Every event of this execution, oldest first.");
  if (!format) return;
  const dest = await api.pickSaveAs("Export event history", `${safe(baseName)}-history.${format}`);
  if (!dest) return;
  shell.setWorking("Exporting the event history…");
  try {
    const n = await sfnApi.exportHistory(arn, format, dest);
    shell.showFlash(`Exported ${n.toLocaleString()} event${n === 1 ? "" : "s"} to ${dest}.`);
  } catch (e) {
    shell.showError(e);
  } finally {
    shell.setWorking(null);
  }
}
