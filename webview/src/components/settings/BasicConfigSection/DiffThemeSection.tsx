import styles from './style.module.less';
import { useTranslation } from 'react-i18next';
import type { DiffThemeMode } from '../../../utils/diffTheme';
import ListboxSelect from '../shared/ListboxSelect';

interface DiffThemeSectionProps {
  diffTheme: DiffThemeMode;
  onDiffThemeChange: (theme: DiffThemeMode) => void;
}

const DiffThemeSection = ({ diffTheme, onDiffThemeChange }: DiffThemeSectionProps) => {
  const { t } = useTranslation();

  const diffThemeOptions = [
    {
      value: 'follow',
      label: `${t('settings.basic.diffTheme.follow')} — ${t('settings.basic.diffTheme.followDesc')}`,
    },
    {
      value: 'editor',
      label: `${t('settings.basic.diffTheme.editor')} — ${t('settings.basic.diffTheme.editorDesc')}`,
    },
    {
      value: 'light',
      label: `${t('settings.basic.diffTheme.light')} — ${t('settings.basic.diffTheme.lightDesc')}`,
    },
    {
      value: 'soft-dark',
      label: `${t('settings.basic.diffTheme.softDark')} — ${t('settings.basic.diffTheme.softDarkDesc')}`,
    },
  ];

  return (
    <div className={styles.themeSection}>
      <div className={styles.fieldHeader}>
        <span className="codicon codicon-diff" />
        <span className={styles.fieldLabel}>{t('settings.basic.diffTheme.label')}</span>
      </div>

      <ListboxSelect
        value={diffTheme}
        options={diffThemeOptions}
        onChange={(value) => onDiffThemeChange(value as DiffThemeMode)}
        ariaLabel={t('settings.basic.diffTheme.label')}
      />
    </div>
  );
};

export default DiffThemeSection;
