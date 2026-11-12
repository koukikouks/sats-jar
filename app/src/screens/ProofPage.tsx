// "/proof/:jarId": the jar's public record, readable with no device set up (stories 38-40).
import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router";
import { useProof } from "../services.tsx";
import { DemoBadge } from "../ui/DemoBadge.tsx";
import { TopUpBox } from "../ui/TopUpBox.tsx";
import { BitcoinTransactions } from "./proof/BitcoinTransactions.tsx";
import "./proof/proof.css";
import { Requests } from "./proof/Requests.tsx";
import { TheJar } from "./proof/TheJar.tsx";
import { TryIt } from "./proof/TryIt.tsx";
import { Unreadable } from "./proof/Unreadable.tsx";

export function ProofPage() {
  const { jarId = "" } = useParams();
  const proof = useProof();
  const jar = useQuery({ queryKey: ["proof", "jar", jarId], queryFn: () => proof.jar(jarId) });
  if (jar.error) return <Unreadable error={jar.error} />;
  if (jar.data === undefined) return null;
  return (
    <>
      <section className="panel">
        <h1>{jar.data.nickname}: public record</h1>
        <DemoBadge demoTiming={jar.data.demoTiming} />
        <p>Everything here is read from the public NEAR and Bitcoin chains. Check any line on an explorer.</p>
      </section>
      <TheJar jar={jar.data} />
      <TopUpBox address={jar.data.address} qrPayload={`bitcoin:${jar.data.address}`} />
      <Requests jar={jar.data} />
      <BitcoinTransactions jar={jar.data} />
      <TryIt jar={jar.data} />
    </>
  );
}
