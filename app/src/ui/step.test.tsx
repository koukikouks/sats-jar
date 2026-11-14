/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Step } from "./Step.tsx";

describe("the journey's step kicker", () => {
  it("names the step and where it sits in the 5", () => {
    render(<Step n={3} />);
    expect(screen.getByText("Step 3 of 5 · Set the rules")).toBeTruthy();
  });
});
