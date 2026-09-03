import { useEffect, useRef, useState, memo } from "react";

/**
 * ISOLATED call-duration ticker.
 *
 * WHY THIS COMPONENT EXISTS:
 * The duration used to live as `useState` inside `CallOverlay` with a
 * `setInterval(() => setDuration(d => d + 1), 1000)`. That re-rendered the
 * ENTIRE ~1500-line overlay tree — including the `<video>` elements and every
 * control — once per second, for the whole call. On Electron and lower-end
 * machines that main-thread churn competes with the video decoder and shows up
 * as micro-stutter in the remote tile.
 *
 * The mobile client already solved this exact problem (see the `<CallDuration/>`
 * comment in `mobile/app/call/[conversationId].tsx`); this is the web twin.
 * The 1s state update is now confined to this leaf, so the tick repaints a
 * single text node and nothing else.
 */

export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

interface CallDurationProps {
  /** Ticks only while true. Pass `status === "connected"`. */
  running: boolean;
  /** Optional wrapper class. */
  className?: string;
  /** Optional prefix, e.g. "On Hold · ". */
  prefix?: string;
  /**
   * Notified (at most once per second) with the current elapsed seconds, for
   * consumers that must mirror the duration outside React — the Electron PiP
   * window and the document-PiP clone. Deliberately a callback and NOT parent
   * state: routing it through `useState` in the overlay would reintroduce the
   * per-second full-tree re-render this component exists to remove.
   */
  onTick?: (seconds: number) => void;
}

function CallDurationImpl({
  running,
  className,
  prefix,
  onTick,
}: CallDurationProps) {
  const [seconds, setSeconds] = useState(0);
  // Keep the latest callback in a ref so changing it never restarts the timer.
  const onTickRef = useRef(onTick);
  onTickRef.current = onTick;
  // Anchor on a wall-clock start so the counter stays accurate even when the
  // tab is throttled in the background (setInterval callbacks get coalesced,
  // which used to make the displayed duration drift behind the real one).
  const startedAtRef = useRef<number | null>(null);

  useEffect(() => {
    if (!running) {
      startedAtRef.current = null;
      return;
    }
    if (startedAtRef.current === null) startedAtRef.current = Date.now();
    const tick = () => {
      const elapsed = Math.floor((Date.now() - startedAtRef.current!) / 1000);
      setSeconds((prev) => (prev === elapsed ? prev : elapsed));
      onTickRef.current?.(elapsed);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [running]);

  return (
    <span className={className}>
      {prefix}
      {formatDuration(seconds)}
    </span>
  );
}

const CallDuration = memo(CallDurationImpl);
export default CallDuration;
