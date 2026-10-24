import { Globe, Languages, Moon, Palette, Sun } from 'lucide-react';
import { useAppStore, type Theme } from '@/store/useAppStore';
import { useTranslation } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { SettingsCard } from './SettingsCard';

const choice = (selected: boolean) => cn(
  'flex h-10 items-center justify-center gap-2 rounded-lg border text-[13px] transition-colors',
  selected ? 'border-primary bg-primary/10 font-semibold text-primary' : 'border-line bg-surface text-muted hover:border-line-strong hover:bg-hover hover:text-fg',
);

/** Theme and language. */
export function AppearanceSection() {
  const { theme, setTheme, lang, setLang, showToast } = useAppStore();
  const { t } = useTranslation();
  const themes: Array<{ id: Theme; label: string; icon: typeof Moon }> = [
    { id: 'dark', label: t('theme_dark'), icon: Moon },
    { id: 'light', label: t('theme_light'), icon: Sun },
    { id: 'system', label: t('theme_system'), icon: Globe },
  ];

  return (
    <div className="space-y-5">
      <SettingsCard icon={Palette} title={t('theme_label')} description={t('appear_theme_desc')}>
        <div className="grid grid-cols-3 gap-2" role="group" aria-label={t('theme_label')}>
          {themes.map(({ id, label, icon: Icon }) => (
            <button key={id} type="button" aria-pressed={theme === id} onClick={() => setTheme(id)} className={choice(theme === id)}>
              <Icon className="h-3.5 w-3.5" />
              <span>{label}</span>
            </button>
          ))}
        </div>
      </SettingsCard>

      <SettingsCard icon={Languages} title={t('lang_label')} description={t('appear_lang_desc')}>
        <div className="grid grid-cols-2 gap-2" role="group" aria-label={t('lang_label')}>
          <button type="button" aria-pressed={lang === 'vi'} className={choice(lang === 'vi')}
            onClick={() => { setLang('vi'); showToast('Đã chuyển ngôn ngữ sang Tiếng Việt', 'info'); }}>
            {t('lang_vi')}
          </button>
          <button type="button" aria-pressed={lang === 'en'} className={choice(lang === 'en')}
            onClick={() => { setLang('en'); showToast('Switched language to English', 'info'); }}>
            {t('lang_en')}
          </button>
        </div>
      </SettingsCard>
    </div>
  );
}
