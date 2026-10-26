import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentRef, type KeyboardEvent, type ReactNode } from 'react';
import Tooltip from 'antd/es/tooltip';

interface PlanUsageTooltipProps {
  tooltip: string;
  className: string;
  children: ReactNode;
}

/** Keep full usage details outside the input's clipping and zoom containers. */
export function PlanUsageTooltip({ tooltip, className, children }: PlanUsageTooltipProps) {
  const [open, setOpen] = useState(false);
  const summaryRef = useRef<HTMLDivElement>(null);
  const detailsRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<ComponentRef<typeof Tooltip>>(null);
  const [layout, setLayout] = useState<{ placement: 'top' | 'bottom'; maxHeight?: number }>({ placement: 'top' });

  const updateLayout = useCallback(() => {
    const rect = summaryRef.current?.getBoundingClientRect();
    if (!rect) return;
    const spaceAbove = rect.top;
    const spaceBelow = window.innerHeight - rect.bottom;
    const placement = spaceAbove >= spaceBelow ? 'top' : 'bottom';
    // Reserve room for the tooltip padding, arrow and viewport margin.
    const maxHeight = Math.max(32, Math.max(spaceAbove, spaceBelow) - 40);
    setLayout((current) => {
      if (current.placement === placement && current.maxHeight === maxHeight) return current;
      return { placement, maxHeight };
    });
    tooltipRef.current?.forceAlign();
  }, []);

  // Apply alignment again after a new placement or height limit reaches the DOM.
  useLayoutEffect(() => {
    if (open) tooltipRef.current?.forceAlign();
  }, [open, layout]);

  useEffect(() => {
    if (!open) return;
    window.addEventListener('resize', updateLayout);
    const observer = new ResizeObserver(updateLayout);
    const summary = summaryRef.current;
    if (summary) {
      observer.observe(summary);
      // Resizing the composer moves the anchor without resizing the summary itself.
      const composer = summary.closest('.chat-input-box');
      if (composer) observer.observe(composer);
    }
    return () => {
      window.removeEventListener('resize', updateLayout);
      observer.disconnect();
    };
  }, [open, updateLayout]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!open) return;
    if (event.key === 'Escape') {
      setOpen(false);
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const details = detailsRef.current;
    if (!details || event.altKey || event.ctrlKey || event.metaKey) return;
    // Keep focus on the summary so scrolling does not dismiss the focus-triggered tooltip.
    switch (event.key) {
      case 'ArrowUp':
        details.scrollTop -= 32;
        break;
      case 'ArrowDown':
        details.scrollTop += 32;
        break;
      case 'PageUp':
        details.scrollTop -= details.clientHeight;
        break;
      case 'PageDown':
        details.scrollTop += details.clientHeight;
        break;
      case 'Home':
        details.scrollTop = 0;
        break;
      case 'End':
        details.scrollTop = details.scrollHeight;
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <Tooltip
      ref={tooltipRef}
      title={<div ref={detailsRef} className="plan-usage-details" style={{ maxHeight: layout.maxHeight }}>{tooltip}</div>}
      trigger={['hover', 'focus']}
      placement={layout.placement}
      color="var(--dropdown-bg)"
      classNames={{ root: 'plan-usage-tooltip' }}
      styles={{ root: { maxWidth: 'min(340px, calc(100vw - 16px))' } }}
      mouseEnterDelay={0.15}
      mouseLeaveDelay={0.1}
      destroyOnHidden
      open={open}
      onOpenChange={(visible) => {
        if (visible) updateLayout();
        setOpen(visible);
      }}
    >
      <div
        ref={summaryRef}
        className={className}
        role="group"
        tabIndex={0}
        aria-label={tooltip}
        aria-keyshortcuts="ArrowUp ArrowDown PageUp PageDown Home End Escape"
        data-tooltip={tooltip}
        onKeyDown={handleKeyDown}
      >
        {children}
      </div>
    </Tooltip>
  );
}
