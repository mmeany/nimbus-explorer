// Small inline SVG icons in a classic-Explorer spirit. No icon library dependency.
type P = { size?: number };

export function BucketIcon({ size = 16 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <ellipse cx="8" cy="4" rx="6" ry="2" fill="#f5a623" stroke="#b36b00" strokeWidth="0.8" />
      <path d="M2 4 L3.4 13.2 Q8 15.4 12.6 13.2 L14 4 Q8 6.4 2 4 Z" fill="#ff9900" stroke="#b36b00" strokeWidth="0.8" />
    </svg>
  );
}

export function FolderIcon({ size = 16, open = false }: P & { open?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <path d="M1 3.5 h5 l1.5 1.5 H15 v8.5 H1 Z" fill="#e8b84a" stroke="#a87a12" strokeWidth="0.8" />
      {open ? (
        <path d="M2.5 7 H15.5 L14 13.5 H1 Z" fill="#f8d775" stroke="#a87a12" strokeWidth="0.8" />
      ) : (
        <path d="M1 6.5 H15 V13.5 H1 Z" fill="#f8d775" stroke="#a87a12" strokeWidth="0.8" />
      )}
    </svg>
  );
}

export function FileIcon({ size = 16 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <path d="M3 1 h7 l3 3 v11 H3 Z" fill="#fff" stroke="#7a8794" strokeWidth="0.8" />
      <path d="M10 1 v3 h3" fill="#e4e9ee" stroke="#7a8794" strokeWidth="0.8" />
    </svg>
  );
}

export function CloudIcon({ size = 16 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <path
        d="M4.5 13 a3 3 0 0 1 -0.4 -6 a4 4 0 0 1 7.6 -1 a3.5 3.5 0 0 1 0.3 7 Z"
        fill="#d6e9fb"
        stroke="#3d7ec4"
        strokeWidth="0.9"
      />
    </svg>
  );
}

export function ServerIcon({ size = 16 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <rect x="2" y="2" width="12" height="5" rx="1" fill="#e9eef3" stroke="#56636f" strokeWidth="0.8" />
      <rect x="2" y="9" width="12" height="5" rx="1" fill="#e9eef3" stroke="#56636f" strokeWidth="0.8" />
      <circle cx="11.5" cy="4.5" r="0.9" fill="#3aa655" />
      <circle cx="11.5" cy="11.5" r="0.9" fill="#3aa655" />
    </svg>
  );
}

const arrow = (d: string) =>
  function Arrow({ size = 16 }: P) {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
        <path d={d} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  };

export const BackIcon = arrow("M10 3 L5 8 L10 13");
export const ForwardIcon = arrow("M6 3 L11 8 L6 13");
export const UpIcon = arrow("M3 9 L8 4 L13 9 M8 4 V13");
export const UploadIcon = arrow("M8 12 V3 M4 7 L8 3 L12 7 M3 14 H13");
export const DownloadIcon = arrow("M8 3 V12 M4 8 L8 12 L12 8 M3 14 H13");
export const SyncIcon = arrow("M3 6 a5 5 0 0 1 9 -1.5 M12 2 V4.5 H9.5 M13 10 a5 5 0 0 1 -9 1.5 M4 14 V11.5 H6.5");
export const RefreshIcon = arrow("M13 8 a5 5 0 1 1 -1.5 -3.5 M13 2.5 V5 H10.5");

export function CopyIcon({ size = 16 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <rect x="5" y="5" width="9" height="9" rx="1" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M3 11 V3 a1 1 0 0 1 1 -1 H11" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

export function NewFolderIcon({ size = 16 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <path d="M1 3.5 h5 l1.5 1.5 H15 v8.5 H1 Z" fill="#f8d775" stroke="#a87a12" strokeWidth="0.8" />
      <path d="M8 7.5 v4 M6 9.5 h4" stroke="#7a5200" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function DeleteIcon({ size = 16 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <path d="M4 4 L12 12 M12 4 L4 12" stroke="#d13438" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function LockIcon({ size = 16, open = false }: P & { open?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <rect x="3" y="7" width="10" height="7.5" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d={open ? "M5.5 7 V4.8 a2.5 2.5 0 0 1 5 -0.6" : "M5.5 7 V4.8 a2.5 2.5 0 0 1 5 0 V7"} fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

export function KeyIcon({ size = 16 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <circle cx="5" cy="8" r="3" fill="none" stroke="#c98a00" strokeWidth="1.6" />
      <path d="M8 8 H14.5 M12 8 V10.5 M14 8 V10" stroke="#c98a00" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function SecretKeyIcon({ size = 16 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <rect x="2.5" y="7" width="11" height="7.5" rx="1.2" fill="#e7b416" stroke="#9a6d00" strokeWidth="0.9" />
      <path d="M5 7 V5 a3 3 0 0 1 6 0 V7" fill="none" stroke="#9a6d00" strokeWidth="1.3" />
      <circle cx="8" cy="10.6" r="1.1" fill="#6b4b00" />
    </svg>
  );
}

export function ParamStoreIcon({ size = 16 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <rect x="1.5" y="2" width="13" height="12" rx="1.5" fill="#d9e7f7" stroke="#3d6fa8" strokeWidth="0.9" />
      <path d="M4 5.5 H12 M4 8 H10 M4 10.5 H11" stroke="#3d6fa8" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

export function GearIcon({ size = 16 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <path
        d="M8 5.2 a2.8 2.8 0 1 0 0.01 0 Z M7 1 h2 l0.3 1.8 1.4 0.6 1.5 -1.1 1.4 1.4 -1.1 1.5 0.6 1.4 1.8 0.3 v2 l-1.8 0.3 -0.6 1.4 1.1 1.5 -1.4 1.4 -1.5 -1.1 -1.4 0.6 L9 15 H7 l-0.3 -1.8 -1.4 -0.6 -1.5 1.1 -1.4 -1.4 1.1 -1.5 -0.6 -1.4 L1 9 V7 l1.8 -0.3 0.6 -1.4 -1.1 -1.5 1.4 -1.4 1.5 1.1 1.4 -0.6 Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function NewItemIcon({ size = 16 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <path d="M8 2.5 V13.5 M2.5 8 H13.5" stroke="#2f8a3a" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  );
}

export function EditIcon({ size = 16 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <path d="M3 13 L3.6 10.4 L10.8 3.2 L12.8 5.2 L5.6 12.4 Z" fill="#f2c94c" stroke="#8a6a00" strokeWidth="0.9" strokeLinejoin="round" />
      <path d="M2.5 14 H13.5" stroke="currentColor" strokeWidth="0.9" />
    </svg>
  );
}

export function HistoryIcon({ size = 16 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <path d="M2.8 8 a5.2 5.2 0 1 0 1.6 -3.8" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M2.2 2.6 V5.4 H5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M8 5 V8.3 L10.3 9.6" fill="none" stroke="#3d6fa8" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function SqsIcon({ size = 16 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <rect x="1.5" y="3" width="13" height="10" rx="1.5" fill="#f6e3f3" stroke="#9b3d8f" strokeWidth="0.9" />
      <rect x="3.5" y="6" width="2.4" height="4" rx="0.5" fill="#9b3d8f" />
      <rect x="6.8" y="6" width="2.4" height="4" rx="0.5" fill="#b964ad" />
      <rect x="10.1" y="6" width="2.4" height="4" rx="0.5" fill="#d595cb" />
    </svg>
  );
}

export function QueueIcon({ size = 16, fifo = false, dlq = false }: P & { fifo?: boolean; dlq?: boolean }) {
  const c = dlq ? "#c0392b" : "#9b3d8f";
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <path d="M1.5 5 H11.5 V11 H1.5 Z" fill="none" stroke={c} strokeWidth="1.1" />
      <rect x="3" y="6.5" width="2" height="3" fill={c} />
      <rect x="6" y="6.5" width="2" height="3" fill={c} opacity="0.7" />
      <path d="M12.5 8 H15 M13.6 6.8 L15 8 L13.6 9.2" fill="none" stroke={c} strokeWidth="1.1" strokeLinecap="round" />
      {fifo && <circle cx="13" cy="3.5" r="2" fill="#3d6fa8" />}
    </svg>
  );
}

export function PurgeIcon({ size = 16 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <path d="M3.5 4.5 H12.5 L11.6 14 H4.4 Z" fill="none" stroke="#d13438" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M2.5 4.5 H13.5 M6 4.5 V2.5 H10 V4.5 M6.5 7 V11.5 M9.5 7 V11.5" stroke="#d13438" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

export function SendIcon({ size = 16 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <path d="M1.5 7.5 L14.5 2 L10 14 L7.5 9 Z" fill="none" stroke="#2f8a3a" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M7.5 9 L14.5 2" stroke="#2f8a3a" strokeWidth="1.1" />
    </svg>
  );
}

export function RedriveIcon({ size = 16 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <path d="M13 6 A5 5 0 0 0 3.5 4.5 M3 10 A5 5 0 0 0 12.5 11.5" fill="none" stroke="#9b3d8f" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M13.5 2.5 V6 H10 M2.5 13.5 V10 H6" fill="none" stroke="#9b3d8f" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function DynamoIcon({ size = 16 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <ellipse cx="8" cy="3.5" rx="5.5" ry="2" fill="#dbe6fb" stroke="#2e5aac" strokeWidth="0.9" />
      <path d="M2.5 3.5 V12.5 A5.5 2 0 0 0 13.5 12.5 V3.5" fill="#dbe6fb" stroke="#2e5aac" strokeWidth="0.9" />
      <path d="M2.5 6.5 A5.5 2 0 0 0 13.5 6.5 M2.5 9.5 A5.5 2 0 0 0 13.5 9.5" fill="none" stroke="#2e5aac" strokeWidth="0.8" />
    </svg>
  );
}

export function TableIcon({ size = 16 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1" fill="none" stroke="#2e5aac" strokeWidth="1" />
      <path d="M1.5 6 H14.5 M1.5 9.5 H14.5 M6 6 V13.5" stroke="#2e5aac" strokeWidth="0.9" />
      <rect x="1.5" y="2.5" width="13" height="3.5" fill="#2e5aac" opacity="0.35" />
    </svg>
  );
}

export function SecretsIcon({ size = 16 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <path d="M8 1.5 L13.5 3.5 V8 C13.5 11.2 11.2 13.4 8 14.5 C4.8 13.4 2.5 11.2 2.5 8 V3.5 Z" fill="#fbe3e3" stroke="#b03a2e" strokeWidth="0.9" />
      <rect x="5.6" y="7.3" width="4.8" height="3.6" rx="0.6" fill="#b03a2e" />
      <path d="M6.6 7.3 V6.3 a1.4 1.4 0 0 1 2.8 0 V7.3" fill="none" stroke="#b03a2e" strokeWidth="1" />
    </svg>
  );
}

export function SnsIcon({ size = 16 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <circle cx="4" cy="8" r="2.4" fill="#e7609e" />
      <path d="M6.4 8 H9 M9 8 L12.5 3.5 M9 8 H13 M9 8 L12.5 12.5" stroke="#b83a75" strokeWidth="1.2" strokeLinecap="round" fill="none" />
      <circle cx="13" cy="3.5" r="1.4" fill="#b83a75" />
      <circle cx="13.5" cy="8" r="1.4" fill="#b83a75" />
      <circle cx="13" cy="12.5" r="1.4" fill="#b83a75" />
    </svg>
  );
}

export function TopicIcon({ size = 16, fifo = false }: P & { fifo?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <path d="M2 6 H6 L11 2.5 V13.5 L6 10 H2 Z" fill="#fbe1ee" stroke="#b83a75" strokeWidth="1" strokeLinejoin="round" />
      <path d="M13 5.5 Q14.5 8 13 10.5" stroke="#b83a75" strokeWidth="1" fill="none" />
      {fifo && <circle cx="13.5" cy="3" r="2" fill="#3d6fa8" />}
    </svg>
  );
}

export function RdsIcon({ size = 16 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <ellipse cx="8" cy="3.6" rx="5.5" ry="2" fill="#5a8fe0" stroke="#2c5aa0" strokeWidth="0.8" />
      <path d="M2.5 3.6 V12.4 Q8 15.2 13.5 12.4 V3.6 Q8 6.4 2.5 3.6 Z" fill="#3b73c9" stroke="#2c5aa0" strokeWidth="0.8" />
      <path d="M2.5 7 Q8 9.6 13.5 7 M2.5 9.8 Q8 12.4 13.5 9.8" fill="none" stroke="#9cc0f2" strokeWidth="0.8" />
    </svg>
  );
}

/** ECS: stacked containers. */
export function EcsIcon({ size = 16 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <rect x="1.5" y="1.5" width="13" height="13" rx="2" fill="#e8772e" stroke="#b5561a" strokeWidth="0.8" />
      <rect x="4" y="4" width="3.4" height="3.4" fill="#fff" />
      <rect x="8.6" y="4" width="3.4" height="3.4" fill="#fff" opacity="0.8" />
      <rect x="4" y="8.6" width="3.4" height="3.4" fill="#fff" opacity="0.8" />
      <rect x="8.6" y="8.6" width="3.4" height="3.4" fill="#fff" />
    </svg>
  );
}

/** An ECS cluster. */
export function EcsClusterIcon({ size = 16 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="#c4651f" strokeWidth="1" />
      <rect x="3.5" y="5" width="4" height="3" fill="#e8772e" />
      <rect x="8.5" y="5" width="4" height="3" fill="#e8772e" />
      <rect x="3.5" y="9" width="4" height="2.5" fill="#f0a36a" />
    </svg>
  );
}

/** An ECS service. */
export function EcsServiceIcon({ size = 16 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <circle cx="8" cy="8" r="6" fill="#fbe3d1" stroke="#c4651f" strokeWidth="0.9" />
      <rect x="5.2" y="5.2" width="5.6" height="5.6" rx="0.8" fill="#e8772e" />
    </svg>
  );
}

/** An ECS task. */
export function EcsTaskIcon({ size = 16, stopped = false }: P & { stopped?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden opacity={stopped ? 0.5 : 1}>
      <rect x="3" y="3" width="10" height="10" rx="1.2" fill="#f7c9a6" stroke="#c4651f" strokeWidth="0.9" />
      <path d="M5.5 8 H10.5 M8 5.5 V10.5" stroke="#b5561a" strokeWidth="1.1" />
    </svg>
  );
}

/** Lambda: the λ mark. */
export function LambdaIcon({ size = 16 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <rect x="1.5" y="1.5" width="13" height="13" rx="2" fill="#f59a2f" stroke="#c46f12" strokeWidth="0.8" />
      <path d="M5 4 H7 L11.5 12.5 M8.3 7.8 L5.2 12.5" fill="none" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** One Lambda function. */
export function FunctionIcon({ size = 16, image = false }: P & { image?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <path d="M4.5 3 H6.5 L11.5 13 M7.8 7.6 L4.6 13" fill="none" stroke="#d9801c" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      {image && <rect x="10" y="1.5" width="4.5" height="4" rx="0.6" fill="#4a8bd6" />}
    </svg>
  );
}

/** CloudWatch Logs: a page of log lines. */
export function LogsIcon({ size = 16 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <path d="M3 1.5 H10 L13 4.5 V14.5 H3 Z" fill="#f3d9e8" stroke="#b0336f" strokeWidth="0.9" />
      <path d="M10 1.5 V4.5 H13" fill="none" stroke="#b0336f" strokeWidth="0.9" />
      <path d="M5 7 H11 M5 9 H11 M5 11 H9" stroke="#b0336f" strokeWidth="1" />
    </svg>
  );
}

/** One log group. */
export function LogGroupIcon({ size = 16 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <rect x="2" y="2.5" width="12" height="11" rx="1.2" fill="#fbeaf3" stroke="#b0336f" strokeWidth="0.9" />
      <path d="M4.5 5.5 H11.5 M4.5 8 H11.5 M4.5 10.5 H9" stroke="#c2477f" strokeWidth="1" />
    </svg>
  );
}

/** One log stream. */
export function LogStreamIcon({ size = 16 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <path d="M2 4 H14 M2 8 H11 M2 12 H13" stroke="#8a6aa8" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/** A DB instance; `stopped` greys it out. */
export function DbInstanceIcon({ size = 16, stopped = false }: P & { stopped?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden opacity={stopped ? 0.5 : 1}>
      <ellipse cx="8" cy="4" rx="4.8" ry="1.8" fill="#8db4ee" stroke="#2c5aa0" strokeWidth="0.8" />
      <path d="M3.2 4 V12 Q8 14.4 12.8 12 V4 Q8 6.4 3.2 4 Z" fill="#5a8fe0" stroke="#2c5aa0" strokeWidth="0.8" />
    </svg>
  );
}

/** An Aurora / Multi-AZ DB cluster: two stacked databases. */
export function DbClusterIcon({ size = 16 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <ellipse cx="10" cy="3.5" rx="3.6" ry="1.4" fill="#8db4ee" stroke="#2c5aa0" strokeWidth="0.7" />
      <path d="M6.4 3.5 V9 Q10 10.8 13.6 9 V3.5" fill="#5a8fe0" stroke="#2c5aa0" strokeWidth="0.7" />
      <ellipse cx="6" cy="7" rx="3.6" ry="1.4" fill="#a8c6f3" stroke="#2c5aa0" strokeWidth="0.7" />
      <path d="M2.4 7 V12.6 Q6 14.4 9.6 12.6 V7 Q6 8.8 2.4 7 Z" fill="#3b73c9" stroke="#2c5aa0" strokeWidth="0.7" />
    </svg>
  );
}

export function PlayIcon({ size = 16 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <path d="M4.5 3 L13 8 L4.5 13 Z" fill="#3fb950" stroke="#238636" strokeWidth="0.8" strokeLinejoin="round" />
    </svg>
  );
}

export function StopIcon({ size = 16 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <rect x="3.5" y="3.5" width="9" height="9" rx="1.2" fill="#d1453b" stroke="#a1281f" strokeWidth="0.8" />
    </svg>
  );
}
