import type { ProofReader } from "@sats-jar/proof";
import type { SatsJar } from "@sats-jar/sdk";
import { cleanup, render, type RenderResult } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, vi } from "vitest";
import { App } from "../App.tsx";
import { Services } from "../services.tsx";
import { standInProof, standInSdk, type StandInProof, type StandInSdk } from "./stand-in.ts";

afterEach(cleanup);
// Typing a form through user-event takes seconds on a loaded machine; the 5 s default flakes.
vi.setConfig({ testTimeout: 30_000 });

export interface Rendered extends RenderResult {
  user: UserEvent;
  sdk: StandInSdk;
  proof: StandInProof;
}

/** Renders the whole app at `path`, over a stand-in SDK the test has set up. */
export function renderApp(path: string, setUp?: (sdk: StandInSdk, proof: StandInProof) => void): Rendered {
  const sdk = standInSdk();
  const proof = standInProof();
  setUp?.(sdk, proof);
  const user = userEvent.setup();
  const result = render(
    <Services sdk={sdk as unknown as SatsJar} proof={proof as unknown as ProofReader} retry={false}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </Services>,
  );
  return { ...result, user, sdk, proof };
}
