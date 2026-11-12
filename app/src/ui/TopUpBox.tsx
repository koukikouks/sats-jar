import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { Copy } from "./Copy.tsx";

/** The jar's top-up QR code and address (stories 13, 15), on the jar page and the public record. */
export function TopUpBox(props: { address: string; qrPayload: string }) {
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
      <h2>Top up</h2>
      {qr && <img className="qr" src={qr} alt="QR code of the jar's Bitcoin address" />}
      <p className="mono">{props.address}</p>
      <Copy text={props.address} label="Copy address" />
      <p>
        Send Bitcoin to this address from any Bitcoin wallet. It counts once Bitcoin has confirmed it 3 times and Sats Jar has
        checked the proof, usually within two hours.
      </p>
    </section>
  );
}
