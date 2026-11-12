import { SatsJarRefusal } from "@sats-jar/sdk";

/** What a person reads when something they asked for did not happen: the SDK's own sentence. */
export function refusalText(error: unknown): string {
  return error instanceof SatsJarRefusal ? error.message : "We could not reach the network just now. Try again shortly.";
}

export function Refusal(props: { error: unknown }) {
  if (props.error === null || props.error === undefined) return null;
  return (
    <p className="refusal" role="alert">
      {refusalText(props.error)}
    </p>
  );
}

/** The link after a request that returned a transaction (stories 6, 71). */
export function CheckIt(props: { url: string | null | undefined }) {
  if (!props.url) return null;
  return (
    <a className="check-it" href={props.url} target="_blank" rel="noreferrer">
      Check it yourself ↗
    </a>
  );
}
