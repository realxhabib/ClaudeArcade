/**
 * Touch gestures inside the XApps frame.
 *
 * Mobile browsers turn drags into page scrolls, rubber-band bounces and
 * pull-to-refresh. The host page already switches overscroll off; these
 * helpers do the same inside your app, where the host can't reach.
 */

/**
 * Stops the app's own page from bouncing or chaining a drag to the host
 * (`overscroll-behavior: none` on `html` and `body`). Normal scrolling of
 * long pages still works. `connect()` calls this inside XApps unless
 * `gestures: false`.
 */
export function calmPage(doc: Document): void {
  doc.documentElement.style.overscrollBehavior = "none";
  if (doc.body) doc.body.style.overscrollBehavior = "none";
  else doc.addEventListener("DOMContentLoaded", () => doc.body && (doc.body.style.overscrollBehavior = "none"), { once: true });
}

/**
 * Makes `element` a drag surface (a canvas, a board, a slider): touches on it
 * never scroll, zoom, bounce or pull-to-refresh the page, and long-press
 * doesn't select text or open the callout. Uses `touch-action: none` plus
 * non-passive touch listeners, which iOS Safari needs (it ignores
 * `touch-action` alone mid-gesture). Pointer events keep working as usual.
 * Returns a function that undoes it.
 */
export function lockGestures(element: HTMLElement | null | undefined): () => void {
  if (!element) return () => {};
  const style = element.style as CSSStyleDeclaration & { webkitUserSelect?: string; webkitTouchCallout?: string };
  const before = {
    touchAction: style.touchAction,
    userSelect: style.userSelect,
    webkitUserSelect: style.webkitUserSelect,
    webkitTouchCallout: style.webkitTouchCallout,
  };
  style.touchAction = "none";
  style.userSelect = "none";
  style.webkitUserSelect = "none";
  style.webkitTouchCallout = "none";
  const block = (e: TouchEvent) => {
    if (e.cancelable) e.preventDefault();
  };
  element.addEventListener("touchstart", block, { passive: false });
  element.addEventListener("touchmove", block, { passive: false });
  return () => {
    element.removeEventListener("touchstart", block);
    element.removeEventListener("touchmove", block);
    style.touchAction = before.touchAction;
    style.userSelect = before.userSelect;
    style.webkitUserSelect = before.webkitUserSelect ?? "";
    style.webkitTouchCallout = before.webkitTouchCallout ?? "";
  };
}
