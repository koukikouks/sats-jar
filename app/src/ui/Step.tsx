/** The happy path's 5 steps, in order (spec #75). Every journey screen names its step from here. */
export const STEPS = ["Name your jar", "Invite 2 guardians", "Set the rules", "Top it up", "Hand it over"] as const;

/** "Step 3 of 5 · Set the rules": where a journey screen sits in the 5 steps. */
export function Step(props: { n: 1 | 2 | 3 | 4 | 5 }) {
  return (
    <p className="step">
      Step {props.n} of {STEPS.length} · {STEPS[props.n - 1]}
    </p>
  );
}
