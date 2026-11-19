// A policy document (managed, inline or trust), the same viewer everywhere in
// IAM: a tree / text view of the JSON.
import { ValueView } from "../../components/ValueView";

export function PolicyDocument({ document }: { document: string | null }) {
  if (!document) return <p className="hint">No document returned.</p>;
  return <ValueView value={document} />;
}
