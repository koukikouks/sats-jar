import { Link } from "react-router";
import { useSdk } from "../services.tsx";
import { useDevice } from "./device.ts";

export function Header() {
  const sdk = useSdk();
  const { state, changed } = useDevice();
  const lock = () => {
    sdk.device.lock();
    void changed();
  };
  return (
    <header className="header">
      <Link to="/" className="brand">
        Sats Jar
      </Link>
      <span className="badge test">Test Bitcoin</span>
      {state === "unlocked" && (
        <button type="button" className="secondary" onClick={lock}>
          Lock
        </button>
      )}
    </header>
  );
}
