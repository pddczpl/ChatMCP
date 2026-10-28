import { hasHidden, splitHidden } from '@/lib/hidden-chars';
import { useTranslation } from '@/lib/i18n';

/**
 * Text with the characters that cannot be seen (direction overrides, zero-width marks, control characters) shown as visible markers such as
 * ‹U+202E›. Plain text comes back as it is. The marker replaces the character, so its effect on the reading order is gone as well.
 */
export function HiddenText({ text }: { text: string }) {
  if (!hasHidden(text)) return <>{text}</>;
  return (
    <>
      {splitHidden(text).map((part, index) => ('text' in part
        ? part.text
        : <span key={index} data-hidden={part.hidden} className="rounded-sm bg-warning/20 px-0.5 font-mono text-warning">{`‹${part.hidden}›`}</span>))}
    </>
  );
}

/** The line under a text that holds such characters, saying what the markers are. */
export function HiddenNote({ show }: { show: boolean }) {
  const { t } = useTranslation();
  return show ? <p className="text-[12px] leading-4 text-warning">{t('agent_hidden_chars_note')}</p> : null;
}
