/** A readable refusal: a stable SCREAMING_SNAKE code the SDK maps, and a sentence. */
export class Refusal extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
