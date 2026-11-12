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
function movement(tx: BitcoinTransaction): string {
  if (tx.sent === 0) return `Received ${sats(tx.received)}`;
  return `Sent ${sats(tx.sent - tx.received - tx.fee)}, fee ${sats(tx.fee)}`;
}
