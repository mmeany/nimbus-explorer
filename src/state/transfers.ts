import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type TransferEvent } from "../api/s3";

export const isActive = (t: TransferEvent) => t.state === "queued" || t.state === "running";

export interface TransferSummary {
  active: number;
  uploads: number;
  downloads: number;
  /** Copies and moves. */
  copies: number;
  failed: number;
  /** 0–1 across active transfers with known sizes, or null if unknown. */
  fraction: number | null;
}

/**
 * Tracks transfers from backend progress events. `onFinished` is called for
 * every transfer that completes successfully.
 */
export function useTransfers(onFinished: (t: TransferEvent) => void) {
  const [map, setMap] = useState<Map<number, TransferEvent>>(new Map());
  const finishedRef = useRef(onFinished);
  finishedRef.current = onFinished;

  useEffect(
    () =>
      api.onTransfer((ev) => {
        setMap((m) => new Map(m).set(ev.id, ev));
        if (ev.state === "done") finishedRef.current(ev);
      }),
    [],
  );

  // Newest first.
  const list = useMemo(() => [...map.values()].sort((a, b) => b.id - a.id), [map]);

  const summary: TransferSummary = useMemo(() => {
    const active = list.filter(isActive);
    const known = active.filter((t) => t.bytesTotal > 0);
    const total = known.reduce((n, t) => n + t.bytesTotal, 0);
    const done = known.reduce((n, t) => n + Math.min(t.bytesDone, t.bytesTotal), 0);
    return {
      active: active.length,
      uploads: active.filter((t) => t.direction === "upload").length,
      downloads: active.filter((t) => t.direction === "download").length,
      copies: active.filter((t) => t.direction === "copy" || t.direction === "move").length,
      failed: list.filter((t) => t.state === "failed").length,
      fraction: total > 0 ? done / total : null,
    };
  }, [list]);

  const clearFinished = useCallback(() => {
    setMap((m) => new Map([...m].filter(([, t]) => isActive(t))));
  }, []);

  return { list, summary, clearFinished };
}
