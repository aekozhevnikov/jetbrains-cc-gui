import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

interface ModelSearchRowProps {
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  /** Handles keyboard navigation (↑↓/Enter/Esc) on behalf of the dropdown. */
  onSearchKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  /** Clears the query; the × button. Absence hides the button. */
  onClearSearch?: () => void;
}

/**
 * ModelSearchRow - The sticky search input at the top of the model dropdown,
 * with a clear button while a query is active.
 */
export const ModelSearchRow = ({
  searchQuery,
  onSearchQueryChange,
  onSearchKeyDown,
  onClearSearch,
}: ModelSearchRowProps) => {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus on open — the row mounts together with the dropdown.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div className="selector-search-row selector-search-row--sticky">
      <input
        ref={inputRef}
        className="selector-search-input"
        data-testid="model-search-input"
        value={searchQuery}
        onChange={(event) => onSearchQueryChange(event.target.value)}
        onKeyDown={(e) => (onSearchKeyDown ? onSearchKeyDown(e) : e.stopPropagation())}
        placeholder={t('models.searchPlaceholder', { defaultValue: 'Search models' })}
        onClick={(e) => e.stopPropagation()}
      />
      {searchQuery && onClearSearch && (
        <button
          type="button"
          className="selector-search-clear"
          data-testid="model-search-clear"
          title={t('models.clearSearch', { defaultValue: 'Clear search' })}
          aria-label={t('models.clearSearch', { defaultValue: 'Clear search' })}
          // Keep the caret/focus inside the input when clicking the button.
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation();
            onClearSearch();
          }}
        >
          <span className="codicon codicon-close" />
        </button>
      )}
    </div>
  );
};

export default ModelSearchRow;
