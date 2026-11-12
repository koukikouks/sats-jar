import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { useSdk } from "../services.tsx";
import { POLL } from "../ui/poll.ts";
import { DemoBadge } from "../ui/DemoBadge.tsx";
import { roleLine, sats } from "../ui/format.ts";
import { Refusal } from "../ui/messages.tsx";
import { PinGate } from "../ui/PinGate.tsx";
import { TopUpBox } from "../ui/TopUpBox.tsx";
import { AllowanceSection } from "./jar/AllowanceSection.tsx";
import { EmergencySection } from "./jar/EmergencySection.tsx";
import { ExitSection } from "./jar/ExitSection.tsx";
import { HandoverSection } from "./jar/HandoverSection.tsx";
import { HolderSection } from "./jar/HolderSection.tsx";
import { TopUpsSection } from "./jar/TopUpsSection.tsx";

/** "/jar/:jarId": the family page (story 60), for anyone with a role in the jar. */
export function JarPage() {
  return (
    <PinGate>
      <FamilyPage />
    </PinGate>
  );
}

function FamilyPage() {
  const sdk = useSdk();
  const { jarId = "" } = useParams();
  const status = useQuery({ queryKey: ["jar", jarId], queryFn: () => sdk.jars.status(jarId), refetchInterval: POLL });
  const jar = status.data;
  if (jar === undefined) return <Refusal error={status.error} />;
  const proofLink = `/proof/${jarId}`;
  // Privacy, not security: the chain data behind this page is public (story 60).
  if (jar.roles.length === 0) {
    return (
      <section className="panel">
        <p>This page is for the jar's family.</p>
        <Link to={proofLink}>See the jar's public record</Link>
      </section>
    );
  }
  return (
    <>
      <section className="panel jar-head">
        <img className="picture" src={jar.picture} alt="" />
        <div>
          <h1>{jar.nickname}</h1>
          <DemoBadge demoTiming={jar.demoTiming} />
          <p>{sats(jar.balance)} in the jar</p>
          <p className="hint">{roleLine(jar.roles)}</p>
          <Link to={proofLink}>See the public record</Link>
        </div>
      </section>
      <TopUpBox address={jar.address} qrPayload={jar.qrPayload} />
      <TopUpsSection jarId={jarId} />
      <AllowanceSection jar={jar} />
      <EmergencySection jar={jar} />
      <HandoverSection jar={jar} />
      <HolderSection jar={jar} />
      <ExitSection jar={jar} />
    </>
  );
}
