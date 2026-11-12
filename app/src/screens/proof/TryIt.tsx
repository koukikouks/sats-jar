import type { JarProof } from "@sats-jar/proof";
import type { Role, SatsJar } from "@sats-jar/sdk";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useSdk } from "../../services.tsx";
import { useDevice } from "../../ui/device.ts";
import { CheckIt, Refusal } from "../../ui/messages.tsx";
import { PinGate } from "../../ui/PinGate.tsx";
import { handoverDone } from "./words.ts";

type Try = keyof SatsJar["tryIt"];

interface Button {
  name: Try;
  label: string;
}

/**
 * "Try to break the rule" (story 39): real requests from this device that the rule must
 * refuse, offered by the jar's public state and this device's roles.
 */
export function TryIt(props: { jar: JarProof }) {
  const sdk = useSdk();
  const { jarId } = props.jar;
  const { state } = useDevice();
  const unlocked = state === "unlocked";
  // Roles need the device's keys; a new or locked device is treated as an outsider until set up.
  const status = useQuery({ queryKey: ["jar", jarId, "status"], queryFn: () => sdk.jars.status(jarId), enabled: unlocked });
  const [wantsToTry, setWantsToTry] = useState(false);
  const tried = useMutation({ mutationFn: (name: Try) => sdk.tryIt[name](jarId) });
  if (state === undefined || (unlocked && status.data === undefined && !status.error)) return null;
  const roles = status.data?.roles ?? [];

  const press = (name: Try) => {
    if (unlocked) tried.mutate(name);
    else setWantsToTry(true);
  };

  return (
    <section className="panel">
      <h2>Try to break the rule</h2>
      <p>These buttons send real requests the jar's rule must refuse. Each refusal is a real transaction you can check.</p>
      {buttons(props.jar, roles).map((button) => (
        <button key={button.name} type="button" onClick={() => press(button.name)} disabled={tried.isPending}>
          {button.label}
        </button>
      ))}
      {wantsToTry && !unlocked && (
        <>
          {state === "new" && <p>To try, set up Sats Jar on this device first.</p>}
          <PinGate>{null}</PinGate>
        </>
      )}
      {tried.data && (
        <p>
          <span className="refusal">Refused: {tried.data.message}</span> <CheckIt url={tried.data.explorerUrl} />
        </p>
      )}
      <Refusal error={tried.error} />
    </section>
  );
}

function buttons(jar: JarProof, roles: Role[]): Button[] {
  const shown: Button[] = [];
  if (!handoverDone(jar)) shown.push({ name: "earlySpend", label: "Send its Bitcoin somewhere else before handover" });
  else if (!roles.includes("holder")) {
    const label = roles.includes("giver") ? "Spend it as the family after handover" : "Spend it without holding it";
    shown.push({ name: "afterHandover", label });
  }
  if (!roles.includes("guardian")) shown.push({ name: "outsiderApproval", label: "Approve its emergency payment as an outsider" });
  return shown;
}
