// Finds the test tools of the ACP suites: the official Agent Client Protocol SDK (the test client) and ajv (the validator of the official schema).
//
// They are installed by `npm ci --ignore-scripts --prefix DATGOLD-HUB/tests/acp-tools` (their own package.json and lock file, so that the Hub itself keeps
// no dependency at all and the installer, which takes nothing from tests/, ships none). The mutation runner works on a copy of the Hub that has no
// node_modules; it says where the original is in CHATMCP_MUTATION_SOURCE, and the tools are looked for there as well.
//
// A suite that needs them calls `loadAcpTools()`; null means "not installed here", and the suite prints CHATMCP_TEST_SKIP, which the CI runs
// (`--no-skip all`) turn into a failure, so a job that forgot the install step cannot pass without them.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const INSTALL_COMMAND = 'npm ci --ignore-scripts --prefix DATGOLD-HUB/tests/acp-tools';

/** The pinned copy of the official schema (lib/acp/schema/, with its record SOURCE.json): what every ACP suite validates the messages of the agent against. tests/verify-acp-schema.mjs says it is the schema of the installed SDK. */
export const PINNED_SCHEMA_FILE = path.join(HUB, 'lib', 'acp', 'schema', 'schema.json');

/** The folder whose node_modules holds the tools, or null. */
export function toolsFolder() {
  const candidates = [path.join(HUB, 'tests', 'acp-tools')];
  if (process.env.CHATMCP_MUTATION_SOURCE) candidates.push(path.join(process.env.CHATMCP_MUTATION_SOURCE, 'tests', 'acp-tools'));
  return candidates.find((folder) => existsSync(path.join(folder, 'node_modules', '@agentclientprotocol', 'sdk', 'package.json'))) ?? null;
}

/** The skip line a suite prints when the tools are missing. */
export const missingToolsReason = () => `the ACP test tools are not installed (run: ${INSTALL_COMMAND})`;

/**
 * @returns {Promise<null | {folder: string, sdk: object, Ajv2020: Function, sdkVersion: string, sdkSchemaFile: string, schemaFile: string, ajvVersion: string}>}
 */
export async function loadAcpTools() {
  const folder = toolsFolder();
  if (!folder) return null;
  const require = createRequire(path.join(folder, 'package.json'));
  const entry = require.resolve('@agentclientprotocol/sdk'); // .../sdk/dist/v1/stable/acp.js
  const packageRoot = path.resolve(path.dirname(entry), '..', '..', '..');
  const sdk = await import(pathToFileURL(entry).href);
  const Ajv2020 = require('ajv/dist/2020').default;
  const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
  return {
    folder,
    sdk,
    Ajv2020,
    sdkVersion: read(path.join(packageRoot, 'package.json')).version,
    // The copy inside the installed SDK: only verify-acp-schema.mjs reads it, to compare it with the pinned one.
    sdkSchemaFile: path.join(packageRoot, 'schema', 'v1', 'schema.json'),
    schemaFile: PINNED_SCHEMA_FILE,
    ajvVersion: read(path.join(path.dirname(require.resolve('ajv/package.json')), 'package.json')).version,
  };
}
