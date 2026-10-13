/* eslint style/indent: ['warn', 2], style/indent-binary-ops: ['warn', 2] -- 前端遵循两空格缩进，其余检查保持启用。 */
import { useEffect, useState } from 'react';
import type { ActivityStatus } from '../../types/status';
import { activityTiming } from '../lib/status-view';

export function Activity({ activity, compact = false }: { activity?: ActivityStatus | null, compact?: boolean }) {
  const [clock, setClock] = useState(() => ({ received: performance.now(), now: performance.now() }));
  useEffect(() => {
    const received = performance.now();
    setClock({ received, now: received });
    if (!activity?.busy) return undefined;
    const timer = setInterval(() => setClock({ received, now: performance.now() }), 1000);
    return () => clearInterval(timer);
  }, [activity]);
  if (!activity) return null;
  const elapsed = (activity.elapsedMs || 0) + clock.now - clock.received;
  if (compact && activity.busy && elapsed < 250) return null;
  return (
    <div
      className={compact ? 'waiting' : 'detail'}
      data-busy={activity.busy}
      data-delayed={activity.busy && elapsed > (activity.estimatedMaxMs ?? Infinity)}
      title={activity.hint || ''}
    >
      {compact ? (
        <div className="waiting-title" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          {activity.label}
        </div>
      ) : null}
      <p className="waiting-time" aria-live="off">
        {activityTiming(activity, elapsed)}
      </p>
    </div>
  );
}
