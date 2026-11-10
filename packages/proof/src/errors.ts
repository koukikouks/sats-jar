/** The jar does not exist on the contract. */
export class JarNotFoundError extends Error {
  readonly code = "JAR_NOT_FOUND";
  constructor(readonly jarId: string) {
    super(`There is no jar ${jarId}.`);
    this.name = "JarNotFoundError";
  }
}

export type ProofSource = "near" | "indexer" | "bitcoin";

const unavailable: Record<ProofSource, string> = {
  near: "The jar's contract could not be read just now. Try again shortly.",
  indexer: "The jar's NEAR transactions could not be loaded just now. Try again shortly.",
  bitcoin: "The jar's Bitcoin transactions could not be loaded just now. Try again shortly.",
};

/** A public API did not answer usefully. The upstream text is dropped on purpose. */
export class ProofUnavailableError extends Error {
  readonly code = "PROOF_UNAVAILABLE";
  constructor(readonly source: ProofSource) {
    super(unavailable[source]);
    this.name = "ProofUnavailableError";
  }
}
