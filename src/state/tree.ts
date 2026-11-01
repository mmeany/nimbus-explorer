import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/s3";
import { ancestry, type Location } from "./navigation";

export interface TreeNode {
  /** Sub-folder prefixes; null until loaded. */
  folders: string[] | null;
  loading: boolean;
  /** False if the folder was too large to list fully for the tree. */
  complete: boolean;
  failed: boolean;
}

export const nodeKey = (bucket: string, prefix: string) => `${bucket}\u0000${prefix}`;

/**
 * Lazily loaded folder tree. Nodes are keyed by bucket + prefix. Children
 * load on first expand, or are filled in from the contents listing.
 */
export function useFolderTree(connectionId: number) {
  const [nodes, setNodes] = useState<Map<string, TreeNode>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const inFlight = useRef(new Set<string>());
  const generation = useRef(0);
  // Latest nodes for callbacks, so they stay stable across renders.
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  // New connection: forget everything.
  useEffect(() => {
    generation.current++;
    inFlight.current.clear();
    setNodes(new Map());
    setExpanded(new Set());
  }, [connectionId]);

  const patch = useCallback((key: string, node: TreeNode) => {
    setNodes((m) => new Map(m).set(key, node));
  }, []);

  const load = useCallback(
    async (bucket: string, prefix: string) => {
      const key = nodeKey(bucket, prefix);
      if (inFlight.current.has(key)) return;
      inFlight.current.add(key);
      const gen = generation.current;
      setNodes((m) => {
        const prev = m.get(key);
        return new Map(m).set(key, {
          folders: prev?.folders ?? null,
          loading: true,
          complete: prev?.complete ?? false,
          failed: false,
        });
      });
      try {
        const res = await api.listFolders(bucket, prefix);
        if (gen === generation.current) {
          patch(key, { folders: res.folders, loading: false, complete: res.complete, failed: false });
        }
      } catch {
        if (gen === generation.current) patch(key, { folders: [], loading: false, complete: true, failed: true });
      } finally {
        inFlight.current.delete(key);
      }
    },
    [patch],
  );

  /** Expand/collapse a node, loading its children on first expand. */
  const toggle = useCallback(
    (bucket: string, prefix: string) => {
      const key = nodeKey(bucket, prefix);
      setExpanded((s) => {
        const next = new Set(s);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
      if (!nodesRef.current.get(key)?.folders) void load(bucket, prefix);
    },
    [load],
  );

  /**
   * Explorer behaviour: navigating somewhere expands its ancestors (loading
   * any not yet known) and the node itself, whose children arrive from the
   * contents listing via setChildren().
   */
  const reveal = useCallback(
    (loc: Location) => {
      if (loc.bucket === null) return;
      const chain = ancestry(loc);
      setExpanded((s) => {
        const next = new Set(s);
        chain.forEach((l) => next.add(nodeKey(l.bucket!, l.prefix)));
        return next;
      });
      chain.slice(0, -1).forEach((l) => {
        if (!nodesRef.current.get(nodeKey(l.bucket!, l.prefix))?.folders) void load(l.bucket!, l.prefix);
      });
    },
    [load],
  );

  /** Fill a node's children from a completed contents listing. */
  const setChildren = useCallback(
    (bucket: string, prefix: string, folders: string[], ok: boolean) => {
      patch(nodeKey(bucket, prefix), { folders, loading: false, complete: true, failed: !ok });
    },
    [patch],
  );

  /** Load a node's children if they aren't known (folders too big for one page). */
  const ensure = useCallback(
    (bucket: string, prefix: string) => {
      if (!nodesRef.current.get(nodeKey(bucket, prefix))?.folders) void load(bucket, prefix);
    },
    [load],
  );

  /** Forget a node's children (refresh). Collapsed nodes reload on next expand. */
  const invalidate = useCallback((bucket: string, prefix: string) => {
    setNodes((m) => {
      const next = new Map(m);
      next.delete(nodeKey(bucket, prefix));
      return next;
    });
  }, []);

  return { nodes, expanded, toggle, reveal, setChildren, ensure, invalidate };
}

export type FolderTreeState = ReturnType<typeof useFolderTree>;
