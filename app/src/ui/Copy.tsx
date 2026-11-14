import { useState } from "react";

/** A button that copies a link, address or code. */
export function Copy(props: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => navigator.clipboard.writeText(props.text).then(() => setCopied(true));
  return (
    <button type="button" className="secondary" onClick={copy}>
      {copied ? "Copied" : props.label}
    </button>
  );
}
