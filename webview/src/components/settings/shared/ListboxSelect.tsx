import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { FocusEvent as ReactFocusEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import styles from './listbox-select.module.less';

export interface ListboxSelectOption {
  value: string;
  label: string;
}

interface ListboxSelectProps {
  value: string;
  options: ListboxSelectOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  /** Forwarded to the trigger so an external <label htmlFor> still labels the control. */
  id?: string;
  disabled?: boolean;
  /** Pin the menu side; by default the side with room is picked on open. */
  placement?: 'down' | 'up';
}

/** Keep the row height and menu max-height in sync with listbox-select.module.less. */
const MENU_ROW_HEIGHT = 34;
const MENU_MAX_HEIGHT = 280;
/** Keystrokes within this window extend the typeahead buffer instead of restarting it. */
const TYPEAHEAD_RESET_MS = 500;

/**
 * Shared DOM listbox for the settings panels.
 *
 * Native <select> is not usable here: its popup is a separate CEF/Chromium window,
 * which JCEF fails to create on the first browser instance after a fresh install
 * (the very first click after reinstalling the plugin is swallowed and only an IDE
 * restart recovers it), and any CSS zoom write on an ancestor dismisses it. A DOM
 * listbox keeps the options inside the page, so it is always clickable.
 *
 * Same pattern as AiFeatureProviderModelPanel/FeatureSelect and DependencySection
 * /VersionSelect; this one is shared because the BasicConfigSection appearance
 * controls need an explicit up/down menu placement.
 *
 * Keyboard support mirrors the native control it replaces: ArrowDown opens the
 * menu and moves focus into it, ArrowUp/Down/Home/End move between options,
 * printable characters jump by label prefix, Escape closes and refocuses the
 * trigger, and selecting an option returns focus to the trigger.
 */
const ListboxSelect = ({
  value,
  options,
  onChange,
  ariaLabel,
  id,
  disabled = false,
  placement,
}: ListboxSelectProps) => {
  const [open, setOpen] = useState(false);
  const [resolvedPlacement, setResolvedPlacement] = useState<'down' | 'up'>(placement ?? 'down');
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxId = useId();
  const focusSelectedOnOpenRef = useRef(false);
  const typeaheadRef = useRef<{ text: string; at: number }>({ text: '', at: 0 });
  const selectedLabel = options.find((option) => option.value === value)?.label ?? value;

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const handleDocumentMouseDown = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    document.addEventListener('mousedown', handleDocumentMouseDown);
    return () => document.removeEventListener('mousedown', handleDocumentMouseDown);
  }, [open]);

  useEffect(() => {
    if (disabled) {
      setOpen(false);
    }
  }, [disabled]);

  // Measure before paint so the menu never flashes on the wrong side.
  useLayoutEffect(() => {
    if (!open) {
      return;
    }
    if (placement) {
      setResolvedPlacement(placement);
      return;
    }
    const trigger = triggerRef.current;
    if (!trigger) {
      return;
    }
    // getBoundingClientRect() and innerHeight are both viewport-space here, so the
    // comparison stays valid under the #app CSS zoom used for font scaling.
    const rect = trigger.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    const wanted = Math.min(options.length * MENU_ROW_HEIGHT + 8, MENU_MAX_HEIGHT);
    setResolvedPlacement(spaceBelow < wanted && spaceAbove > spaceBelow ? 'up' : 'down');
  }, [open, options.length, placement]);

  const getOptionElements = useCallback(
    () => Array.from(wrapRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? []),
    [],
  );

  // Move focus into the menu only when it was opened from the keyboard.
  useLayoutEffect(() => {
    if (!focusSelectedOnOpenRef.current) {
      return;
    }
    focusSelectedOnOpenRef.current = false;
    if (!open) {
      return;
    }
    const elements = getOptionElements();
    if (elements.length === 0) {
      return;
    }
    const selectedIndex = elements.findIndex((el) => el.getAttribute('aria-selected') === 'true');
    elements[selectedIndex >= 0 ? selectedIndex : 0].focus();
  }, [open, getOptionElements]);

  const focusOptionAt = useCallback((index: number) => {
    const elements = getOptionElements();
    if (elements.length > 0) {
      elements[(index + elements.length) % elements.length].focus();
    }
  }, [getOptionElements]);

  const closeAndRefocus = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (disabled) {
      return;
    }
    switch (event.key) {
      case 'Escape':
        if (open) {
          event.stopPropagation();
          closeAndRefocus();
        }
        return;
      case 'ArrowDown': {
        event.preventDefault();
        if (!open) {
          focusSelectedOnOpenRef.current = true;
          setOpen(true);
          return;
        }
        const current = getOptionElements().findIndex((el) => el === document.activeElement);
        focusOptionAt(current < 0 ? 0 : current + 1);
        return;
      }
      case 'ArrowUp': {
        if (!open) {
          return;
        }
        event.preventDefault();
        const elements = getOptionElements();
        const current = elements.findIndex((el) => el === document.activeElement);
        focusOptionAt(current < 0 ? elements.length - 1 : current - 1);
        return;
      }
      case 'Home':
        if (open) {
          event.preventDefault();
          focusOptionAt(0);
        }
        return;
      case 'End':
        if (open) {
          event.preventDefault();
          focusOptionAt(getOptionElements().length - 1);
        }
        return;
      default:
        // Typeahead: jump to the first option whose label starts with the buffer.
        if (open && event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
          const now = Date.now();
          const buffer = now - typeaheadRef.current.at < TYPEAHEAD_RESET_MS
            ? typeaheadRef.current.text + event.key
            : event.key;
          typeaheadRef.current = { text: buffer, at: now };
          const lower = buffer.toLowerCase();
          const match = options.findIndex((option) => option.label.toLowerCase().startsWith(lower));
          if (match >= 0) {
            focusOptionAt(match);
          }
        }
    }
  };

  const handleBlur = (event: ReactFocusEvent<HTMLDivElement>) => {
    // Tabbing away closes the menu; clicks on non-focusable areas outside are
    // covered by the document mousedown listener above.
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setOpen(false);
    }
  };

  return (
    <div className={styles.wrap} ref={wrapRef} onKeyDown={handleKeyDown} onBlur={handleBlur}>
      <button
        type="button"
        id={id}
        ref={triggerRef}
        className={`${styles.trigger} ${open ? styles.open : ''}`}
        onClick={() => setOpen((prev) => !prev)}
        disabled={disabled}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-label={ariaLabel}
      >
        <span className={styles.value}>{selectedLabel}</span>
        <span className={`codicon codicon-chevron-down ${styles.arrow}`} aria-hidden="true" />
      </button>

      {open && (
        <div
          id={listboxId}
          className={`${styles.menu} ${resolvedPlacement === 'up' ? styles.menuUp : styles.menuDown}`}
          role="listbox"
          aria-label={ariaLabel}
        >
          {options.map((option) => {
            const selected = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={selected}
                className={`${styles.option} ${selected ? styles.selected : ''}`}
                onClick={() => {
                  onChange(option.value);
                  // Return focus to the trigger like a native <select> does —
                  // unmounting the focused option would otherwise drop focus to body.
                  closeAndRefocus();
                }}
              >
                <span className={styles.optionLabel}>{option.label}</span>
                {selected && <span className="codicon codicon-check" aria-hidden="true" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default ListboxSelect;
