import { SatsJarRefusal } from "@sats-jar/sdk";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useParams } from "react-router";
import { useSdk } from "../services.tsx";
import { useDevice } from "../ui/device.ts";
import { Refusal } from "../ui/messages.tsx";
import { NewPinFields, PinGate, pinProblem } from "../ui/PinGate.tsx";

/** "/join/:token": what a guardian agrees to, then joining from this device in one press (stories 10, 20, 32, 35, 40). */
export function JoinPage() {
  const sdk = useSdk();
  const client = useQueryClient();
  const { state } = useDevice();
  const { token = "" } = useParams();
  const preview = useQuery({ queryKey: ["invite", token], queryFn: () => sdk.invites.preview(token) });
  // Held here, above the device-state branch, so a refusal after the PIN is set survives the
  // page switching from the new-device form to the plain join button.
  const join = useMutation({
    mutationFn: () => sdk.invites.join(token),
    onSuccess: () => client.invalidateQueries({ queryKey: ["jars"] }),
  });
  if (preview.data === undefined) return <Refusal error={preview.error} />;
  const { nickname, joined } = preview.data;
  return (
    <section className="panel">
      <h1>Be a guardian of {nickname}</h1>
      <p>
        Guardians are grown-ups the family trusts. Two of you must agree to any emergency payment to the child, and before the child
        takes the jar over you'll check a code on their phone, in person. No guardian can send the jar's Bitcoin anywhere else.
      </p>
      {joined ? (
        // The SDK's INVITE_USED sentence, shown before anyone tries the link.
        <p className="refusal">Someone has already joined with this invite link. Ask for a new link.</p>
      ) : state === "new" ? (
        <JoinWithNewPin onJoin={() => join.mutateAsync()} />
      ) : (
        <PinGate>
          <Join join={join} nickname={nickname} />
        </PinGate>
      )}
    </section>
  );
}

type JoinMutation = ReturnType<typeof useMutation<void, Error, void>>;

/** A new device: the PIN and the join in one press. The PIN is set first, then the join is sent. */
function JoinWithNewPin(props: { onJoin: () => Promise<void> }) {
  const sdk = useSdk();
  const { changed } = useDevice();
  const [pin, setPin] = useState("");
  const [again, setAgain] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const setUp = useMutation({
    mutationFn: async (chosen: string) => {
      await sdk.device.setUp({ pin: chosen });
      // Join before re-reading the device: the re-read swaps this form for the join button.
      await props.onJoin().catch(() => undefined);
      await changed();
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const found = pinProblem(pin, again);
    setProblem(found);
    if (found === null) setUp.mutate(pin);
  };
  return (
    <form onSubmit={submit}>
      <p>Choose a 6-digit PIN for this device. Nobody, Sats Jar included, can reset it.</p>
      <NewPinFields pin={pin} again={again} onPin={setPin} onAgain={setAgain} />
      {problem && (
        <p className="refusal" role="alert">
          {problem}
        </p>
      )}
      <Refusal error={setUp.error} />
      <button type="submit" disabled={setUp.isPending}>
        Join as a guardian
      </button>
    </form>
  );
}

function Join(props: { join: JoinMutation; nickname: string }) {
  const { join } = props;
  // One person fills one guardian spot (story 40b): this device has joined through another link.
  if (join.error instanceof SatsJarRefusal && join.error.code === "ALREADY_GUARDIAN") {
    return (
      <p className="refusal">
        This device has already joined this jar as a guardian. Send this link to the other guardian to open on their own phone.
      </p>
    );
  }
  if (join.isSuccess) {
    return <p className="done">You're a guardian of {props.nickname}. You'll find the jar under Your jars once it's made.</p>;
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
