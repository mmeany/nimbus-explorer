import { useEffect, useRef, useState } from "react";
import { api, toAppError, type AppError, type PreviewResult } from "../api/s3";
import { formatSize } from "../format";
import { baseName } from "../state/navigation";
import { BackIcon, DownloadIcon, ForwardIcon } from "./Icons";
import { TextPreview } from "./TextPreview";

interface Props {
  bucket: string;
  /** Files in the order shown in the list, for previous/next. */
  keys: string[];
  index: number;
  onIndexChange: (i: number) => void;
  onDownload: (key: string) => void;
  onClose: () => void;
}

/** Quick look at text, JSON and images, with ←/→ to step through the folder. */
export function PreviewDialog({ bucket, keys, index, onIndexChange, onDownload, onClose }: Props) {
  const key = keys[index];
  const cache = useRef(new Map<string, PreviewResult>());
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [actualSize, setActualSize] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => rootRef.current?.focus(), []);

  useEffect(() => {
    let stale = false;
    setError(null);
    setActualSize(false);
    const cached = cache.current.get(key);
    if (cached) {
      setResult(cached);
      return;
    }
    setResult(null);
    api
      .previewObject(bucket, key)
      .then((r) => {
        cache.current.set(key, r);
        if (!stale) setResult(r);
      })
      .catch((e) => !stale && setError(toAppError(e)));
    return () => {
      stale = true;
    };
  }, [bucket, key]);

  const go = (d: number) => {
    const i = index + d;
    if (i >= 0 && i < keys.length) onIndexChange(i);
  };

  let body: React.ReactNode;
  if (error) {
    body = <div className="pv-message error">{error.message}</div>;
  } else if (!result) {
    body = <div className="pv-message">Loading…</div>;
  } else {
    const p = result.preview;
    switch (p.kind) {
      case "text":
        body = (
          <TextPreview
            key={key}
            objectKey={key}
            text={p.text}
            truncated={p.truncated}
            size={result.size}
            contentType={result.contentType}
          />
        );
        break;
      case "image":
        body = (
          <div className={`pv-image ${actualSize ? "actual" : ""}`} onClick={() => setActualSize((v) => !v)}>
            <img src={p.dataUrl} alt={baseName(key)} title={actualSize ? "Click to fit" : "Click for actual size"} />
          </div>
        );
        break;
      case "tooLarge":
        body = (
          <div className="pv-message">
            This image is {formatSize(result.size)}; previews are limited to {formatSize(p.limit)}.
            <button className="btn primary" onClick={() => onDownload(key)}>
              Download
            </button>
          </div>
        );
        break;
      case "unsupported":
        body = (
          <div className="pv-message">
            No preview available for this type of file.
            <button className="btn primary" onClick={() => onDownload(key)}>
              Download
            </button>
          </div>
        );
        break;
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        ref={rootRef}
        tabIndex={-1}
        className="dialog preview-dialog"
        role="dialog"
        aria-modal
        aria-label={`Preview of ${baseName(key)}`}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          else if (e.key === "ArrowLeft") go(-1);
          else if (e.key === "ArrowRight") go(1);
        }}
      >
        <div className="dialog-title pv-title">
          <span className="pv-name" title={`s3://${bucket}/${key}`}>
            {baseName(key)}
          </span>
          {result && (
            <span className="pv-meta">
              {formatSize(result.size)}
              {result.contentType ? ` · ${result.contentType}` : ""}
            </span>
          )}
          <div className="spacer" />
          <span className="pv-meta">
            {index + 1} of {keys.length}
          </span>
          <button className="tool-btn" title="Previous (←)" disabled={index === 0} onClick={() => go(-1)}>
            <BackIcon />
          </button>
          <button className="tool-btn" title="Next (→)" disabled={index >= keys.length - 1} onClick={() => go(1)}>
            <ForwardIcon />
          </button>
        </div>
        <div className="pv-body">{body}</div>
        <div className="dialog-buttons">
          <div className="spacer" />
          <button className="btn" onClick={() => onDownload(key)}>
            <DownloadIcon size={14} /> Download…
          </button>
          <button className="btn primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
