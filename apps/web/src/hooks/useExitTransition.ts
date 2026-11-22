import { useState, type TransitionEvent } from "react";

/** Whether the element is mid-way through a falling opacity transition, the one that ends a hold. */
export function isFadingOut(element: Element): boolean {
  return element.getAnimations().some((animation) => {
    if (!(animation instanceof CSSTransition) || animation.transitionProperty !== "opacity") {
      return false;
    }
    const keyframes =
      animation.effect instanceof KeyframeEffect ? animation.effect.getKeyframes() : [];
    return Number(keyframes.at(-1)?.opacity) < Number(keyframes[0]?.opacity);
  });
}

/**
 * Keeps the last value on screen after it goes away, marked `data-ending-style`, so theme CSS can
 * fade it out. Render `shown` and spread `exitProps` on the element whose opacity transition ends
 * the hold. Without such a transition the hold ends in the same commit. Pass `same` when the value
 * is built during render, so an equal one does not restart the hold.
 */
export function useExitTransition<T>(value: T | null, same: (a: T, b: T) => boolean = Object.is) {
  const [previous, setPrevious] = useState(value);
  const [held, setHeld] = useState<T | null>(null);
  const changed = previous === null || value === null ? previous !== value : !same(previous, value);
  if (changed) {
    setPrevious(value);
    setHeld(value === null ? previous : null);
  }
  const exiting = value === null && held !== null;
  return {
    shown: value ?? held,
    exiting,
    exitProps: {
      "data-ending-style": exiting ? "" : undefined,
      inert: exiting,
      // No opacity transition started (stock CSS, or cleared before a frame): no transitionend comes.
      ref: exiting
        ? (element: HTMLElement | null) => {
            if (element && !isFadingOut(element)) setHeld(null);
          }
        : undefined,
      onTransitionEnd: (event: TransitionEvent) => {
        if (exiting && event.target === event.currentTarget && event.propertyName === "opacity")
          setHeld(null);
      },
    },
  };
}
