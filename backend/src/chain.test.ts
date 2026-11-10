import { describe, expect, it } from "vitest";
import { outcomeOf } from "./chain.ts";
import { fixture } from "./keeper.fakes.ts";

// Final outcomes of T06's calls on sats-jar-dev.testnet, recorded with the `tx` RPC method.
describe("a call's outcome", () => {
  it("a successful call gives the contract's return value", () => {
    const response = fixture<Parameters<typeof outcomeOf>[0]>("near-tx-request-allowance-ok.json");

    expect(outcomeOf(response)).toEqual({
      ok: true,
      hash: "GT7NZh8kRdF1zphS8WmV8mFYs3j7JLvxdY2ai2jxAZdW",
      value: "1",
    });
  });

  it("a refusal gives the contract's code and sentence", () => {
    const response = fixture<Parameters<typeof outcomeOf>[0]>("near-tx-request-allowance-already-paid.json");

    expect(outcomeOf(response)).toEqual({
      ok: false,
      hash: "HXdy5TkMDTf3u7iy1FPZ7U8EEhshmVDRyMZEW6NCRNUP",
      code: "ALREADY_PAID",
      message: "the allowance for this period was already paid; next one in 23h 59m",
    });
  });

  it("a failure without a refusal code keeps NEAR's text and no code", () => {
    // Synthetic variant of the recorded refusal: a gas failure in its place.
    const response = fixture<Parameters<typeof outcomeOf>[0]>("near-tx-request-allowance-already-paid.json");
    const failed = { ...response, status: { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: "Exceeded the prepaid gas." } } } } } };

    expect(outcomeOf(failed)).toEqual({
      ok: false,
      hash: "HXdy5TkMDTf3u7iy1FPZ7U8EEhshmVDRyMZEW6NCRNUP",
      code: null,
      message: "Exceeded the prepaid gas.",
    });
  });
});
