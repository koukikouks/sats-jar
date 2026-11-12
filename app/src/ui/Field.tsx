import { cloneElement, useId, type ReactElement } from "react";

/** A labelled input with an optional hint the input points to, so screen readers read both. */
export function Field(props: { label: string; hint?: string | undefined; children: ReactElement<{ id?: string; "aria-describedby"?: string }> }) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="field">
      <label htmlFor={id}>{props.label}</label>
      {cloneElement(props.children, { id, "aria-describedby": props.hint ? hintId : undefined })}
      {props.hint && (
        <span id={hintId} className="hint">
          {props.hint}
        </span>
      )}
    </div>
  );
}
