import type { ReactNode } from "react";
import { profileLabel, sortProfiles, type ConnectionInfo, type ProfileInfo, type ThemePref } from "../api/core";
import { HOME, placeCrumbs, type Place } from "../shell/places";
import { AWS_REGIONS } from "../shell/regions";
import { BackIcon, CopyIcon, ForwardIcon, GearIcon, LockIcon, RefreshIcon, UpIcon } from "./Icons";

interface Props {
  profiles: ProfileInfo[];
  profile: string | null;
  connection: ConnectionInfo | null;
  busy: boolean;
  theme: ThemePref;
  place: Place;
  canBack: boolean;
  canForward: boolean;
  canUp: boolean;
  /** Command-bar buttons from the active service. */
  commands: ReactNode;
  /** Copyable address of the current place ("" disables the button). */
  uri: string;
  onProfileChange: (name: string) => void;
  onThemeChange: (theme: ThemePref) => void;
  /** Region selected for the regional services; "__other" asks for a custom one. */
  onRegionChange: (region: string) => void;
  onToggleReadOnly: () => void;
  onConnectionSettings: () => void;
  onRefresh: () => void;
  onCopyLocation: () => void;
  onBack: () => void;
  onForward: () => void;
  onUp: () => void;
  onNavigate: (p: Place) => void;
}

export function Toolbar(p: Props) {
  return (
    <div className="toolbar">
      <div className="toolbar-row">
        <label className="field-label" htmlFor="profile">
          Profile:
        </label>
        <select
          id="profile"
          className="select profile-select"
          value={p.profile ?? ""}
          onChange={(e) => p.onProfileChange(e.target.value)}
          disabled={p.profiles.length === 0}
        >
          {p.profile === null && <option value="">(choose a profile)</option>}
          {sortProfiles(p.profiles).map((pr) => (
            <option key={pr.name} value={pr.name}>
              {profileLabel(pr)}
              {pr.endpointUrl ? `  (${pr.endpointUrl})` : ""}
            </option>
          ))}
        </select>
        <button
          className="tool-btn"
          title="Connection settings for this profile (endpoint, path-style)"
          onClick={p.onConnectionSettings}
          disabled={!p.profile}
        >
          <GearIcon />
        </button>
        <EndpointBadge connection={p.connection} />
        {p.connection && (
          <>
            <label className="field-label region-label" htmlFor="region">
              Region:
            </label>
            <select
              id="region"
              className="select region-select"
              value={p.connection.serviceRegion}
              onChange={(e) => p.onRegionChange(e.target.value)}
              title="Region for every service except S3, whose buckets always use their own region."
            >
              {!AWS_REGIONS.some(([c]) => c === p.connection!.serviceRegion) && (
                <option value={p.connection.serviceRegion}>{p.connection.serviceRegion}</option>
              )}
              {AWS_REGIONS.map(([code, name]) => (
                <option key={code} value={code}>
                  {code} · {name}
                </option>
              ))}
              <option value="__other">Other…</option>
            </select>
            <button
              className={`lock-btn ${p.connection.readOnly ? "locked" : ""}`}
              onClick={p.onToggleReadOnly}
              title={
                p.connection.readOnly
                  ? "Read-only: changes are disabled. Every connection starts read-only. Click to allow changes."
                  : "Changes allowed for this connection. Click to make it read-only."
              }
              aria-pressed={p.connection.readOnly}
            >
              <LockIcon open={!p.connection.readOnly} /> {p.connection.readOnly ? "Read-only" : "Read-write"}
            </button>
          </>
        )}
        <div className="spacer" />
        {p.busy && <span className="busy">Working…</span>}
        <label className="field-label" htmlFor="theme">
          Theme:
        </label>
        <select
          id="theme"
          className="select theme-select"
          value={p.theme}
          onChange={(e) => p.onThemeChange(e.target.value as ThemePref)}
          title="System follows your OS setting (dark if it can't be detected)"
        >
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </div>

      <div className="toolbar-row command-bar">{p.commands}</div>

      <div className="toolbar-row">
        <button className="tool-btn" title="Back (Alt+Left)" onClick={p.onBack} disabled={!p.canBack}>
          <BackIcon />
        </button>
        <button className="tool-btn" title="Forward (Alt+Right)" onClick={p.onForward} disabled={!p.canForward}>
          <ForwardIcon />
        </button>
        <button className="tool-btn" title="Up one level (Backspace)" onClick={p.onUp} disabled={!p.canUp}>
          <UpIcon />
        </button>
        <AddressBar place={p.place} onNavigate={p.onNavigate} />
        <button className="tool-btn" title={p.uri ? `Copy ${p.uri} to the clipboard` : "Copy this location to the clipboard"} onClick={p.onCopyLocation} disabled={!p.connection || !p.uri}>
          <CopyIcon />
        </button>
        <button className="tool-btn" title="Refresh (F5)" onClick={p.onRefresh} disabled={!p.connection}>
          <RefreshIcon />
        </button>
      </div>
    </div>
  );
}

function EndpointBadge({ connection }: { connection: ConnectionInfo | null }) {
  if (!connection) return null;
  if (connection.endpointUrl) {
    const src = connection.endpointSource === "override" ? "app setting" : "profile";
    return (
      <span
        className="badge badge-custom"
        title={`Custom endpoint from ${src} · region ${connection.region} · ${
          connection.pathStyle ? "path-style" : "virtual-hosted"
        } addressing`}
      >
        Custom endpoint → {connection.endpointUrl}
      </span>
    );
  }
  return (
    <span className="badge badge-aws" title={`Real AWS · profile region ${connection.region}`}>
      AWS
    </span>
  );
}

function AddressBar({ place, onNavigate }: { place: Place; onNavigate: (p: Place) => void }) {
  const crumbs = placeCrumbs(place);
  return (
    <div className="address-bar" role="navigation" aria-label="Address">
      <button className="crumb" onClick={() => onNavigate(HOME)}>
        AWS
      </button>
      {crumbs.map((c, i) => (
        <span key={i} className="crumb-wrap">
          <span className="crumb-sep">›</span>
          <button className="crumb" onClick={() => onNavigate(c.place)}>
            {c.label}
          </button>
        </span>
      ))}
    </div>
  );
}
