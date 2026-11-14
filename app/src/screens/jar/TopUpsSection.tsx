import type { TopUp } from "@sats-jar/sdk";
import { useQuery } from "@tanstack/react-query";
import { useSdk } from "../../services.tsx";
import { POLL } from "../../ui/poll.ts";
import { sats } from "../../ui/format.ts";
import { CheckIt, Refusal } from "../../ui/messages.tsx";


/** How far a top-up has got (stories 16, 18, 20). */
function progress(topUp: TopUp): string {
  switch (topUp.status) {
    case "on_the_way":
      return "On the way";
    case "confirming":
      // Bitcoin explorers run a few blocks ahead of the light client the jar trusts, so 3 or more
      // here can still wait to be counted.
      return (topUp.confirmations ?? 0) >= 3 ? "Confirmed on Bitcoin, being counted" : `Confirming, ${topUp.confirmations ?? 0} of 3`;
    case "counted":
      return "Counted";
    case "too_small":
      return "Under 1,000 sats, so it doesn't count";
  }
}

/** How a top-up's progress is coloured: counted is done, still on its way is waiting. */
const STATUS_CLASS: Record<TopUp["status"], string | undefined> = {
  on_the_way: "waiting",
  confirming: "waiting",
  counted: "done",
  too_small: undefined,
};

export function TopUpsSection(props: { jarId: string }) {
  const sdk = useSdk();
  const topUps = useQuery({ queryKey: ["topUps", props.jarId], queryFn: () => sdk.jars.topUps(props.jarId), refetchInterval: POLL });
  return (
    <section className="panel">
      <h2>Top-ups</h2>
      {topUps.data?.length === 0 && <p>No top-ups yet. The first counted one starts the allowance.</p>}
      <ul className="plain rows">
        {/* One Bitcoin transaction can pay the jar twice, so the txid alone is not unique. */}
        {(topUps.data ?? []).map((topUp, n) => (
          <li key={`${topUp.txid}-${n}`}>
            <span>{sats(topUp.value)}</span> <span className={STATUS_CLASS[topUp.status]}>{progress(topUp)}</span> <CheckIt url={topUp.explorerUrl} />
          </li>
        ))}
      </ul>
      <Refusal error={topUps.error} />
    </section>
  );
}
