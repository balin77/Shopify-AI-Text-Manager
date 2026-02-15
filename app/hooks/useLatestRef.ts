import { useRef } from "react";

/**
 * Returns a ref that always holds the latest value.
 * Use this to read current state/props inside callbacks and effects
 * without adding them to dependency arrays.
 */
export function useLatestRef<T>(value: T): React.MutableRefObject<T> {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
