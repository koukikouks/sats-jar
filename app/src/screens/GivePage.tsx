import { useQuery } from "@tanstack/react-query";
import { Link, Navigate, useParams } from "react-router";
import { useSdk } from "../services.tsx";
import { useDevice } from "../ui/device.ts";
import { Refusal } from "../ui/messages.tsx";
import { PinGate } from "../ui/PinGate.tsx";

const NOTHING_TO_GIVE = "This link gives a jar away, but this device holds no jar it can give right now.";

/**
 * "/give/:code": a receive link from the person a jar is being given to (stories 24, 25). It opens
 * this device's "Give the jar to someone" form with their code filled in; it sends nothing itself.
 */
export function GivePage() {
  const { state } = useDevice();
  if (state === undefined) return null;
  // A new phone holds no jar; setting a PIN here would stop it restoring a recovery phrase later.
  if (state === "new") return <NothingToGive />;
  return (
    <PinGate>
      <ChooseJar />
    </PinGate>
  );
}

function ChooseJar() {
  const sdk = useSdk();
  const { code = "" } = useParams();
  // A jar can be given once its handover is done and no transfer is open: what the holder's form needs.
  const givable = useQuery({
    queryKey: ["givable"],
    queryFn: async () => {
      const held = (await sdk.jars.mine()).filter((jar) => jar.roles.includes("holder"));
      const statuses = await Promise.all(held.map((jar) => sdk.jars.status(jar.jarId)));
      return statuses.filter((jar) => jar.handover.state === "done" && jar.transfer.state === "none");
    },
  });
  if (givable.data === undefined) return <Refusal error={givable.error} />;
  const target = (jarId: string) => `/jar/${jarId}?give=${encodeURIComponent(code)}`;
  const [only, ...rest] = givable.data;
  if (only === undefined) return <NothingToGive />;
  if (rest.length === 0) return <Navigate to={target(only.jarId)} replace />;
  return (
    <section className="panel">
      <h1>Which jar are you giving?</h1>
      <ul className="plain">
        {givable.data.map((jar) => (
          <li key={jar.jarId}>
            <Link to={target(jar.jarId)}>Give {jar.nickname}</Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function NothingToGive() {
  return (
    <section className="panel">
      <p>{NOTHING_TO_GIVE}</p>
      <Link to="/">Your jars</Link>
    </section>
  );
}
