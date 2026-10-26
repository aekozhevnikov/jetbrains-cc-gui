import type { TFunction } from 'i18next';
import { PlanUsageTooltip } from './PlanUsageTooltip';

interface PlanUsageLoadingProps {
  t: TFunction;
}

/** Loading placeholder shown while usage is being fetched. */
export const PlanUsageLoading = ({ t }: PlanUsageLoadingProps) => {
  const label = t('chat.planUsage.loading', { defaultValue: 'Loading usage…' });
  return (
    <PlanUsageTooltip
      className="plan-usage loading"
      tooltip={label}
    >
      <span className="plan-usage-label">…</span>
    </PlanUsageTooltip>
  );
};
