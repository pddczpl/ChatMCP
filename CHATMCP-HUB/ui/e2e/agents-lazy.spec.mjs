import { test, expect, onboard, openWorkTab } from './fixtures.mjs';

// The two delegation sections of the Agents tab (agent groups, code edits) are scripts fetched when their tab is opened. The unit tests cannot
// show that (a server render never fetches anything, and the bundler they use inlines it), so this runs the real Vite build in a real browser
// under the Hub's real Content-Security-Policy.

/** Every script the page fetches from the Hub's /assets/, in order, with the status the Hub answered. */
function watchScripts(page) {
  const scripts = [];
  page.on('response', (response) => {
    const { pathname } = new URL(response.url());
    if (/^\/assets\/[^/]+\.js$/.test(pathname)) scripts.push({ file: pathname.split('/').pop(), status: response.status() });
  });
  return scripts;
}

/** Records what the browser's Content-Security-Policy refuses on the page, from the first script on. */
const watchPolicy = (page) => page.addInitScript(() => {
  window.__refused = [];
  document.addEventListener('securitypolicyviolation', (event) => window.__refused.push(`${event.violatedDirective} ${event.blockedURI}`));
});

const section = (page, name) => page.getByRole('tab', { name, exact: true });

/** The strings only the sections ask for arrive with their script: once a section is on screen it speaks in words, never in dictionary keys. */
const RAW_KEY = /\b(?:agent|agents|group|coding)_[a-z_]+\b/;
async function expectWords(page, name) {
  const html = await page.getByRole('tabpanel', { name }).evaluate((panel) => panel.outerHTML);
  expect(html, `${name}: a dictionary key is shown instead of its words`).not.toMatch(RAW_KEY);
}

test('the sections are fetched when their tab is opened and not before, each only once, and the Content-Security-Policy refuses nothing', async ({ page, app }) => {
  const scripts = watchScripts(page);
  await watchPolicy(page);
  await onboard(page, app);
  await openWorkTab(page, 'Tác nhân');
  await expect(section(page, 'Công việc nền')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel', { name: 'Công việc nền' })).toBeVisible();
  const fetched = () => scripts.map((script) => script.file);
  const first = fetched();
  expect(first.length, 'the first screen needed scripts').toBeGreaterThan(0);
  expect(first.filter((file) => /^(AgentGroups|CodingWorkers)-/.test(file)), 'neither section is fetched for the first screen or for the Agents tab itself').toEqual([]);
  // the script the two sections share also holds the strings only they ask for (src/lib/i18n-agents-sections.ts), whatever it is called: up to
  // here the page has fetched the entry script, the two libraries it imports and the model picker (a script of its own that the model field of the
  // AI form fetches when it first renders, and the first run shows that form), and nothing else
  expect(first.filter((file) => !/^(index|radix|icons|ModelPicker)-/.test(file)), 'the first screen fetches a script that belongs to the sections').toEqual([]);

  await section(page, 'Nhóm trợ lý').click();
  await expect(page.getByTestId('agent-groups')).toBeVisible();
  await expectWords(page, 'Nhóm trợ lý');
  const afterGroups = fetched();
  expect(afterGroups.slice(first.length).some((file) => file.startsWith('AgentGroups-')), 'opening the groups fetches their script').toBe(true);
  expect(afterGroups.some((file) => file.startsWith('CodingWorkers-')), 'and not the other section’s').toBe(false);

  await section(page, 'Sửa mã').click();
  await expect(page.getByTestId('coding-agents')).toBeVisible();
  await expectWords(page, 'Sửa mã');
  const afterCoding = fetched();
  expect(afterCoding.slice(afterGroups.length).some((file) => file.startsWith('CodingWorkers-')), 'opening the code edits fetches theirs').toBe(true);

  // going back and forth asks the Hub for nothing more: a section that has arrived is kept
  for (const name of ['Nhóm trợ lý', 'Công việc nền', 'Sửa mã', 'Nhóm trợ lý']) {
    await section(page, name).click();
    await expect(section(page, name)).toHaveAttribute('aria-selected', 'true');
  }
  await expect(page.getByTestId('agent-groups')).toBeVisible();
  expect(fetched(), 'no script is fetched twice').toEqual(afterCoding);
  expect(new Set(afterCoding).size).toBe(afterCoding.length);
  expect(scripts.filter((script) => script.status !== 200), 'the Hub served every script').toEqual([]);
  expect(await page.evaluate(() => window.__refused), 'the Content-Security-Policy refused no script, style or request').toEqual([]);
});

test('while a section’s script is on its way the tab says so and the switch stays usable; when it arrives the section takes the line’s place', async ({ page, app }) => {
  let hold = false;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await page.route('**/assets/*.js', async (route) => {
    if (hold) await gate;
    await route.continue();
  });
  await onboard(page, app);
  await openWorkTab(page, 'Tác nhân');

  hold = true;
  await section(page, 'Nhóm trợ lý').click();
  const panel = page.getByRole('tabpanel', { name: 'Nhóm trợ lý' });
  await expect(panel.getByRole('status')).toHaveText('Đang tải mục này…');
  await expect(page.getByTestId('agent-groups')).toHaveCount(0);
  await expect(section(page, 'Nhóm trợ lý')).toHaveAttribute('aria-selected', 'true');

  // waiting for a slow script does not trap anyone: the keys of the switch still move, and the other sections are one key away
  await page.keyboard.press('Home');
  await expect(section(page, 'Công việc nền')).toBeFocused();
  await expect(page.getByRole('tabpanel', { name: 'Công việc nền' })).toBeVisible();
  await expect(page.getByText('Đang tải mục này…')).toHaveCount(0);
  await page.keyboard.press('ArrowRight');
  await expect(section(page, 'Nhóm trợ lý')).toBeFocused();
  await expect(panel.getByRole('status')).toHaveText('Đang tải mục này…');

  release();
  await expect(page.getByTestId('agent-groups')).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Đang tải mục này…' })).toHaveCount(0);
  await expect(section(page, 'Nhóm trợ lý')).toHaveAttribute('aria-selected', 'true');
});

test('a section script that cannot be fetched is an alert with a way out, the rest of the page keeps working, and a reload brings the section', async ({ page, app, browserErrors }) => {
  let failing = false;
  await page.route('**/assets/*.js', (route) => (failing ? route.abort('failed') : route.continue()));
  await onboard(page, app);
  await openWorkTab(page, 'Tác nhân');

  failing = true;
  await section(page, 'Sửa mã').click();
  const panel = page.getByRole('tabpanel', { name: 'Sửa mã' });
  await expect(panel.getByRole('alert')).toContainText('Không tải được mục này');
  const reload = panel.getByRole('button', { name: 'Tải lại trang', exact: true });
  await expect(reload).toBeVisible();
  await expect(page.getByTestId('coding-agents')).toHaveCount(0);

  // the failure stays inside the section: the rest of the Agents tab and the other tabs of the work panel work as before
  await section(page, 'Công việc nền').click();
  await expect(page.getByText('Chưa có công việc nền.')).toBeVisible();
  await openWorkTab(page, 'Tiến độ');
  await expect(page.getByRole('tab', { name: 'Tiến độ', exact: true })).toHaveAttribute('aria-selected', 'true');

  // the page cannot retry a script it has been refused (the rejection is kept), so the way out is a reload, once the files can be had
  failing = false;
  await openWorkTab(page, 'Tác nhân');
  await section(page, 'Sửa mã').click();
  await expect(panel.getByRole('alert')).toContainText('Không tải được mục này');
  await reload.click();
  await expect(page.getByRole('tab', { name: 'Tiến độ', exact: true })).toBeVisible();
  await openWorkTab(page, 'Tác nhân');
  await section(page, 'Sửa mã').click();
  await expect(page.getByTestId('coding-agents')).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'Không tải được mục này' })).toHaveCount(0);

  // The browser reported what this test provoked, and only that: the section's script and the one it shares with the other section were
  // refused, and React logged the error the boundary caught. Anything else still fails the test (the fixture checks what is left).
  const provoked = browserErrors.errors.splice(0);
  expect(provoked.some((error) => error.startsWith('Console: SectionLoadError: section_load')), 'React reports the error the boundary caught').toBe(true);
  for (const error of provoked) {
    expect(error).toMatch(/^(?:Network: \S+\/assets\/(?:CodingWorkers|agent-draft)-[\w-]+\.js: net::ERR_FAILED|Console: Failed to load resource: net::ERR_FAILED|Console: SectionLoadError: section_load\b[\s\S]*)$/);
  }
});
