import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

interface DismissibleLayerOptions {
  returnFocusRef?: RefObject<HTMLElement>;
  trapFocus?: boolean;
  focusOnOpen?: boolean;
}

/**
 * Adds the keyboard and outside-click behaviour shared by menus and dialogs.
 * The caller owns rendering, so the same behaviour works for anchored menus,
 * modal dialogs, and portalled side panels without another UI dependency.
 */
export function useDismissibleLayer<T extends HTMLElement>(
  open: boolean,
  onClose: () => void,
  options: DismissibleLayerOptions = {},
): RefObject<T> {
  const layerRef = useRef<T>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const layer = layerRef.current;
    if (!layer) return;

    const { returnFocusRef, trapFocus = true, focusOnOpen = true } = options;
    const focusables = () =>
      Array.from(layer.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (element) =>
          !element.hidden &&
          element.getAttribute("aria-hidden") !== "true" &&
          element.getClientRects().length > 0,
      );

    const frame = focusOnOpen
      ? requestAnimationFrame(() => {
          const preferred = layer.querySelector<HTMLElement>("[data-autofocus]");
          (preferred ?? focusables()[0] ?? layer).focus();
        })
      : 0;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target || layer.contains(target) || returnFocusRef?.current?.contains(target)) return;
      closeRef.current();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
        requestAnimationFrame(() => returnFocusRef?.current?.focus());
        return;
      }
      if (!trapFocus || event.key !== "Tab") return;
      const items = focusables();
      if (!items.length) {
        event.preventDefault();
        layer.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !layer.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, options.focusOnOpen, options.returnFocusRef, options.trapFocus]);

  return layerRef;
}
