import { Component, Suspense, lazy, type ComponentType, type ReactNode } from 'react';
import { useTranslation } from '@/lib/i18n';
import { Button } from '@/components/ui/Button';
import { ErrorLine, LoadingLine, TabBody } from './parts';

/**
 * A section of the Agents tab is a script of its own, fetched the first time its tab is opened (OrchestratorTab). Fetching adds one failure:
 * the file cannot be had, because the page is older than the files the Hub serves now (a rebuilt UI replaces every hashed name) or the
 * connection dropped. Without a boundary a rejected import() unmounts the whole app, so that failure alone is caught here.
 */
export class SectionLoadError extends Error {
  // the minified build renames the class; a name that survives is what the console shows for this error
  name = 'SectionLoadError';
}

/** The module's named export as the default export that `lazy()` wants. A failed fetch becomes a SectionLoadError, so that it is not mistaken for a bug. */
export function loadSection<Name extends string>(load: () => Promise<Record<Name, ComponentType>>, name: Name) {
  return load().then(
    (module) => ({ default: module[name] }),
    (cause) => { throw new SectionLoadError('section_load', { cause }); },
  );
}

/** Call at module scope: a lazy component made while rendering would start over on every render and never finish. */
export function lazySection<Name extends string>(load: () => Promise<Record<Name, ComponentType>>, name: Name) {
  return lazy(() => loadSection(load, name));
}

/** The place of the section while its script is on the way: named like the section, with one status line. */
export function SectionLoading({ label }: { label: string }) {
  const { t } = useTranslation();
  return <TabBody label={label}><LoadingLine text={t('agents_section_loading')} /></TabBody>;
}

/** The script cannot be had: say so, and offer the one thing that helps (a reload brings the page the Hub serves now). */
export function SectionLoadFailed({ label }: { label: string }) {
  const { t } = useTranslation();
  return (
    <TabBody label={label}>
      <ErrorLine message={t('agents_section_failed')} />
      <Button onClick={() => window.location.reload()}>{t('agents_section_reload')}</Button>
    </TabBody>
  );
}

/** Shows the failure for a script that cannot be had. Any other error goes on up exactly as it did before the section was lazy. */
export class SectionBoundary extends Component<{ label: string; children: ReactNode }, { caught: boolean; error: unknown }> {
  state = { caught: false, error: undefined as unknown };
  static getDerivedStateFromError(error: unknown) { return { caught: true, error }; }
  render() {
    const { caught, error } = this.state;
    if (!caught) return this.props.children;
    if (!(error instanceof SectionLoadError)) throw error;
    return <SectionLoadFailed label={this.props.label} />;
  }
}

/** Around a lazy section: the loading line while its script is on the way, the failure view if it cannot be had. */
export function SectionLoader({ label, children }: { label: string; children: ReactNode }) {
  return (
    <SectionBoundary label={label}>
      <Suspense fallback={<SectionLoading label={label} />}>{children}</Suspense>
    </SectionBoundary>
  );
}
