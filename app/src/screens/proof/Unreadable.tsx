import { JarNotFoundError, ProofUnavailableError } from "@sats-jar/proof";

/** Why part of the public record could not be read: the proof reader's own sentence, never a raw error. */
export function Unreadable(props: { error: Error }) {
  const { error } = props;
  return (
    <p className="refusal" role="alert">
      {error instanceof JarNotFoundError
        ? "There is no such jar."
        : error instanceof ProofUnavailableError
          ? error.message
          : "That didn't work just now. Try again."}
    </p>
  );
}
