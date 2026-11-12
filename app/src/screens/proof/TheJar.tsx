import type { JarProof } from "@sats-jar/proof";
import { contractExplorerUrl } from "../../config.ts";
import { day, period, sats } from "../../ui/format.ts";

/** The jar's picture and settings as the contract reads them (story 38). */
export function TheJar(props: { jar: JarProof }) {
  const { jar } = props;
  return (
    <section className="panel">
      <h2>The jar</h2>
      <img className="picture" src={jar.nft.media} alt={`Picture of ${jar.nickname}`} />
      <ul className="plain">
        <li>Balance: {sats(jar.provenBalance)}</li>
        <li>
          <a className="proof-line" href={jar.addressExplorerUrl} target="_blank" rel="noreferrer">
            Bitcoin address: {jar.address} ↗
          </a>
        </li>
        <li className="proof-line">Child's address: {jar.childAddress}</li>
        <li>
          Allowance: up to {sats(jar.cap)} every {period(jar.period)}
        </li>
        <li>Unlocks: {day(jar.unlockAt)}</li>
        <li>Guardians: {jar.guardians.length}</li>
        <li>Held by: {jar.holder === jar.familyAccount ? "the family account" : "its holder since handover"}</li>
        <li>
          <a href={contractExplorerUrl} target="_blank" rel="noreferrer">
            The jar contract ↗
          </a>
        </li>
      </ul>
    </section>
  );
}
