import type { JarStatus } from "@sats-jar/sdk";
import { Copy } from "../../ui/Copy.tsx";
import { day, when } from "../../ui/format.ts";

/** The handover as it stands (stories 41–54). The claimed and later states come with the child's screens. */
export function HandoverSection(props: { jar: JarStatus }) {
  const { jar } = props;
  if (jar.handover.state !== "none") return null;
  const familyAdult = jar.roles.includes("giver") || jar.roles.includes("guardian");
  const link = `${window.location.origin}/jar/${jar.jarId}/set-up`;
  return (
    <section className="panel">
      <h2>Handover</h2>
      <p>The jar unlocks on {jar.demoTiming ? when(jar.unlockAt) : day(jar.unlockAt)}. From then on, the child can take it over.</p>
      {familyAdult && (
        <>
          <p>When it's time, send the child this link to open on their own phone:</p>
          <p className="mono">{link}</p>
          <Copy text={link} label="Copy link" />
        </>
      )}
    </section>
  );
}
