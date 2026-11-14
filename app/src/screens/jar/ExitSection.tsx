import type { JarStatus } from "@sats-jar/sdk";
import { moment } from "./moments.ts";

/**
 * The Bitcoin-only exit (stories 53, 61, 62). Written here from the SDK's exit date rather than
 * shown as the SDK's `exit.note`, whose after-handover sentence names NEAR, which the app never does (#25).
 * Once the handover starts moving coins, the exit date is the child's new address's, whose exit
 * answers to the child's key, not the child's address.
 */
export function ExitSection(props: { jar: JarStatus }) {
  const { jar } = props;
  const opens = moment(jar, jar.exit.opensAt);
  return (
    <section className="panel">
      <h2>If Sats Jar's signing ever stops</h2>
      <p>{exitLine(jar.handover.state, opens)}</p>
    </section>
  );
}

function exitLine(state: JarStatus["handover"]["state"], opens: string): string {
  if (state === "done") {
    return `If the signing network behind Sats Jar ever stops, the Bitcoin-only exit opens on ${opens}, and only the holder's recovery phrase can use it.`;
  }
  if (state === "completing") {
    return `The jar's Bitcoin is moving to the child's own key. Once it's there, if Sats Jar's signing ever stops, the Bitcoin-only exit opens on ${opens}, and only the child's recovery phrase can use it.`;
  }
  return `If Sats Jar's signing ever stops before the handover is done, the Bitcoin-only exit opens on ${opens} and pays the child's address, which a parent controls.`;
}
