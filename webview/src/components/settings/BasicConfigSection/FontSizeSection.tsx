import styles from './style.module.less';
import { useTranslation } from 'react-i18next';
import ListboxSelect from '../shared/ListboxSelect';

interface FontSizeSectionProps {
  fontSizeLevel: number;
  onFontSizeLevelChange: (level: number) => void;
}

const FontSizeSection = ({ fontSizeLevel, onFontSizeLevelChange }: FontSizeSectionProps) => {
  const { t } = useTranslation();

  const fontSizeOptions = [
    { value: '1', label: t('settings.basic.fontSize.level1') },
    { value: '2', label: t('settings.basic.fontSize.level2') },
    { value: '3', label: t('settings.basic.fontSize.level3') },
    { value: '4', label: t('settings.basic.fontSize.level4') },
    { value: '5', label: t('settings.basic.fontSize.level5') },
    { value: '6', label: t('settings.basic.fontSize.level6') },
  ];

  return (
    <div className={styles.fontSizeSection}>
      <div className={styles.fieldHeader}>
        <span className="codicon codicon-text-size" />
        <span className={styles.fieldLabel}>{t('settings.basic.fontSize.label')}</span>
      </div>
      <ListboxSelect
        value={String(fontSizeLevel)}
        options={fontSizeOptions}
        onChange={(value) => onFontSizeLevelChange(Number(value))}
        ariaLabel={t('settings.basic.fontSize.label')}
      />
    </div>
  );
};

export default FontSizeSection;
