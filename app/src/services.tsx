// The only doors to the chain and the backend: the App SDK and the proof reader. Screens reach
// them through this context, so tests can hand in a stand-in.
import type { ProofReader } from "@sats-jar/proof";
import type { SatsJar } from "@sats-jar/sdk";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createContext, useContext, useState, type ReactNode } from "react";

const SdkContext = createContext<SatsJar | null>(null);
const ProofContext = createContext<ProofReader | null>(null);

export function Services(props: { sdk: SatsJar; proof: ProofReader; retry?: boolean; children: ReactNode }) {
  // A refusal is an answer, not a hiccup: never retry it behind the person's back.
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: props.retry ?? false, refetchOnWindowFocus: false } } }),
  );
  return (
    <QueryClientProvider client={client}>
      <SdkContext.Provider value={props.sdk}>
        <ProofContext.Provider value={props.proof}>{props.children}</ProofContext.Provider>
      </SdkContext.Provider>
    </QueryClientProvider>
  );
}

export function useSdk(): SatsJar {
  const sdk = useContext(SdkContext);
  if (sdk === null) throw new Error("useSdk outside <Services>");
  return sdk;
}

export function useProof(): ProofReader {
  const proof = useContext(ProofContext);
  if (proof === null) throw new Error("useProof outside <Services>");
  return proof;
}
