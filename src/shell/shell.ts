import type { ReactNode } from "react";
import type { ConnectionInfo, TransferEvent } from "../api/s3";
import type { ConfirmButton } from "../components/ConfirmDialog";
import type { MenuItem } from "../components/ContextMenu";
import type { Place } from "./places";

/** What the app shell provides to every service. */
export interface Shell {
  connection: ConnectionInfo | null;
  /** Increments on every successful connect; services reset their state. */
  connectionId: number;
  profile: string | null;
  /** Read-only mode: services disable every write action. */
  readOnly: boolean;
  place: Place;
  navigate: (p: Place) => void;
  /** Modal question; resolves with the chosen button's value. */
  ask: (title: string, body: ReactNode, buttons: ConfirmButton<string>[], cancelValue: string) => Promise<string>;
  /** Single-line text prompt; resolves with the value or null if cancelled. */
  askName: (
    title: string,
    label: string,
    initial: string,
    okLabel: string,
    validate: (v: string) => string | null,
  ) => Promise<string | null>;
  /** Irreversible action: resolves true only if the user types `confirmText`. */
  confirmTyped: (title: string, body: ReactNode, confirmText: string, actionLabel: string) => Promise<boolean>;
  showError: (e: unknown) => void;
  /** Brief status-bar message. */
  showFlash: (msg: string) => void;
  /** Long-running status ("Deleting…"); null clears. */
  setWorking: (msg: string | null) => void;
  openMenu: (x: number, y: number, items: MenuItem[]) => void;
  copyText: (text: string) => Promise<void>;
  openTransfers: () => void;
}

/** What each service gives back to the shell to place on screen. */
export interface ServiceUi {
  /** The service's node (and children) for the folder tree. */
  tree: ReactNode;
  /** Main-panel content when the service is active. */
  content: ReactNode;
  /** Command-bar buttons when active. */
  commands: ReactNode;
  /** Status-bar text when active. */
  status: string;
  busy: boolean;
  refresh: () => void;
  /** Dialogs the service has open. */
  dialogs: ReactNode;
  /** Called for every finished transfer (to refresh affected views). */
  onTransferFinished?: (t: TransferEvent) => void;
}
