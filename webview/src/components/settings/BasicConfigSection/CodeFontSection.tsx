import { useState, useEffect } from 'react';
import styles from './style.module.less';
import { useTranslation } from 'react-i18next';
import type { CodeFontConfig } from '../hooks/useSettingsBasicActions';
import ListboxSelect from '../shared/ListboxSelect';

const CODE_FONT_SELECT_ID = 'settings-code-font-select';
const CODE_FONT_CUSTOM_PATH_ID = 'settings-code-font-custom-path';

const NODE_PATH_SECTION_STYLE: React.CSSProperties = { marginTop: 12 };

interface CodeFontSectionProps {
  codeFontConfig?: CodeFontConfig;
  editorFontConfig?: {
    fontFamily: string;
    fontSize: number;
    lineSpacing: number;
  };
  onCodeFontSelectionChange: (selection: string) => void;
  onSaveCodeFontCustomPath: (path: string) => void;
  onBrowseCodeFontFile: () => void;
}

const CodeFontSection = ({
  codeFontConfig,
  editorFontConfig,
  onCodeFontSelectionChange,
  onSaveCodeFontCustomPath,
  onBrowseCodeFontFile,
}: CodeFontSectionProps) => {
  const { t } = useTranslation();
  const [selectedCodeFontOption, setSelectedCodeFontOption] = useState(() => {
    if (!codeFontConfig || codeFontConfig.mode === 'followEditor') return 'followEditor';
    return 'customFile';
  });
  const [customCodeFontPathDraft, setCustomCodeFontPathDraft] = useState(codeFontConfig?.customFontPath || '');

  useEffect(() => {
    if (!codeFontConfig || codeFontConfig.mode === 'followEditor') {
      setSelectedCodeFontOption('followEditor');
    } else {
      setSelectedCodeFontOption('customFile');
    }
    setCustomCodeFontPathDraft(codeFontConfig?.customFontPath || '');
  }, [codeFontConfig]);

  const hasSavedCustomCodeFont = Boolean(codeFontConfig?.customFontPath);
  const isCustomCodeFontSelected = selectedCodeFontOption === 'customFile';
  const isCustomCodePathEmpty = customCodeFontPathDraft.trim().length === 0;
  const currentCodeFontDisplayName = codeFontConfig?.displayName || editorFontConfig?.fontFamily || '-';
  const customCodeFontFileName = codeFontConfig?.customFontPath
    ? codeFontConfig.customFontPath.split(/[\\/]/).pop()
    : '';
  const localizedCodeFontWarning = codeFontConfig?.warningCode === 'fontUnavailable'
    ? t('settings.basic.codeFont.warningUnavailable')
    : codeFontConfig?.warning;
  const codeFontHint = localizedCodeFontWarning
    || (codeFontConfig?.effectiveMode === 'customFile'
      ? t('settings.basic.codeFont.statusCustom', { font: currentCodeFontDisplayName })
      : t('settings.basic.codeFont.statusFollowEditor', {
        font: editorFontConfig?.fontFamily || currentCodeFontDisplayName,
      }));

  const handleCodeFontSelectionChange = (nextSelection: string) => {
    setSelectedCodeFontOption(nextSelection);

    if (nextSelection === 'customFile' && hasSavedCustomCodeFont) {
      onCodeFontSelectionChange(nextSelection);
      return;
    }

    if (nextSelection === 'followEditor') {
      onCodeFontSelectionChange(nextSelection);
    }
  };

  return (
    <div className={styles.editorFontSection}>
      <div className={styles.fieldHeader}>
        <span className="codicon codicon-code" />
        <label className={styles.fieldLabel} htmlFor={CODE_FONT_SELECT_ID}>
          {t('settings.basic.codeFont.label')}
        </label>
      </div>
      <ListboxSelect
        id={CODE_FONT_SELECT_ID}
        ariaLabel={t('settings.basic.codeFont.label')}
        value={selectedCodeFontOption}
        options={[
          {
            value: 'followEditor',
            label: t('settings.basic.codeFont.followOption', { font: editorFontConfig?.fontFamily || '-' }),
          },
          {
            value: 'customFile',
            label: customCodeFontFileName
              ? `${t('settings.basic.codeFont.customOption')} / ${customCodeFontFileName}`
              : t('settings.basic.codeFont.customOption'),
          },
        ]}
        onChange={handleCodeFontSelectionChange}
      />

      {isCustomCodeFontSelected && (
        <div className={styles.nodePathSection} style={NODE_PATH_SECTION_STYLE}>
          <div className={styles.fieldHeader}>
            <span className="codicon codicon-file-media" />
            <label className={styles.fieldLabel} htmlFor={CODE_FONT_CUSTOM_PATH_ID}>
              {t('settings.basic.codeFont.customPathLabel')}
            </label>
          </div>
          <div className={styles.nodePathInputWrapper}>
            <input
              id={CODE_FONT_CUSTOM_PATH_ID}
              type="text"
              className={styles.nodePathInput}
              placeholder={t('settings.basic.codeFont.customPathPlaceholder')}
              value={customCodeFontPathDraft}
              onChange={(event) => setCustomCodeFontPathDraft(event.target.value)}
            />
            <button
              type="button"
              className={styles.saveBtn}
              onClick={onBrowseCodeFontFile}
              aria-label={t('settings.basic.codeFont.browse')}
              title={t('settings.basic.codeFont.browse')}
            >
              <span className="codicon codicon-folder-opened" />
            </button>
            <button
              type="button"
              className={styles.saveBtn}
              onClick={() => onSaveCodeFontCustomPath(customCodeFontPathDraft.trim())}
              disabled={isCustomCodePathEmpty}
            >
              {t('common.save')}
            </button>
          </div>
        </div>
      )}

      <small className={styles.formHint}>
        <span className="codicon codicon-info" />
        <span>{codeFontHint}</span>
      </small>
    </div>
  );
};

export default CodeFontSection;
