import type { JarStatus } from "@sats-jar/sdk";
import { day } from "../../ui/format.ts";

/**
 * The Bitcoin-only exit (stories 53, 61, 62). Written here from the SDK's exit date rather than
 * shown as the SDK's `exit.note`, whose after-handover sentence names NEAR, which the app never does (#25).
 */
export function ExitSection(props: { jar: JarStatus }) {
  const { jar } = props;
  const opens = day(jar.exit.opensAt);
  return (
    <section className="panel">
      <h2>If Sats Jar's signing ever stops</h2>
      <p>
        {jar.handover.state === "done"
          ? `If the signing network behind Sats Jar ever stops, the Bitcoin-only exit opens on ${opens}, and only the holder's recovery phrase can use it.`
          : `If no handover happens, the Bitcoin-only exit opens on ${opens} and pays the child's address, which a parent controls.`}
      </p>
    </section>
  );
}
