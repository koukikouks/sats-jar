import type { Allowance, JarStatus } from "@sats-jar/sdk";
import { useQuery } from "@tanstack/react-query";
import { useSdk } from "../../services.tsx";
import { POLL } from "../../ui/poll.ts";
import { period, sats, when } from "../../ui/format.ts";
import { CheckIt, Refusal } from "../../ui/messages.tsx";


const PROGRESS: Record<Allowance["status"], string> = {
  signing: "Being signed",
  signing_failed: "Signing again",
  signed: "Sent, waiting for Bitcoin to confirm",
  confirmed: "Paid",
  cancelled: "Cancelled",
};

/** The allowance: what it is, what is available, when the next one goes, each payment (stories 14, 22–31). */
export function AllowanceSection(props: { jar: JarStatus }) {
  const { jar } = props;
  const sdk = useSdk();
  const allowances = useQuery({
    queryKey: ["allowances", jar.jarId],
    queryFn: () => sdk.jars.allowances(jar.jarId),
    refetchInterval: POLL,
  });
  return (
    <section className="panel">
      <h2>Allowance</h2>
      <p>
        Up to {sats(jar.cap)} every {period(jar.period)}.
      </p>
      <p>Available now: {sats(jar.availableAllowance)}.</p>
      <p>{jar.nextAllowanceAt === null ? "Starts with the first counted top-up." : `Next one: ${when(jar.nextAllowanceAt)}.`}</p>
      <p className="hint">Sats Jar pays it automatically.</p>
      <ul className="plain rows">
        {(allowances.data ?? []).map((allowance) => (
          <li key={`${allowance.requestedAt}-${allowance.amount}`}>
            <span>
              {sats(allowance.amount)} to the child, fee {sats(allowance.fee)} from the jar
            </span>{" "}
            <span>{PROGRESS[allowance.status]}</span> <CheckIt url={allowance.explorerUrl} />
          </li>
        ))}
      </ul>
      <Refusal error={allowances.error} />
    </section>
  );
}
