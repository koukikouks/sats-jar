import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSdk } from "../services.tsx";

const KEY = ["device"] as const;

/** This device's state ("new", "locked", "unlocked"), and a way to re-read it after a change. */
export function useDevice() {
  const sdk = useSdk();
  const client = useQueryClient();
  const query = useQuery({ queryKey: KEY, queryFn: () => sdk.device.state() });
  // A change of device state changes what every screen may read, so re-read everything.
  const changed = () => client.invalidateQueries();
  return { state: query.data, changed };
}
