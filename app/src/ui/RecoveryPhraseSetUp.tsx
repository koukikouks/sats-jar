import { useMutation } from "@tanstack/react-query";
import { useState, type FormEvent, type ReactNode } from "react";
import { useSdk } from "../services.tsx";
import { Field } from "./Field.tsx";
import { Refusal } from "./messages.tsx";
import { pinProblem } from "./PinGate.tsx";

type Step = { name: "intro" } | { name: "words"; words: string[]; check: number[] } | { name: "check"; check: number[] };

/**
 * Sets up a phone whose keys come from a recovery phrase: the child's (stories 41–44) or a new
 * holder's (story 58a). The words show once and live only in memory until they are checked.
 */
export function RecoveryPhraseSetUp(props: { heading: string; intro: ReactNode; onDone: () => void }) {
  const sdk = useSdk();
  const [step, setStep] = useState<Step>({ name: "intro" });
  const start = useMutation({
    mutationFn: () => sdk.child.startSetUp(),
    onSuccess: ({ words, check }) => setStep({ name: "words", words, check }),
  });
  if (step.name === "intro") {
    return (
      <section className="panel">
        <h1>{props.heading}</h1>
        {props.intro}
        <Refusal error={start.error} />
        <button type="button" disabled={start.isPending} onClick={() => start.mutate()}>
          Show my recovery phrase
        </button>
      </section>
    );
  }
  if (step.name === "words") {
    return (
      <section className="panel">
        <h1>Your recovery phrase</h1>
        <p>
          Write these 12 words on paper, in order, and keep it somewhere safe. Anyone with these words can take your jar. Nobody,
          Sats Jar included, can give them back if you lose them.
        </p>
        <ol className="words">
          {step.words.map((word, n) => (
            <li key={n}>{word}</li>
          ))}
        </ol>
        <button type="button" onClick={() => setStep({ name: "check", check: step.check })}>
          I've written them down
        </button>
      </section>
    );
  }
  return <CheckWords check={step.check} onDone={props.onDone} />;
}

function CheckWords(props: { check: number[]; onDone: () => void }) {
  const sdk = useSdk();
  const [typed, setTyped] = useState<Record<number, string>>({});
  const [pin, setPin] = useState("");
  const [again, setAgain] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const finish = useMutation({
    mutationFn: () => sdk.child.finishSetUp({ words: props.check.map((index) => ({ index, word: typed[index] ?? "" })), pin }),
    onSuccess: props.onDone,
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const found = pinProblem(pin, again);
    setProblem(found);
    if (found === null) finish.mutate();
  };
  return (
    <form className="panel" onSubmit={submit}>
      <h1>Check your words</h1>
      {props.check.map((index) => (
        <Field key={index} label={`Word ${index + 1}`}>
          <input autoComplete="off" value={typed[index] ?? ""} onChange={(e) => setTyped({ ...typed, [index]: e.target.value })} />
        </Field>
      ))}
      <Field label="PIN" hint="A 6-digit PIN unlocks your jar on this phone.">
        <input type="password" inputMode="numeric" autoComplete="new-password" value={pin} onChange={(e) => setPin(e.target.value)} />
      </Field>
      <Field label="Type it again">
        <input type="password" inputMode="numeric" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
      </Field>
      {problem && (
        <p className="refusal" role="alert">
          {problem}
        </p>
      )}
      <Refusal error={finish.error} />
      <button type="submit" disabled={finish.isPending}>
        Finish
      </button>
    </form>
  );
}
