// Bitcoin's Base58Check: base58 of the payload and the first 4 bytes of its double SHA-256.
import { baseDecode, baseEncode } from "near-api-js";

async function checksum(payload: Uint8Array): Promise<Uint8Array> {
  const once = await crypto.subtle.digest("SHA-256", Uint8Array.from(payload));
  return new Uint8Array(await crypto.subtle.digest("SHA-256", once)).slice(0, 4);
}

export const base58check = {
  async encode(payload: Uint8Array): Promise<string> {
    return baseEncode(Uint8Array.from([...payload, ...(await checksum(payload))]));
  },

  /** The payload, or null when the text is not base58 or its checksum does not match. */
  async decode(text: string): Promise<Uint8Array | null> {
    let bytes: Uint8Array;
    try {
      bytes = baseDecode(text.trim());
    } catch {
      return null;
    }
    if (bytes.length < 5) return null;
    const payload = bytes.slice(0, -4);
    const expected = await checksum(payload);
    return expected.every((b, i) => b === bytes[bytes.length - 4 + i]) ? payload : null;
  },
};
