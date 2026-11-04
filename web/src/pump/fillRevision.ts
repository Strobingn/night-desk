import { useEffect, useState } from "react";

let revision = 0;
const listeners = new Set<() => void>();

/** Journal and replay mount once. Import bumps this so they load the new fills. */
export function notifyFillsImported(): void {
  revision += 1;
  for (const listener of listeners) listener();
}

export function useFillRevision(): number {
  const [value, setValue] = useState(revision);
  useEffect(() => {
    const listener = () => setValue(revision);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return value;
}
