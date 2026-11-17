import { useSyncExternalStore } from "react";

const darkQuery = "(prefers-color-scheme: dark)";

function subscribe(onChange: () => void) {
  const media = window.matchMedia(darkQuery);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

/** Tracks the OS colour scheme (false during server rendering). */
export function usePrefersDark(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(darkQuery).matches,
    () => false,
  );
}
