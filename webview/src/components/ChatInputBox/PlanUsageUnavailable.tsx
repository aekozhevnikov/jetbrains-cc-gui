import type { TFunction } from 'i18next';
import { PlanUsageTooltip } from './PlanUsageTooltip';

interface PlanUsageUnavailableProps {
  tooltip: string;
  t: TFunction;
}

/** Fallback shown when no present usage data is available. */
export const PlanUsageUnavailable = ({ tooltip, t }: PlanUsageUnavailableProps) => (
  <PlanUsageTooltip
    className="plan-usage unavailable"
    tooltip={tooltip}
  >
    <span className="plan-usage-label">
      {t('chat.planUsage.dash', { defaultValue: 'Usage —' })}
    </span>
  </PlanUsageTooltip>
);
