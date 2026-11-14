import type { Allowance, JarStatus } from "@sats-jar/sdk";
import { useQuery } from "@tanstack/react-query";
import { useSdk } from "../../services.tsx";
import { POLL } from "../../ui/poll.ts";
import { period, sats, when } from "../../ui/format.ts";
import { nowSeconds, payoutsStopped } from "./moments.ts";
import { CheckIt, Refusal } from "../../ui/messages.tsx";


const PROGRESS: Record<Allowance["status"], string> = {
  signing: "Being signed",
  signing_failed: "Signing again",
  signed: "Sent, waiting for Bitcoin to confirm",
  confirmed: "Paid",
  cancelled: "Cancelled",
};

/** How a payment's progress is coloured: paid is done, still moving is waiting. */
const STATUS_CLASS: Record<Allowance["status"], string | undefined> = {
  signing: "waiting",
  signing_failed: "waiting",
  signed: "waiting",
  confirmed: "done",
  cancelled: undefined,
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
      {payoutsStopped(jar) ? (
        <p>{stoppedLine(jar)}</p>
      ) : (
        <>
          <p>
            Up to {sats(jar.cap)} every {period(jar.period)}.
          </p>
          <p>Available now: {sats(jar.availableAllowance)}.</p>
          <p>{nextLine(jar)}</p>
          <p className="hint">Sats Jar sends it to the child's address on its own.</p>
        </>
      )}
      <ul className="plain rows">
        {(allowances.data ?? []).map((allowance) => (
          <li key={`${allowance.requestedAt}-${allowance.amount}`}>
            <span>
              {sats(allowance.amount)} to the child, fee {sats(allowance.fee)} from the jar
            </span>{" "}
            <span className={STATUS_CLASS[allowance.status]}>{PROGRESS[allowance.status]}</span> <CheckIt url={allowance.explorerUrl} />
          </li>
        ))}
      </ul>
      <Refusal error={allowances.error} />
    </section>
  );
}

/** Why no allowance goes out once the handover's waiting time has ended (story 53a). */
function stoppedLine(jar: JarStatus): string {
  if (jar.handover.state === "done") return "Allowances have ended. The jar is the child's now.";
  if (jar.handover.state === "completing") return "Allowances have ended. The jar's Bitcoin is moving to the child's own key.";
  // Confirmed, waiting time over: the handover may still wait for the unlock date, and can be cancelled.
  return "Allowances are paused while the handover waits to go ahead. If it's cancelled, they start again.";
}

/** When the next allowance goes. A passed time is promised only when the jar has sats: the keeper skips an empty jar. */
function nextLine(jar: JarStatus): string {
  if (jar.nextAllowanceAt === null) return "Starts with the first counted top-up.";
  if (jar.nextAllowanceAt > nowSeconds()) return `Next allowance: ${when(jar.nextAllowanceAt)}.`;
  return jar.balance > 0 ? "Next allowance: due now, Sats Jar sends it soon." : "Next allowance: once the jar has sats again.";
}
