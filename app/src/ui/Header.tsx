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
      <Link to="/" className="brand" aria-label="Sats Jar, home">
        {/* The landing's wordmark: "sats jar" with the j dotted by a coin (a dotless j plus the coin). */}
        <span className="wordmark" aria-hidden="true">
          sats <span className="j">&#x237;</span>ar
        </span>
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
