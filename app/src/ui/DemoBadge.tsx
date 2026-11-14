/** Shown wherever a demo-timing jar shows (spec #1, Demo timing). */
export function DemoBadge(props: { demoTiming: boolean }) {
  return props.demoTiming ? <span className="badge demo">Demo timing</span> : null;
}
