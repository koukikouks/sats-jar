import { FULL_PERIOD, SatsJarRefusal, type Draft } from "@sats-jar/sdk";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState, type FormEvent } from "react";
import { Navigate, useNavigate, useParams } from "react-router";
import { useSdk } from "../services.tsx";
import { POLL } from "../ui/poll.ts";
import { Copy } from "../ui/Copy.tsx";
import { Field } from "../ui/Field.tsx";
import { Refusal } from "../ui/messages.tsx";
import { PinGate } from "../ui/PinGate.tsx";

/** Demo timing: one allowance every 10 minutes (spec #1, Demo timing). */
export const DEMO_PERIOD = 600;

// The SDK can't say whether this device already joined a draft, so the device remembers it here.
const joinedHereKey = (draftId: string) => `sats-jar.joined-draft.${draftId}`;

function joinedHere(draftId: string): boolean {
  try {
    return localStorage.getItem(joinedHereKey(draftId)) === "yes";
  } catch {
    return false;
  }
}

function rememberJoinedHere(draftId: string): void {
  try {
    localStorage.setItem(joinedHereKey(draftId), "yes");
  } catch {
    // Without storage the button simply comes back after a reload; pressing it says the same thing.
  }
}

const isAlreadyGuardian = (error: unknown): boolean => error instanceof SatsJarRefusal && error.code === "ALREADY_GUARDIAN";

/** What the rule form still needs, in words: "the child's address, the allowance cap and the unlock date". */
export function stillNeeded(missing: string[]): string | null {
  if (missing.length === 0) return null;
  const list = missing.length === 1 ? missing[0] : `${missing.slice(0, -1).join(", ")} and ${missing[missing.length - 1]}`;
  return `Still needed: ${list}.`;
}

/** "/draft/:draftId": the giver's invite links, who has joined, and the jar's rule (stories 4–11, 13). */
export function DraftPage() {
  return (
    <PinGate>
      <DraftOnThisDevice />
    </PinGate>
  );
}

function DraftOnThisDevice() {
  const sdk = useSdk();
  const { draftId = "" } = useParams();
  // The links live only on the device that made them.
  const drafts = useQuery({ queryKey: ["drafts"], queryFn: () => sdk.invites.mine() });
  if (drafts.data === undefined) return <Refusal error={drafts.error} />;
  const draft = drafts.data.find((d) => d.draftId === draftId);
  if (draft === undefined) return <p className="panel">This jar's invite links aren't on this device. Open them on the device that made them.</p>;
  if (draft.jarId !== null) return <Navigate to={`/jar/${draft.jarId}`} replace />;
  return <Invites draft={draft} />;
}

function Invites(props: { draft: Draft }) {
  const { draft } = props;
  const sdk = useSdk();
  const client = useQueryClient();
  const progress = useQuery({
    queryKey: ["draft", draft.draftId],
    queryFn: () => sdk.invites.progress(draft.draftId),
    refetchInterval: POLL,
  });
  const joined = progress.data?.joined ?? draft.inviteTokens.map(() => false);
  const joinedCount = joined.filter(Boolean).length;
  const firstOpen = draft.inviteTokens.find((_, n) => !joined[n]);
  const [isGuardianHere, setGuardianHere] = useState(() => joinedHere(draft.draftId));
  const markJoinedHere = () => {
    rememberJoinedHere(draft.draftId);
    setGuardianHere(true);
  };
  const joinMyself = useMutation({
    mutationFn: (token: string) => sdk.invites.join(token),
    onSuccess: () => {
      markJoinedHere();
      return client.invalidateQueries({ queryKey: ["draft", draft.draftId] });
    },
    onError: (error) => {
      if (isAlreadyGuardian(error)) markJoinedHere();
    },
  });
  const alreadyGuardian = isAlreadyGuardian(joinMyself.error);
  return (
    <>
      <section className="panel">
        <h1>{draft.nickname}: invite the guardians</h1>
        <p>Send each guardian their own link. Each link works once.</p>
        <ul className="plain">
          {draft.inviteTokens.map((token, n) => {
            const link = `${window.location.origin}/join/${token}`;
            return (
              <li key={token} className="invite">
                <strong>Guardian {n + 1}</strong> <span className={`badge ${joined[n] ? "done" : "waiting"}`}>{joined[n] ? "Joined" : "Waiting"}</span>
                <p className="mono">{link}</p>
                <Copy text={link} label="Copy link" />
              </li>
            );
          })}
        </ul>
        {alreadyGuardian && <p className="done">You're already one of this jar's guardians on this device.</p>}
        {joinMyself.isSuccess && <p className="done">You're one of this jar's guardians now.</p>}
        {firstOpen !== undefined && !isGuardianHere && (
          <>
            <button type="button" className="secondary" disabled={joinMyself.isPending} onClick={() => joinMyself.mutate(firstOpen)}>
              Use a link myself
            </button>
            <p className="hint">Makes you one of the guardians, on this device.</p>
          </>
        )}
        <Refusal error={(alreadyGuardian ? null : joinMyself.error) ?? progress.error} />
      </section>
      {joinedCount >= 2 ? (
        <RuleForm draft={draft} joinedCount={joinedCount} />
      ) : (
        <p className="panel">Once 2 guardians have joined, you can set the jar's rule and make it.</p>
      )}
    </>
  );
}

function RuleForm(props: { draft: Draft; joinedCount: number }) {
  const { draft, joinedCount } = props;
  const sdk = useSdk();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [childAddress, setChildAddress] = useState("");
  const [cap, setCap] = useState("");
  const [demo, setDemo] = useState(false);
  const [unlockDate, setUnlockDate] = useState("");
  const [unlockMinutes, setUnlockMinutes] = useState("");
  const create = useMutation({
    mutationFn: () =>
      sdk.jars.create({
        draftId: draft.draftId,
        childAddress: childAddress.trim(),
        cap: Number(cap),
        period: demo ? DEMO_PERIOD : FULL_PERIOD,
        // Midnight UTC of the chosen day; under demo timing, minutes from now.
        unlockAt: demo ? Math.floor(Date.now() / 1000) + Number(unlockMinutes) * 60 : Date.parse(`${unlockDate}T00:00:00Z`) / 1000,
      }),
    onSuccess: async ({ jarId }) => {
      // The backend closes the draft once its jar exists, so its invite progress is not read again.
      await client.invalidateQueries({ predicate: (query) => query.queryKey[0] !== "draft" });
      navigate(`/jar/${jarId}`);
    },
  });
  const missing = [
    ...(childAddress.trim() === "" ? ["the child's address"] : []),
    ...(cap === "" ? ["the allowance cap"] : []),
    ...(demo ? (unlockMinutes === "" ? ["the minutes until it unlocks"] : []) : unlockDate === "" ? ["the unlock date"] : []),
  ];
  const needed = stillNeeded(missing);
  const neededId = useId();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate();
  };
  return (
    <form className="panel" onSubmit={submit}>
      <h2>The jar's rule</h2>
      <Field
        label="Where should the allowance go?"
        hint="The child's Bitcoin address, from a wallet a parent controls: open it, tap Receive and copy the address. Not an exchange's deposit address. Until handover the jar can only ever pay this address."
      >
        <input placeholder="tb1q…" value={childAddress} onChange={(e) => setChildAddress(e.target.value)} />
      </Field>
      <Field label="Allowance cap (sats each period)" hint="The most the child receives each period. Bitcoin fees come out of the jar, never out of the allowance.">
        <input inputMode="numeric" value={cap} onChange={(e) => setCap(e.target.value.replace(/\D/g, ""))} />
      </Field>
      <fieldset className="field">
        <legend>How often?</legend>
        <label className="choice">
          <input type="radio" name="timing" checked={!demo} onChange={() => setDemo(false)} />
          Every 30 days
        </label>
        <label className="choice">
          <input type="radio" name="timing" checked={demo} onChange={() => setDemo(true)} />
          Demo timing: every 10 minutes
        </label>
        {demo && (
          <span className="hint">
            Shortens every wait so a jar's whole life fits in an afternoon. The jar shows a Demo timing badge.
          </span>
        )}
      </fieldset>
      {demo ? (
        <Field label="Unlocks in (minutes)" hint="The earliest the jar can be handed over to the child.">
          <input inputMode="numeric" value={unlockMinutes} onChange={(e) => setUnlockMinutes(e.target.value.replace(/\D/g, ""))} />
        </Field>
      ) : (
        <Field label="Unlock date" hint="The earliest the jar can be handed over to the child. Most families choose the 18th birthday.">
          <input type="date" value={unlockDate} onChange={(e) => setUnlockDate(e.target.value)} />
        </Field>
      )}
      {joinedCount < draft.inviteTokens.length && (
        <p>Only the {joinedCount} guardians who have joined will be on the jar. Wait for the others if you want them on it too.</p>
      )}
      <Refusal error={create.error} />
      <button type="submit" disabled={needed !== null || create.isPending} aria-describedby={needed === null ? undefined : neededId}>
        Make the jar
      </button>
      {needed !== null && (
        <p id={neededId} className="hint">
          {needed}
        </p>
      )}
    </form>
  );
}
