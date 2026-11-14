import type { Draft, JarSummary } from "@sats-jar/sdk";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { useSdk } from "../services.tsx";
import { DemoBadge } from "../ui/DemoBadge.tsx";
import { useDevice } from "../ui/device.ts";
import { roleLine, sats } from "../ui/format.ts";
import { Refusal } from "../ui/messages.tsx";
import { PinGate } from "../ui/PinGate.tsx";

/** "/": a new device's three ways in, or this device's jars (stories 1, 9, 17, 43, 56). */
export function Home() {
  const { state } = useDevice();
  if (state === undefined) return null;
  if (state === "new") return <Welcome />;
  return (
    <PinGate>
      <YourJars />
    </PinGate>
  );
}

function Welcome() {
  return (
    <section className="panel welcome">
      <h1>A jar of Bitcoin for someone you love</h1>
      <p>
        Anyone can top it up, the child gets a small allowance on a schedule, and on the day you choose the whole jar becomes
        theirs.
      </p>
      <Link className="button" to="/new">
        Make a jar
      </Link>
      <ul className="plain">
        <li>
          <Link to="/restore">Restore my jar from its recovery phrase</Link>
        </li>
        <li>
          <Link to="/receive">Someone is giving me a jar</Link>
        </li>
      </ul>
      <p className="hint">Asked to be a guardian, or setting up your own jar? Open the link you were sent.</p>
    </section>
  );
}

function YourJars() {
  const sdk = useSdk();
  const jars = useQuery({ queryKey: ["jars"], queryFn: () => sdk.jars.mine() });
  const drafts = useQuery({ queryKey: ["drafts"], queryFn: () => sdk.invites.mine() });
  const pending = (drafts.data ?? []).filter((draft) => draft.jarId === null);
  const empty = jars.data?.length === 0 && drafts.data !== undefined && pending.length === 0;
  return (
    <section>
      <h1>Your jars</h1>
      <ul className="cards">
        {(jars.data ?? []).map((jar) => (
          <JarCard key={jar.jarId} jar={jar} />
        ))}
        {pending.map((draft) => (
          <DraftCard key={draft.draftId} draft={draft} />
        ))}
      </ul>
      {empty && <p className="empty">No jars here yet. Make one, or open a link someone sent you.</p>}
      <Refusal error={jars.error ?? drafts.error} />
      <Link className="button" to="/new">
        Make a jar
      </Link>
    </section>
  );
}

function JarCard(props: { jar: JarSummary }) {
  const { jar } = props;
  return (
    <li className="card">
      <Link to={`/jar/${jar.jarId}`}>
        <img className="picture" src={jar.picture} alt="" />
        <span className="card-title">{jar.nickname}</span>
      </Link>
      <DemoBadge demoTiming={jar.demoTiming} />
      <span>{sats(jar.balance)}</span>
      <span className="hint">{roleLine(jar.roles)}</span>
    </li>
  );
}

function DraftCard(props: { draft: Draft }) {
  const sdk = useSdk();
  const { draft } = props;
  const progress = useQuery({ queryKey: ["draft", draft.draftId], queryFn: () => sdk.invites.progress(draft.draftId) });
  const joined = progress.data?.joined.filter(Boolean).length;
  return (
    <li className="card">
      <Link to={`/draft/${draft.draftId}`}>
        {draft.nickname}
        {joined !== undefined && `: ${joined} of ${draft.inviteTokens.length} guardians joined so far`}
      </Link>
    </li>
  );
}
