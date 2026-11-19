// Guests refresh on returning to the page, never on an interval.
export function listenForGuestReturn(
  target: EventTarget,
  visibility: EventTarget & { readonly visibilityState: string },
  refresh: () => void,
) {
  const onReturn = () => { if (visibility.visibilityState !== "hidden") refresh(); };
  target.addEventListener("focus", onReturn);
  visibility.addEventListener("visibilitychange", onReturn);
  return () => {
    target.removeEventListener("focus", onReturn);
    visibility.removeEventListener("visibilitychange", onReturn);
  };
}
