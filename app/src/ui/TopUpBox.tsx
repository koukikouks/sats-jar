import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { Copy } from "./Copy.tsx";
import { Step } from "./Step.tsx";

/** Where to get test Bitcoin (testnet3, checked live 2026-11-14; spec #75). */
const FAUCET = "https://coinfaucet.eu/en/btc-testnet/";

/**
 * The jar's top-up QR code and address in 4 numbered steps (stories 13, 15), on the jar page and the
 * public record. Only the giver's jar page names it as step 4 of the journey.
 */
export function TopUpBox(props: { address: string; qrPayload: string; journeyStep?: boolean }) {
  const [qr, setQr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    // Drawn at twice its shown size (--qr-size) so it stays sharp on high-density screens.
    QRCode.toDataURL(props.qrPayload, { margin: 1, width: 440 }).then((url) => live && setQr(url));
    return () => {
      live = false;
    };
  }, [props.qrPayload]);
  return (
    <section className="panel">
      {props.journeyStep && <Step n={4} />}
      <h2>Top it up</h2>
      <ol className="top-up-steps">
        <li>
          Have the amount ready. No test Bitcoin?{" "}
          <a href={FAUCET} target="_blank" rel="noreferrer">
            Get some free from a faucet ↗
          </a>
        </li>
        <li>
          Scan the QR code or copy the address.
          {qr && <img className="qr" src={qr} alt="QR code of the jar's Bitcoin address" />}
          <p className="mono">{props.address}</p>
          <Copy text={props.address} label="Copy address" />
        </li>
        <li>Send a small amount first. Under 1,000 sats doesn't count.</li>
        <li>Wait for it to say Counted, usually 10–30 minutes. This page updates by itself.</li>
      </ol>
    </section>
  );
}
