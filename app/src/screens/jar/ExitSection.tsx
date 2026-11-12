import type { JarStatus } from "@sats-jar/sdk";

/** The Bitcoin-only exit, in the SDK's own sentence (stories 53, 61, 62). */
export function ExitSection(props: { jar: JarStatus }) {
  return (
    <section className="panel">
      <h2>If Sats Jar's signing ever stops</h2>
      <p>{props.jar.exit.note}</p>
    </section>
  );
}
