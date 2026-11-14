import type { BitcoinTransaction, JarProof } from "@sats-jar/proof";
import { useQuery } from "@tanstack/react-query";
import { useProof } from "../../services.tsx";
import { sats, when } from "../../ui/format.ts";
import { Unreadable } from "./Unreadable.tsx";

/** The Bitcoin transactions at the jar's address, newest first (story 38). */
export function BitcoinTransactions(props: { jar: JarProof }) {
  const proof = useProof();
  const { jar } = props;
  const txs = useQuery({ queryKey: ["proof", "bitcoin", jar.jarId, jar.address], queryFn: () => proof.bitcoinTransactions(jar) });
  return (
    <section className="panel">
      <h2>Bitcoin transactions</h2>
      {txs.error && <Unreadable error={txs.error} />}
      <ul className="proof-list">
        {(txs.data ?? []).map((tx) => (
          <li key={tx.txid}>
            <strong>{movement(tx)}</strong>
            <span className="proof-meta">{tx.time === null ? "Not confirmed yet" : `Confirmed ${when(tx.time)}`}</span>
            <a className="proof-line proof-meta" href={tx.explorerUrl} target="_blank" rel="noreferrer">
              {tx.txid} ↗
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

// A spend's change comes back to the jar, so what left is what went in, less the change and the fee.
// A re-homing pays nothing out: all of it comes back to the jar's new address, less the fee.
function movement(tx: BitcoinTransaction): string {
  if (tx.sent === 0) return `Received ${sats(tx.received)}`;
  const out = tx.sent - tx.received - tx.fee;
  if (out === 0) return `Moved to the jar's new address, fee ${sats(tx.fee)}`;
  return `Sent ${sats(out)}, fee ${sats(tx.fee)}`;
}
