// About: what the app is, its version, where to report bugs and ask for features.
import { useEffect, useRef, useState } from "react";
import { api } from "../api/s3";

interface Props {
  onClose: () => void;
  onError: (e: unknown) => void;
}

type Info = { name: string; version: string; projectUrl: string };

export function AboutDialog({ onClose, onError }: Props) {
  const [info, setInfo] = useState<Info | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => closeRef.current?.focus(), []);
  useEffect(() => {
    api.aboutInfo().then(setInfo, onError);
    // Once, when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const open = () => api.openProjectPage().catch(onError);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="dialog about-dialog"
        role="dialog"
        aria-modal
        aria-labelledby="about-title"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
      >
        <div className="dialog-title" id="about-title">
          About {info?.name ?? "Nimbus Explorer"}
        </div>
        <div className="dialog-body about-body">
          <div className="about-name">
            {info?.name ?? "Nimbus Explorer"}
            {info && <span className="about-version">version {info.version}</span>}
          </div>
          <p>
            An Explorer-style desktop app for browsing and managing cloud resources that works with Amazon Web Services: S3, Parameter Store, SQS, SNS, DynamoDB,
            RDS, ECS, Lambda, CloudWatch Logs and Secrets Manager. It also works with emulators such as LocalStack, MinIO and moto.
          </p>
          <p>
            It signs in with your existing AWS profiles, keeps no credentials of its own, and starts every connection read-only so nothing changes until you
            allow it.
          </p>
          <p>
            Source code, releases and the issue tracker are on GitHub. Please report bugs and request features there:
            <br />
            <button className="link-btn about-link" title="Open in your browser" onClick={() => void open()}>
              {info?.projectUrl ?? "github.com/mmeany/nimbus-explorer"}
            </button>
          </p>
          <p className="about-credit">Lovingly created by Claude Code under the direction of Mark Meany.</p>
          <p className="hint">
            Open source under the MIT licence. Not affiliated with or endorsed by Amazon Web Services.
          </p>
        </div>
        <div className="dialog-buttons">
          <div className="spacer" />
          <button ref={closeRef} className="btn primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
