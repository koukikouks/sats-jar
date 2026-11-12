import { SatsJarRefusal } from "@sats-jar/sdk";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router";
import { useSdk } from "../services.tsx";
import { useDevice } from "../ui/device.ts";
import { Refusal } from "../ui/messages.tsx";
import { PinGate } from "../ui/PinGate.tsx";
import { RecoveryPhraseSetUp } from "../ui/RecoveryPhraseSetUp.tsx";

/** The child's plain statement (story 54, #25). */
export const NOBODY_CAN_RECOVER =
  "After handover, nobody, Sats Jar included, can recover your jar without this phone or your recovery phrase.";

/** "/jar/:jarId/set-up": "Set up my jar" on the child's own phone, then the claim (stories 41–46). */
export function ChildSetUp() {
  const { state, changed } = useDevice();
  if (state === undefined) return null;
  if (state === "new") {
    return (
      <RecoveryPhraseSetUp
        heading="Set up your jar"
        intro={
          <p>
            This makes your own keys on this phone, so only this phone can use your jar. First you'll write down a recovery
            phrase: 12 words that bring your jar back if you lose this phone.
          </p>
        }
        onDone={() => void changed()}
      />
    );
  }
  return (
    <PinGate>
      <Claim />
    </PinGate>
  );
}

function Claim() {
  const sdk = useSdk();
  const navigate = useNavigate();
  const client = useQueryClient();
  const { jarId = "" } = useParams();
  // Only a phone set up with a recovery phrase has a guardian code; an adult's device refuses.
  const code = useQuery({ queryKey: ["guardianCode"], queryFn: () => sdk.child.guardianCode() });
  const jar = useQuery({ queryKey: ["jar", jarId], queryFn: () => sdk.jars.status(jarId) });
  const claim = useMutation({
    mutationFn: () => sdk.child.claim(jarId),
    onSuccess: async () => {
      await client.invalidateQueries();
      navigate(`/jar/${jarId}`);
    },
  });
  if (code.error instanceof SatsJarRefusal && code.error.code === "NO_RECOVERY_PHRASE") {
    return <p className="panel">This device is set up for an adult. Open this link on the child's own phone.</p>;
  }
  if (code.data === undefined || jar.data === undefined) return <Refusal error={code.error ?? jar.error} />;
  return (
    <section className="panel">
      <h1>Claim {jar.data.nickname}</h1>
      <p>Your guardians will check this code on your phone in person:</p>
      <p className="code">{code.data}</p>
      <p>{NOBODY_CAN_RECOVER}</p>
      <Refusal error={claim.error} />
      <button type="button" disabled={claim.isPending} onClick={() => claim.mutate()}>
        Claim my jar
      </button>
    </section>
  );
}
