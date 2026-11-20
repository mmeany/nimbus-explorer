// A role ARN shown on a resource: opens the IAM role view when the role is in
// the resource's own account, plain text otherwise.
import { roleLinkName } from "../api/iam";
import { IAM_ROOT } from "../shell/places";
import type { Shell } from "../shell/shell";

export function RoleLink({ shell, arn, owner }: { shell: Shell; arn: string | null | undefined; owner: string | null | undefined }) {
  if (!arn) return null;
  const name = roleLinkName(arn, owner);
  if (!name) return <span className="mono selectable">{arn}</span>;
  return (
    <button className="link-btn mono" title="Open the role in IAM" onClick={() => shell.navigate({ ...IAM_ROOT, kind: "roles", id: name })}>
      {arn}
    </button>
  );
}
