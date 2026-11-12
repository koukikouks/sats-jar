import { useQuery } from "@tanstack/react-query";
import { useSdk } from "../services.tsx";
import { Copy } from "../ui/Copy.tsx";
import { useDevice } from "../ui/device.ts";
import { Refusal } from "../ui/messages.tsx";
import { PinGate } from "../ui/PinGate.tsx";
import { RecoveryPhraseSetUp } from "../ui/RecoveryPhraseSetUp.tsx";

const HEADING = "Someone is giving you a jar";

/** "/receive": a new holder's phone, set up with its own recovery phrase, and its receive code (stories 56, 58a). */
export function Receive() {
  const { state, changed } = useDevice();
  if (state === undefined) return null;
  if (state === "new") {
    return (
      <RecoveryPhraseSetUp
        heading={HEADING}
        intro={
          <p>
            The jar's Bitcoin will answer only to keys made on this phone. First you'll write down a recovery phrase: 12 words that
            bring your jars back if you lose this phone.
          </p>
        }
        onDone={() => void changed()}
      />
    );
  }
  return (
    <PinGate>
      <ReceiveCode />
    </PinGate>
  );
}

function ReceiveCode() {
  const sdk = useSdk();
  // An adult's device has no recovery phrase; the SDK refuses with its own sentence.
  const code = useQuery({ queryKey: ["receiveCode"], queryFn: () => sdk.holder.receiveCode() });
  return (
    <section className="panel">
      <h1>{HEADING}</h1>
      {code.data !== undefined && (
        <>
          <h2>Your receive code</h2>
          <p className="mono">{code.data}</p>
          <Copy text={code.data} label="Copy code" />
          <p>Give this code to the person giving you the jar. It can only be used to give you a jar.</p>
        </>
      )}
      <Refusal error={code.error} />
    </section>
  );
}
