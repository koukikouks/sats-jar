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
      return `Confirming, ${topUp.confirmations ?? 0} of 3`;
    case "counted":
      return "Counted";
    case "too_small":
      return "Under 1,000 sats, so it doesn't count";
  }
}

export function TopUpsSection(props: { jarId: string }) {
  const sdk = useSdk();
  const topUps = useQuery({ queryKey: ["topUps", props.jarId], queryFn: () => sdk.jars.topUps(props.jarId), refetchInterval: POLL });
  return (
    <section className="panel">
      <h2>Top-ups</h2>
      {topUps.data?.length === 0 && <p>No top-ups yet.</p>}
      <ul className="plain rows">
        {(topUps.data ?? []).map((topUp) => (
          <li key={topUp.txid}>
            <span>{sats(topUp.value)}</span> <span>{progress(topUp)}</span> <CheckIt url={topUp.explorerUrl} />
          </li>
        ))}
      </ul>
      <Refusal error={topUps.error} />
    </section>
  );
}
