import { useEffect, useState } from 'react';

const STEPS = ['가게 고르는 중', '동선 짜는 중', '걷는 길 확인 중'];
// When each step shows (ms after the request started); quick answers never show the bar at all.
const AT = [300, 700, 1300];

/**
 * Planning takes 0.3-2 s: a short step list instead of a frozen button. It follows elapsed time (the API answers in
 * one go), so it only says what is happening in order, never a fake percentage.
 */
export function PlanProgress({ active }: { active: boolean }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!active) {
      setElapsed(0);
      return;
    }
    const t0 = performance.now();
    const id = setInterval(() => setElapsed(performance.now() - t0), 100);
    return () => clearInterval(id);
  }, [active]);
  if (!active || elapsed < AT[0]) return null;
  const step = AT.filter((t) => elapsed >= t).length - 1;
  return (
    <ol className="plan-progress" role="status" aria-live="polite">
      {STEPS.map((label, i) => (
        <li key={label} className={i < step ? 'is-done' : i === step ? 'is-now' : ''}>
          {label}
        </li>
      ))}
    </ol>
  );
}
