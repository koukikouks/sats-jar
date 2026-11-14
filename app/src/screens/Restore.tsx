import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { useDevice } from "../ui/device.ts";
import { useSdk } from "../services.tsx";
import { Field } from "../ui/Field.tsx";
import { Refusal } from "../ui/messages.tsx";
import { NewPinFields, pinProblem } from "../ui/PinGate.tsx";

/** "/restore": the child's jar comes back on a new phone from the recovery phrase (stories 29, 43). */
export function Restore() {
  const { state } = useDevice();
  if (state === undefined) return null;
  // A phrase can only be adopted by a device with no keys yet: say so before 12 words are typed.
  if (state !== "new") {
    return (
      <section className="panel">
        <h1>Restore your jar</h1>
        <p>This device is already set up, so a recovery phrase can't be restored here. Restore on a phone that hasn't used Sats Jar yet.</p>
        <Link to="/">Your jars</Link>
      </section>
    );
  }
  return <RestoreForm />;
}

function RestoreForm() {
  const sdk = useSdk();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [phrase, setPhrase] = useState("");
  const [pin, setPin] = useState("");
  const [again, setAgain] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const restore = useMutation({
    mutationFn: () => sdk.child.restore({ words: phrase.trim().toLowerCase().split(/\s+/), pin }),
    onSuccess: async () => {
      await client.invalidateQueries();
      navigate("/");
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const found = pinProblem(pin, again);
    setProblem(found);
    if (found === null) restore.mutate();
  };
  return (
    <form className="panel" onSubmit={submit}>
      <h1>Restore your jar</h1>
      <p>Type your 12-word recovery phrase, with spaces between the words. Your jar comes back on this phone.</p>
      <Field label="Recovery phrase">
        <textarea rows={3} autoComplete="off" value={phrase} onChange={(e) => setPhrase(e.target.value)} />
      </Field>
      <NewPinFields pin={pin} again={again} onPin={setPin} onAgain={setAgain} />
      {problem && (
        <p className="refusal" role="alert">
          {problem}
        </p>
      )}
      <Refusal error={restore.error} />
      <button type="submit" disabled={restore.isPending}>
        Restore
      </button>
    </form>
  );
}
