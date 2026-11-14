import { useMutation } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { useSdk } from "../services.tsx";
import { Field } from "../ui/Field.tsx";
import { Refusal } from "../ui/messages.tsx";
import { PinGate } from "../ui/PinGate.tsx";

/** "/new": the giver names the jar and asks for 2 or 3 invite links (stories 10, 11, 12). */
export function NewJar() {
  return (
    <PinGate>
      <StartJar />
    </PinGate>
  );
}

function StartJar() {
  const sdk = useSdk();
  const navigate = useNavigate();
  const [nickname, setNickname] = useState("");
  const [guardians, setGuardians] = useState<2 | 3>(2);
  const start = useMutation({
    mutationFn: () => sdk.invites.start({ nickname: nickname.trim(), guardians }),
    onSuccess: (draft) => navigate(`/draft/${draft.draftId}`),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    start.mutate();
  };
  return (
    <form className="panel" onSubmit={submit}>
      <h1>Make a jar</h1>
      <Field label="Jar nickname" hint={`Everyone can see this name, so use a nickname like "Sunny's jar", not the child's full name.`}>
        <input value={nickname} onChange={(e) => setNickname(e.target.value)} />
      </Field>
      <fieldset className="field">
        <legend>How many guardians?</legend>
        {([2, 3] as const).map((count) => (
          <label key={count} className="choice">
            <input type="radio" name="guardians" checked={guardians === count} onChange={() => setGuardians(count)} />
            {count} guardians
          </label>
        ))}
        <span className="hint">
          Guardians are grown-ups you trust. Two of them must agree to any emergency payment, and they check it's really the
          child before the jar is handed over. You can be one of them.
        </span>
      </fieldset>
      <Refusal error={start.error} />
      <button type="submit" disabled={start.isPending || nickname.trim() === ""}>
        Make invite links
      </button>
    </form>
  );
}
