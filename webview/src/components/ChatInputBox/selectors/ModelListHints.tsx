import { useTranslation } from 'react-i18next';

interface ModelListHintsProps {
  loading: boolean;
  visibleModelCount: number;
  hiddenModelCount: number;
  /** Active search text; the empty message echoes it when set. */
  searchQuery?: string;
}

/**
 * ModelListHints - The trailing hints of the model dropdown: the empty-result
 * message and the hidden-model-count line.
 */
export const ModelListHints = ({
  loading,
  visibleModelCount,
  hiddenModelCount,
  searchQuery,
}: ModelListHintsProps) => {
  const { t } = useTranslation();

  return (
    <>
      {visibleModelCount === 0 && !loading && (
        <div className="selector-option selector-option-status" data-testid="model-no-results">
          {searchQuery
            ? t('models.noSearchMatches', { query: searchQuery, defaultValue: `No models match "${searchQuery}"` })
            : t('models.noModelsFound', { defaultValue: 'No models found' })}
        </div>
      )}
      {hiddenModelCount > 0 && (
        <div className="selector-option selector-option-status" data-testid="model-hidden-count">
          {t('models.hiddenModelCount', {
            count: hiddenModelCount,
            defaultValue: `+ ${hiddenModelCount} more models. Type to search.`,
          })}
        </div>
      )}
    </>
  );
};

export default ModelListHints;
