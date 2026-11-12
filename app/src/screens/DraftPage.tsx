import { FULL_PERIOD, type Draft } from "@sats-jar/sdk";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Navigate, useNavigate, useParams } from "react-router";
import { useSdk } from "../services.tsx";
import { POLL } from "../ui/poll.ts";
import { Copy } from "../ui/Copy.tsx";
import { Field } from "../ui/Field.tsx";
import { Refusal } from "../ui/messages.tsx";
import { PinGate } from "../ui/PinGate.tsx";

/** Demo timing: one allowance every 10 minutes (spec #1, Demo timing). */
export const DEMO_PERIOD = 600;

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
  if (draft === undefined) return <p className="panel">This jar's invite links are no longer pending.</p>;
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
  const joinMyself = useMutation({
    mutationFn: (token: string) => sdk.invites.join(token),
    onSuccess: () => client.invalidateQueries({ queryKey: ["draft", draft.draftId] }),
  });
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
                <strong>Guardian {n + 1}</strong> <span className="badge">{joined[n] ? "Joined" : "Waiting"}</span>
                <p className="mono">{link}</p>
                <Copy text={link} label="Copy link" />
              </li>
            );
          })}
        </ul>
        {firstOpen !== undefined && (
          <>
            <button type="button" className="secondary" disabled={joinMyself.isPending} onClick={() => joinMyself.mutate(firstOpen)}>
              Use a link myself
            </button>
            <p className="hint">Makes you one of the guardians, on this device.</p>
          </>
        )}
        <Refusal error={joinMyself.error ?? progress.error} />
      </section>
      {joinedCount >= 2 ? (
        <RuleForm draft={draft} joinedCount={joinedCount} />
      ) : (
        <p className="panel">You can create the jar once 2 guardians have joined.</p>
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
      await client.invalidateQueries();
      navigate(`/jar/${jarId}`);
    },
  });
  const complete = childAddress.trim() !== "" && cap !== "" && (demo ? unlockMinutes !== "" : unlockDate !== "");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate();
  };
  return (
    <form className="panel" onSubmit={submit}>
      <h2>The jar's rule</h2>
      <Field label="Child's Bitcoin address" hint="Copy it from a Bitcoin wallet a parent controls, not from an exchange. Before handover the jar can only ever pay this address.">
        <input placeholder="tb1q…" value={childAddress} onChange={(e) => setChildAddress(e.target.value)} />
      </Field>
      <Field label="Allowance per period (sats)" hint="The most the child receives each period. Bitcoin fees come out of the jar, never out of the allowance.">
        <input inputMode="numeric" value={cap} onChange={(e) => setCap(e.target.value.replace(/\D/g, ""))} />
      </Field>
      <fieldset className="field">
        <legend>Timing</legend>
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
      {joinedCount < draft.inviteTokens.length && <p>Only the {joinedCount} guardians who have joined will be on the jar.</p>}
      <Refusal error={create.error} />
      <button type="submit" disabled={!complete || create.isPending}>
        Create the jar
      </button>
    </form>
  );
}
