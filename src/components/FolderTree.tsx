import type { ReactNode } from "react";
import type { BucketInfo } from "../api/s3";
import { baseName, type Location } from "../state/navigation";
import { nodeKey, type FolderTreeState } from "../state/tree";
import { BucketIcon, FolderIcon } from "./Icons";
import { TreeNote, TreeRow } from "./TreeRow";

interface Props {
  /** Current S3 location, or null when another service is active. */
  location: Location | null;
  buckets: BucketInfo[] | null;
  bucketsFailed: boolean;
  tree: FolderTreeState;
  /** Whether the "Amazon S3" service node is expanded. */
  expanded: boolean;
  onToggleService: () => void;
  onNavigate: (loc: Location) => void;
  /** Right-click on a bucket or folder node. */
  onContextMenu?: (loc: Location, x: number, y: number) => void;
}

/** The S3 branch of the tree: service node, buckets, then lazily loaded folders. */
export function FolderTree({ location, buckets, bucketsFailed, tree, expanded, onToggleService, onNavigate, onContextMenu }: Props) {
  function renderFolder(bucket: string, prefix: string, label: string, icon: ReactNode, depth: number): ReactNode {
    const key = nodeKey(bucket, prefix);
    const node = tree.nodes.get(key);
    const isOpen = tree.expanded.has(key);
    const leaf = node?.folders != null && node.folders.length === 0 && !node.loading;
    return (
      <TreeRow
        key={key}
        depth={depth}
        label={label}
        icon={icon}
        selected={location?.bucket === bucket && location.prefix === prefix}
        expanded={leaf ? undefined : isOpen}
        title={`s3://${bucket}/${prefix}`}
        data={{ bucket, prefix }}
        onClick={() => onNavigate({ bucket, prefix })}
        onToggle={() => tree.toggle(bucket, prefix)}
        onContextMenu={(x, y) => onContextMenu?.({ bucket, prefix }, x, y)}
      >
        {node?.folders == null ? (
          <TreeNote depth={depth + 1}>Loading…</TreeNote>
        ) : (
          <>
            {node.folders.map((p) =>
              renderFolder(bucket, p, baseName(p), <FolderIcon open={tree.expanded.has(nodeKey(bucket, p))} />, depth + 1),
            )}
            {node.failed && <TreeNote depth={depth + 1}>Couldn't list folders</TreeNote>}
            {!node.complete && <TreeNote depth={depth + 1}>(more folders: open this folder to see all)</TreeNote>}
          </>
        )}
      </TreeRow>
    );
  }

  return (
    <TreeRow
      depth={1}
      label="Amazon S3"
      icon={<BucketIcon />}
      selected={location?.bucket === null}
      expanded={expanded}
      onClick={() => onNavigate({ bucket: null, prefix: "" })}
      onToggle={onToggleService}
    >
      {buckets === null ? (
        <TreeNote depth={2}>{bucketsFailed ? "Couldn't list buckets" : "Loading…"}</TreeNote>
      ) : buckets.length === 0 ? (
        <TreeNote depth={2}>No buckets</TreeNote>
      ) : (
        buckets.map((b) => renderFolder(b.name, "", b.name, <BucketIcon />, 2))
      )}
    </TreeRow>
  );
}
