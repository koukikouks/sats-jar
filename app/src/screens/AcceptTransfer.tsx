import type { JarStatus } from "@sats-jar/sdk";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { useSdk } from "../services.tsx";
import { coinsStillToGo } from "../ui/format.ts";
import { Refusal } from "../ui/messages.tsx";
import { PinGate } from "../ui/PinGate.tsx";
import { POLL } from "../ui/poll.ts";

/** "/jar/:jarId/accept": the receiver accepts with their own key, then watches the jar arrive (stories 27, 57, 58a, 59). */
export function AcceptTransfer() {
  return (
    <PinGate>
      <Accept />
    </PinGate>
  );
}

function Accept() {
  const sdk = useSdk();
  const client = useQueryClient();
  const { jarId = "" } = useParams();
  const jar = useQuery({ queryKey: ["jar", jarId], queryFn: () => sdk.jars.status(jarId), refetchInterval: POLL });
  // No fee rate: the SDK uses the explorer's recommendation, within the re-homing fee bound.
  const accept = useMutation({
    mutationFn: () => sdk.holder.acceptTransfer(jarId),
    // Every query: Your jars must show the new jar too.
    onSuccess: () => client.invalidateQueries(),
  });
  if (jar.data === undefined) return <Refusal error={jar.error} />;
  const { nickname } = jar.data;
  return (
    <section className="panel">
      <h1>Accept {nickname}</h1>
      <Progress jar={jar.data} />
      {jar.data.transfer.state === "offered" && jar.data.transfer.toMe && (
        <>
          <p>Accepting moves the jar's Bitcoin to a new address that only your recovery phrase can recover. Then the jar is yours.</p>
          <Refusal error={accept.error} />
          <button type="button" disabled={accept.isPending} onClick={() => accept.mutate()}>
            Accept the jar
          </button>
        </>
      )}
    </section>
  );
}

/** Where the transfer stands for this phone, in every state but the one with the Accept button. */
function Progress(props: { jar: JarStatus }) {
  const { jar } = props;
  const { transfer } = jar;
  if (transfer.state === "offered") {
    return transfer.toMe ? null : <p>This transfer is for a different phone. Open the link on the phone that made your receive code.</p>;
  }
  if (transfer.state === "moving") {
    return transfer.toMe ? (
      <p className="waiting">The jar's Bitcoin is moving to your key: {coinsStillToGo(transfer.coinsLeft)}.</p>
    ) : (
      <p>This jar is moving to someone else.</p>
    );
  }
  if (jar.roles.includes("holder")) {
    return (
      <>
        <p className="done">{jar.nickname} is yours.</p>
        <Link className="button" to={`/jar/${jar.jarId}`}>
          Open your jar
        </Link>
      </>
    );
  }
  return <p>There's no transfer to accept for this jar right now. Ask the person giving it to you to start one.</p>;
}
