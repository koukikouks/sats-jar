import { useMutation } from "@tanstack/react-query";
import { useState, type FormEvent, type ReactNode } from "react";
import { useSdk } from "../services.tsx";
import { useDevice } from "./device.ts";
import { Refusal } from "./messages.tsx";

/**
 * Shows its children only on an unlocked device. A new device sets up a PIN (adults: giver,
 * guardian, a visitor trying the rule); a locked one asks for it (stories 1, 2, 32).
 */
export function PinGate(props: { children: ReactNode }) {
  const { state } = useDevice();
  if (state === undefined) return null;
  if (state === "new") return <SetUpPin />;
  if (state === "locked") return <Unlock />;
  return <>{props.children}</>;
}

/** What a PIN box keeps of what was typed: digits only, at most 6 (a PIN is exactly 6). */
export const pinDigits = (typed: string): string => typed.replace(/\D/g, "").slice(0, 6);

/** Checks a chosen PIN typed twice; null when it is fine. */
export function pinProblem(pin: string, again: string): string | null {
  if (!/^\d{6}$/.test(pin)) return "Use 6 digits.";
  if (pin !== again) return "The two PINs don't match.";
  return null;
}

/** The "PIN" and "Type it again" fields, shared by every screen that sets a PIN. */
export function NewPinFields(props: { pin: string; again: string; onPin: (v: string) => void; onAgain: (v: string) => void }) {
  return (
    <>
      <label className="field">
        <span>PIN</span>
        <input type="password" inputMode="numeric" autoComplete="new-password" value={props.pin} onChange={(e) => props.onPin(pinDigits(e.target.value))} />
      </label>
      <label className="field">
        <span>Type it again</span>
        <input type="password" inputMode="numeric" autoComplete="new-password" value={props.again} onChange={(e) => props.onAgain(pinDigits(e.target.value))} />
      </label>
    </>
  );
}

function SetUpPin() {
  const sdk = useSdk();
  const { changed } = useDevice();
  const [pin, setPin] = useState("");
  const [again, setAgain] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const setUp = useMutation({ mutationFn: (chosen: string) => sdk.device.setUp({ pin: chosen }), onSuccess: changed });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const found = pinProblem(pin, again);
    setProblem(found);
    if (found === null) setUp.mutate(pin);
  };
  return (
    <form className="panel" onSubmit={submit}>
      <h1>Choose a PIN for this device</h1>
      <p>
        Pick 6 digits. They unlock Sats Jar on this device only. Nobody, Sats Jar included, can reset your PIN, so choose one
        you'll remember.
      </p>
      <NewPinFields pin={pin} again={again} onPin={setPin} onAgain={setAgain} />
      {problem && (
        <p className="refusal" role="alert">
          {problem}
        </p>
      )}
      <Refusal error={setUp.error} />
      <button type="submit" disabled={setUp.isPending}>
        Save my PIN
      </button>
    </form>
  );
}

function Unlock() {
  const sdk = useSdk();
  const { changed } = useDevice();
  const [pin, setPin] = useState("");
  const unlock = useMutation({ mutationFn: (typed: string) => sdk.device.unlock({ pin: typed }), onSuccess: changed });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    unlock.mutate(pin);
  };
  return (
    <form className="panel" onSubmit={submit}>
      <h1>Unlock Sats Jar</h1>
      <p>Type the 6-digit PIN you chose on this device.</p>
      <label className="field">
        <span>PIN</span>
        <input type="password" inputMode="numeric" autoComplete="current-password" value={pin} onChange={(e) => setPin(pinDigits(e.target.value))} />
      </label>
      <Refusal error={unlock.error} />
      <button type="submit" disabled={unlock.isPending}>
        Unlock
      </button>
    </form>
  );
}
