import { useEffect, useMemo, useState } from "react";
import { api, toAppError } from "../api/s3";
import { formatSize } from "../format";
import { Markdown } from "../viewers/markdown";
import { CsvView } from "./CsvView";
import { DataTree } from "./DataTree";

type Viewer = "markdown" | "csv" | "json" | "jsonl" | "yaml" | "text";
type Mode = "rendered" | "source" | "table" | "tree" | "formatted" | "raw" | "text";

const MODES: Record<Viewer, [Mode, string][]> = {
  markdown: [
    ["rendered", "Rendered"],
    ["source", "Source"],
  ],
  csv: [
    ["table", "Table"],
    ["tree", "Tree"],
    ["text", "Text"],
  ],
  json: [
    ["tree", "Tree"],
    ["formatted", "Formatted"],
    ["raw", "Raw"],
  ],
  jsonl: [
    ["tree", "Tree"],
    ["raw", "Raw"],
  ],
  yaml: [
    ["tree", "Tree"],
    ["text", "Text"],
  ],
  text: [],
};

/** Modes that need the whole file (a parse of a partial file would be wrong). */
const NEEDS_WHOLE: Mode[] = ["tree", "formatted", "rendered"];

function viewerFor(key: string, contentType: string | null): Viewer {
  const ext = key.toLowerCase().split(".").pop() ?? "";
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "csv" || ext === "tsv") return "csv";
  if (ext === "jsonl" || ext === "ndjson") return "jsonl";
  if (ext === "json" || ext === "geojson") return "json";
  if (ext === "yml" || ext === "yaml") return "yaml";
  const ct = contentType ?? "";
  if (ct.includes("markdown")) return "markdown";
  if (ct.includes("csv")) return "csv";
  if (ct.includes("json")) return "json";
  if (ct.includes("yaml")) return "yaml";
  return "text";
}

const MODE_KEY = (v: Viewer) => `s3x.previewMode.${v}`;
function loadMode(v: Viewer): Mode | null {
  try {
    return localStorage.getItem(MODE_KEY(v)) as Mode | null;
  } catch {
    return null;
  }
}
function saveMode(v: Viewer, m: Mode) {
  try {
    localStorage.setItem(MODE_KEY(v), m);
  } catch {
    /* not remembered */
  }
}

interface Props {
  objectKey: string;
  text: string;
  truncated: boolean;
  size: number;
  contentType: string | null;
}

type Parsed = { ok: true; value: unknown; docs?: number } | { ok: false; error: string } | null;

/** Text-based previews with per-type views (rendered Markdown, CSV table, data trees). */
export function TextPreview({ objectKey, text, truncated, size, contentType }: Props) {
  const viewer = viewerFor(objectKey, contentType);
  const modes = MODES[viewer];
  const available = (m: Mode) => !(truncated && NEEDS_WHOLE.includes(m));
  const initial = (() => {
    const saved = loadMode(viewer);
    const pick = modes.find(([m]) => m === saved && available(m)) ?? modes.find(([m]) => available(m));
    return pick?.[0] ?? "text";
  })();
  const [mode, setMode] = useState<Mode>(initial);
  const [wrap, setWrap] = useState(false);
  const [parsed, setParsed] = useState<Parsed>(null);

  // Parse structured data when a mode needs it.
  useEffect(() => {
    setParsed(null);
    if (truncated || !(mode === "tree" || mode === "formatted") || viewer === "csv") return;
    let stale = false;
    if (viewer === "json") {
      try {
        setParsed({ ok: true, value: JSON.parse(text) });
      } catch (e) {
        setParsed({ ok: false, error: `Not valid JSON: ${(e as Error).message}` });
      }
    } else if (viewer === "jsonl") {
      const out: unknown[] = [];
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        try {
          out.push(JSON.parse(lines[i]));
        } catch (e) {
          setParsed({ ok: false, error: `Line ${i + 1} is not valid JSON: ${(e as Error).message}` });
          return;
        }
      }
      setParsed({ ok: true, value: out });
    } else if (viewer === "yaml") {
      api
        .parseYaml(text)
        .then((docs) => {
          if (stale) return;
          setParsed({ ok: true, value: docs.length === 1 ? docs[0] : docs, docs: docs.length });
        })
        .catch((e) => !stale && setParsed({ ok: false, error: `Not valid YAML: ${toAppError(e).message}` }));
    }
    return () => {
      stale = true;
    };
  }, [mode, viewer, text, truncated]);

  const formatted = useMemo(
    () => (mode === "formatted" && parsed?.ok ? JSON.stringify(parsed.value, null, 2) : null),
    [mode, parsed],
  );

  const choose = (m: Mode) => {
    setMode(m);
    saveMode(viewer, m);
  };

  const isTextMode = mode === "text" || mode === "raw" || mode === "source" || mode === "formatted";
  let content: React.ReactNode;
  if (mode === "rendered") {
    content = (
      <div className="pv-scroll">
        <Markdown text={text} />
      </div>
    );
  } else if (viewer === "csv" && (mode === "table" || mode === "tree")) {
    content = <CsvView text={text} fileName={objectKey} mode={mode} truncated={truncated} />;
  } else if (mode === "tree" || mode === "formatted") {
    if (parsed === null) content = <div className="pv-message">Parsing…</div>;
    else if (!parsed.ok)
      content = (
        <div className="pv-message error">
          {parsed.error}
          <button className="btn" onClick={() => choose(viewer === "yaml" ? "text" : "raw")}>
            Show as text
          </button>
        </div>
      );
    else if (mode === "tree")
      content = (
        <DataTree
          value={parsed.value}
          rootName={parsed.docs && parsed.docs > 1 ? `${parsed.docs} documents` : viewer === "jsonl" ? "lines" : "root"}
          rootItemLabel={parsed.docs && parsed.docs > 1 ? (i) => `Document ${i + 1}` : viewer === "jsonl" ? (i) => `Line ${i + 1}` : undefined}
        />
      );
    else content = <pre className={`pv-text ${wrap ? "wrap" : ""}`}>{formatted}</pre>;
  } else {
    content = <pre className={`pv-text ${wrap ? "wrap" : ""}`}>{text}</pre>;
  }

  return (
    <>
      {truncated && (
        <div className="pv-banner">
          Showing the first 512 KB of {formatSize(size)}. Download the file to see all of it
          {modes.some(([m]) => NEEDS_WHOLE.includes(m)) ? "; tree, formatted and rendered views need the whole file." : "."}
        </div>
      )}
      {(modes.length > 0 || isTextMode) && (
        <div className="pv-modes">
          {modes.length > 0 && (
            <div className="segmented" role="tablist">
              {modes.map(([m, label]) => (
                <button
                  key={m}
                  role="tab"
                  aria-selected={mode === m}
                  className={mode === m ? "active" : ""}
                  disabled={!available(m)}
                  onClick={() => choose(m)}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          <div className="spacer" />
          {isTextMode && (
            <label className="check">
              <input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} /> Wrap lines
            </label>
          )}
        </div>
      )}
      {content}
    </>
  );
}
