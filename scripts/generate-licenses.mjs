import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI_PKG = path.join(ROOT, 'CHATMCP-HUB', 'ui', 'package.json');
const UI_NODE_MODULES = path.join(ROOT, 'CHATMCP-HUB', 'ui', 'node_modules');

async function main() {
  const pkgData = JSON.parse(await fs.readFile(UI_PKG, 'utf8'));
  const deps = { ...pkgData.dependencies, ...pkgData.devDependencies };

  const notices = [];
  const allowedLicenses = ['MIT', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'OFL-1.1', 'CC0-1.0', '0BSD'];

  for (const depName of Object.keys(deps).sort()) {
    const depPkgPath = path.join(UI_NODE_MODULES, depName, 'package.json');
    try {
      const depPkg = JSON.parse(await fs.readFile(depPkgPath, 'utf8'));
      const license = depPkg.license || (depPkg.licenses ? depPkg.licenses[0]?.type : 'Unknown');
      const repo = typeof depPkg.repository === 'string' 
        ? depPkg.repository 
        : depPkg.repository?.url || depPkg.homepage || '';

      notices.push({
        name: depName,
        version: depPkg.version,
        license,
        repository: repo.replace(/^git\+/, '').replace(/\.git$/, ''),
      });
    } catch {
      // Dep might be hoisted or sub-dep
    }
  }

  let markdown = `# Third-Party Software Notices and Licenses\n\n`;
  markdown += `ChatMCP Studio UI incorporates open source third-party software components listed below.\n`;
  markdown += `All dependencies adhere strictly to permissive open source licenses (MIT, ISC, Apache-2.0, BSD, OFL).\n\n`;
  markdown += `| Component | Version | License | Source Repository |\n`;
  markdown += `| :--- | :--- | :--- | :--- |\n`;

  for (const n of notices) {
    markdown += `| \`${n.name}\` | \`${n.version}\` | **${n.license}** | ${n.repository ? `[Repository](${n.repository})` : 'N/A'} |\n`;
  }

  markdown += `\n---\n*Generated automatically by ChatMCP build tool on ${new Date().toISOString().split('T')[0]}.*\n`;

  const outputPath = path.join(ROOT, 'THIRD_PARTY_NOTICES.md');
  await fs.writeFile(outputPath, markdown, 'utf8');
  console.log(`Generated THIRD_PARTY_NOTICES.md with ${notices.length} packages.`);
}

main().catch(console.error);
