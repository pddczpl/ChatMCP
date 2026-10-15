// Build-time only: prove that the staged Playwright packages load with bundled Node.
// No external browser is launched here. A real Edge/Chromium launch is a separate gate.
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
const stage = process.argv[2];
if (!stage || !path.isAbsolute(stage)) throw new Error('Provide absolute staged browser runtime directory.');
const marker = path.join(stage, 'package.json');
if (!fs.existsSync(marker)) throw new Error('Browser runtime package.json missing.');
const load = createRequire(marker);
const playwright = load('playwright');
const core = load('playwright-core');
if (!playwright?.chromium?.launch || !core?.chromium?.launch) {
  throw new Error('Staged playwright/playwright-core does not expose Chromium.');
}
const pw = load('playwright/package.json'),pc=load('playwright-core/package.json');
if (pw.version !== pc.version) throw new Error('Playwright versions do not match.');
console.log(JSON.stringify({ verified:true,playwright:pw.version,core:pc.version,browserExecutableBundled:false }));
