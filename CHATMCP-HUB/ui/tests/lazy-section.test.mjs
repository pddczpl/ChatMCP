import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { bundleTsx, renderPrelude } from './support/bundle.mjs';
import { parseHtml, byTag, byRole, accessibleName, all } from './support/html.mjs';

// What happens around a section whose script is fetched when its tab is opened: the loading line, and the one failure that fetching adds
// (the file cannot be had: the page is older than the Hub that serves it, or the connection dropped). Server rendering never runs an error
// boundary, so the boundary is exercised here by giving it the state React would give it; tests/agents-lazy.test.mjs does the switch itself and
// e2e/agents-lazy.spec.mjs catches a real failed fetch in a real browser.
const { loaded, dispose } = await bundleTsx(`
  ${renderPrelude}
  import React from 'react';
  import { SectionBoundary, SectionLoadError, SectionLoadFailed, SectionLoading, loadSection } from './src/components/inspector/LazySection';
  import { translations } from './src/lib/i18n';
  export { React, SectionBoundary, SectionLoadError, SectionLoadFailed, SectionLoading, loadSection, translations };
`, 'chatmcp-lazy-section-');
after(dispose);
const { renderWith, React, SectionBoundary, SectionLoadError, SectionLoadFailed, SectionLoading, loadSection, translations } = loaded;
const VIETNAMESE = /[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/i;

test('a script that cannot be fetched is told apart from every other error, and keeps its cause', async () => {
  const cause = new TypeError('Failed to fetch dynamically imported module');
  await assert.rejects(loadSection(() => Promise.reject(cause), 'Section'), (error) => error instanceof SectionLoadError && error.cause === cause);
  const Section = () => null;
  assert.deepEqual(await loadSection(() => Promise.resolve({ Section, Other: () => null }), 'Section'), { default: Section }, 'the named export becomes the default one');
});

test('the loading line and the failure each carry the section’s name, say it in the language on screen and hold no raw key', async () => {
  for (const [lang, label] of [['vi', 'Nhóm trợ lý'], ['en', 'Agent groups']]) {
    const loading = parseHtml(await renderWith(SectionLoading, { label }, [], [], { lang }));
    const status = byRole(loading, 'status');
    assert.equal(status.length, 1, `${lang}: one status line`);
    assert.equal(status[0].text, translations[lang].agents_section_loading);
    assert.equal(all(loading).find((node) => node.tag === 'section').attrs['aria-label'], label, `${lang}: the region is named like the section it stands in for`);

    const failed = parseHtml(await renderWith(SectionLoadFailed, { label }, [], [], { lang }));
    const alerts = byRole(failed, 'alert');
    assert.equal(alerts.length, 1, `${lang}: one alert`);
    assert.equal(alerts[0].text, translations[lang].agents_section_failed);
    const buttons = byTag(failed, 'button');
    assert.deepEqual(buttons.map((button) => accessibleName(failed, button)), [translations[lang].agents_section_reload], `${lang}: reloading is the way out`);
    assert.equal(all(failed).find((node) => node.tag === 'section').attrs['aria-label'], label);
    for (const text of [loading.text, failed.text]) assert.doesNotMatch(text, /\bagents?_[a-z_]+\b/, `${lang}: a dictionary key was shown instead of text`);
    if (lang === 'en') for (const text of [loading.text, failed.text]) assert.doesNotMatch(text, VIETNAMESE);
  }
});

test('the boundary shows the failure for a script that cannot be fetched and lets a bug through, so a bug is not mistaken for a bad connection', async () => {
  const children = React.createElement('p', null, 'the section');
  const boundaryFor = (error) => {
    const boundary = new SectionBoundary({ label: 'Sửa mã', children });
    boundary.state = error === undefined ? boundary.state : SectionBoundary.getDerivedStateFromError(error);
    return boundary;
  };
  assert.equal(boundaryFor().render(), children, 'with nothing wrong it only passes the section through');
  const Probe = ({ boundary }) => boundary.render();
  const shown = parseHtml(await renderWith(Probe, { boundary: boundaryFor(new SectionLoadError('section_load')) }));
  assert.equal(byRole(shown, 'alert').length, 1);
  assert.equal(byTag(shown, 'button').length, 1);
  assert.throws(() => boundaryFor(new RangeError('a render bug')).render(), /a render bug/);
  assert.throws(() => boundaryFor(new TypeError('Failed to fetch dynamically imported module')).render(), /Failed to fetch/, 'the bare browser error is not a SectionLoadError: only a failed import() is');
});
