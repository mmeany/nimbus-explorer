// A policy document (managed, inline or trust), the same viewer everywhere in
// IAM: a tree / text view of the JSON, with Access Analyzer validation.
import type { PolicyKind } from "../../api/iam";
import { ValueView } from "../../components/ValueView";
import { ValidateButton } from "./PolicyValidation";

export function PolicyDocument({ document, kind = "identity" }: { document: string | null; kind?: PolicyKind }) {
  if (!document) return <p className="hint">No document returned.</p>;
  return (
    <>
      <ValueView value={document} />
      <ValidateButton document={document} kind={kind} />
    </>
  );
}
