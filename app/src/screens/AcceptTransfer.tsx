import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router";
import { useSdk } from "../services.tsx";
import { Refusal } from "../ui/messages.tsx";
import { PinGate } from "../ui/PinGate.tsx";

/** "/jar/:jarId/accept": the receiver accepts with their own key (stories 57, 58a, 59). */
export function AcceptTransfer() {
  return (
    <PinGate>
      <Accept />
    </PinGate>
  );
}

function Accept() {
  const sdk = useSdk();
  const navigate = useNavigate();
  const client = useQueryClient();
  const { jarId = "" } = useParams();
  const jar = useQuery({ queryKey: ["jar", jarId], queryFn: () => sdk.jars.status(jarId) });
  // No fee rate: the SDK uses the explorer's recommendation, within the re-homing fee bound.
  const accept = useMutation({
    mutationFn: () => sdk.holder.acceptTransfer(jarId),
    onSuccess: async () => {
      await client.invalidateQueries();
      navigate(`/jar/${jarId}`);
    },
  });
  if (jar.data === undefined) return <Refusal error={jar.error} />;
  return (
    <section className="panel">
      <h1>Accept {jar.data.nickname}</h1>
      <p>Accepting moves the jar's Bitcoin to a new address that only your recovery phrase can recover. Then the jar is yours.</p>
      <Refusal error={accept.error} />
      <button type="button" disabled={accept.isPending} onClick={() => accept.mutate()}>
        Accept the jar
      </button>
    </section>
  );
}
