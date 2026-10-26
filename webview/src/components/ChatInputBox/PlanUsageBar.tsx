import type { MouseEvent } from 'react';
import type { TFunction } from 'i18next';
import type { PaceColor } from '../../utils/planUsagePace';
import { PlanUsageTooltip } from './PlanUsageTooltip';
import { formatPlanUsagePercent } from './planUsageView';

interface PlanUsageBarProps {
  tooltip: string;
  color: PaceColor;
  tp: number;
  canSwitch: boolean;
  winLabel: string;
  onCycleWindow: (e: MouseEvent) => void;
  worstColor: PaceColor;
  t: TFunction;
}

/** Compact summary: mini progress bar + % + window switcher + worst dot. */
export const PlanUsageBar = ({
  tooltip,
  color,
  tp,
  canSwitch,
  winLabel,
  onCycleWindow,
  worstColor,
  t,
}: PlanUsageBarProps) => {
  const fillWidth = `${tp}%`;
  const labelPct = formatPlanUsagePercent(tp);

  return (
    <PlanUsageTooltip
      className={`plan-usage pace-${color}`}
      tooltip={tooltip}
    >
      <div className="plan-usage-bar" aria-hidden>
        <div className="plan-usage-fill" style={{ width: fillWidth }} />
      </div>
      <span className="plan-usage-pct">{labelPct}</span>
      {canSwitch || winLabel !== '·' ? (
        <button
          type="button"
          className={`plan-usage-window${canSwitch ? ' switchable' : ''}`}
          onClick={onCycleWindow}
          disabled={!canSwitch}
          aria-label={
            canSwitch
              ? t('chat.planUsage.clickToSwitch', {
                defaultValue: 'Click to switch between windows',
              })
              : undefined
          }
        >
          {winLabel}
        </button>
      ) : null}
      {/* Worst pace across all windows. Details are in the shared tooltip. */}
      <span
        className={`plan-usage-worst-dot pace-${worstColor}`}
        aria-hidden
      />
    </PlanUsageTooltip>
  );
};
