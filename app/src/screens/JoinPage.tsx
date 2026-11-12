import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "react-router";
import { useSdk } from "../services.tsx";
import { Refusal } from "../ui/messages.tsx";
import { PinGate } from "../ui/PinGate.tsx";

/** "/join/:token": what a guardian agrees to, then joining from this device (stories 10, 32, 35, 40). */
export function JoinPage() {
  const sdk = useSdk();
  const { token = "" } = useParams();
  const preview = useQuery({ queryKey: ["invite", token], queryFn: () => sdk.invites.preview(token) });
  if (preview.data === undefined) return <Refusal error={preview.error} />;
  const { nickname, joined } = preview.data;
  return (
    <section className="panel">
      <h1>Be a guardian of {nickname}</h1>
      <p>
        Guardians are trusted adults. Two of them must agree to any emergency payment to the child, and before the child takes the
        jar over you'll check a code on their phone in person. No guardian can send the jar's Bitcoin anywhere else.
      </p>
      {joined ? (
        // The SDK's INVITE_USED sentence, shown before anyone tries the link.
        <p className="refusal">Someone has already joined with this invite link. Ask for a new link.</p>
      ) : (
        <PinGate>
          <Join token={token} nickname={nickname} />
        </PinGate>
      )}
    </section>
  );
}

function Join(props: { token: string; nickname: string }) {
  const sdk = useSdk();
  const client = useQueryClient();
  const join = useMutation({
    mutationFn: () => sdk.invites.join(props.token),
    onSuccess: () => client.invalidateQueries({ queryKey: ["jars"] }),
  });
  if (join.isSuccess) {
    return <p className="done">You're a guardian of {props.nickname}. The jar appears under Your jars once it's created.</p>;
  }
  return (
    <>
      <Refusal error={join.error} />
      <button type="button" disabled={join.isPending} onClick={() => join.mutate()}>
        Join as a guardian
      </button>
    </>
  );
}
