import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { useSdk } from "../services.tsx";
import { POLL } from "../ui/poll.ts";
import { DemoBadge } from "../ui/DemoBadge.tsx";
import { JarPicture } from "../ui/JarPicture.tsx";
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
  if (jar.roles.length === 0) return <NotFamily jarId={jarId} mayHaveClaimed={jar.handover.state === "none"} />;
  const beneficiary = jar.roles.includes("child");
  return (
    <>
      <section className="panel jar-head">
        <figure className="jar-figure">
          <JarPicture
            className="jar-picture"
            nickname={jar.nickname}
            balance={jar.balance}
            cap={jar.cap}
            unlockAt={jar.unlockAt}
            nextAllowanceAt={jar.nextAllowanceAt}
            demoTiming={jar.demoTiming}
          />
          <figcaption className="hint">
            NEAR wallets and explorers show the jar's on-chain picture, which the contract draws and can't change.
          </figcaption>
        </figure>
        <div>
          <h1>{jar.nickname}</h1>
          <DemoBadge demoTiming={jar.demoTiming} />
          <p>{sats(jar.balance)} in the jar</p>
          <p className="hint">{roleLine(jar.roles)}</p>
          <Link to={proofLink}>See the public record</Link>
        </div>
      </section>
      {/* The beneficiary came for the handover, so it comes first for them (story 21). */}
      {beneficiary && <HandoverSection jar={jar} />}
      <TopUpBox address={jar.address} qrPayload={jar.qrPayload} journeyStep={jar.roles.includes("giver")} />
      <TopUpsSection jarId={jarId} />
      <AllowanceSection jar={jar} />
      {!beneficiary && <HandoverSection jar={jar} />}
      <HolderSection jar={jar} />
      {/* Off the happy path, so folded away; open while an emergency payment is live, so a guardian asked to approve sees it (story 22). */}
      <details className="more" open={jar.emergency.state === "open"}>
        <summary>More: emergency payment and the Bitcoin-only exit</summary>
        <EmergencySection jar={jar} />
        <ExitSection jar={jar} />
      </details>
    </>
  );
}

/**
 * A device with no role in the jar. A phone set up with a recovery phrase (it has a handover code)
 * looking at a jar with no claim may be a beneficiary whose claim lapsed or was cancelled; the app can't
 * tell whether it claimed this jar, so the sentence holds either way (story 29, finding 1).
 */
function NotFamily(props: { jarId: string; mayHaveClaimed: boolean }) {
  const sdk = useSdk();
  const code = useQuery({ queryKey: ["guardianCode"], queryFn: () => sdk.child.guardianCode(), enabled: props.mayHaveClaimed });
  const proofLink = `/proof/${props.jarId}`;
  if (props.mayHaveClaimed && code.isPending) return null;
  return (
    <section className="panel">
      {props.mayHaveClaimed && code.data !== undefined ? (
        <>
          <p>If you claimed this jar, your claim has lapsed or was cancelled. You can claim it again.</p>
          <Link className="button" to={`/jar/${props.jarId}/set-up`}>
            Claim it again
          </Link>
        </>
      ) : (
        <p>This page is for the jar's family. Anyone can see its public record.</p>
      )}
      <p>
        <Link to={proofLink}>See the jar's public record</Link>
      </p>
    </section>
  );
}
