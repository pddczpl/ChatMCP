// The pinned copy of the official ACP JSON Schema (lib/acp/schema/, plan task ux-20): the file every ACP suite validates the messages of the agent against.
//
// A copy that nobody checks drifts: the package it was taken from is raised, the schema changes, and the suites go on judging against a file that is no longer the one the editors use. So:
//
//   A. SOURCE.json says where the copy came from (package, version, path, tarball, integrity), what it is (sha256, size), and under which licence it is redistributed.
//   B. The copy is the bytes that SOURCE.json names, and the licence file is the one it names.
//   C. The schema is the protocol's: draft 2020-12, version 1, and it defines every message the agent sends or receives.
//   D. The installed SDK (the test tools) is the version the copy was taken from, its schema is the same bytes, and the lock file holds the integrity that SOURCE.json records.
//   E. No checkout converts the line ends of the copy (a hash of a file that core.autocrlf rewrites is a hash that fails on one runner), and the three notices say the schema is redistributed.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAcpSchemaValidator } from './support/acp-schema.mjs';
import { loadAcpTools, missingToolsReason } from './support/acp-tools.mjs';

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };
const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The folder of the repository: beside the Hub, or beside the Hub a mutation copy was made from (the copy has no documents of its own).
const REPO = path.resolve(process.env.CHATMCP_MUTATION_SOURCE ? path.resolve(process.env.CHATMCP_MUTATION_SOURCE) : HUB, '..');
const FOLDER = path.join(HUB, 'lib', 'acp', 'schema');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const tools = await loadAcpTools();
if (!tools) {
  console.log(`CHATMCP_TEST_SKIP: ${missingToolsReason()}`);
  process.exit(0);
}

// ---- A. the record -------------------------------------------------------------------------------------------------------------------------------------------------------
const source = JSON.parse(fs.readFileSync(path.join(FOLDER, 'SOURCE.json'), 'utf8'));
{
  const isText = (value) => typeof value === 'string' && value.trim().length > 0;
  assert.ok(isText(source.what) && /unchanged/.test(source.what) && /protocol version 1/.test(source.what), 'it says what the file is: version 1 of the protocol, copied unchanged');
  assert.equal(source.file, 'schema.json');
  assert.match(source.sha256, /^[0-9a-f]{64}$/, 'the sha256 is 64 lower-case hex digits');
  assert.ok(Number.isSafeInteger(source.bytes) && source.bytes > 100_000, 'the size is a whole number of bytes');
  assert.equal(source.protocolVersion, 1);
  const from = source.copiedFrom;
  assert.equal(from.package, '@agentclientprotocol/sdk');
  assert.match(from.version, /^\d+\.\d+\.\d+$/, 'the version is exact');
  assert.equal(from.path, 'schema/v1/schema.json', 'the stable schema of version 1, not the unstable variant');
  assert.equal(from.npmTarball, `https://registry.npmjs.org/@agentclientprotocol/sdk/-/sdk-${from.version}.tgz`, 'the tarball is the one of that version');
  assert.match(from.npmIntegrity, /^sha512-[A-Za-z0-9+/]{86}==$/, 'the integrity is a sha512 of npm');
  assert.equal(from.packageRepository, 'https://github.com/agentclientprotocol/typescript-sdk');
  const upstream = source.upstream;
  assert.equal(upstream.repository, 'https://github.com/agentclientprotocol/agent-client-protocol');
  assert.match(upstream.tag, /^schema-v\d+\.\d+\.\d+$/, 'the tag of the protocol repository the schema was checked against');
  assert.equal(upstream.path, 'schema/v1/schema.json');
  assert.equal(upstream.rawUrl, `https://raw.githubusercontent.com/agentclientprotocol/agent-client-protocol/${upstream.tag}/${upstream.path}`, 'the address is built from the repository, the tag and the path');
  assert.equal(upstream.sameBytes, true, 'it says the file at that tag has the same bytes as the copy');
  assert.match(upstream.checked, /^\d{4}-\d{2}-\d{2}$/, 'and when that was checked');
  assert.ok(isText(upstream.how) && /licence of that repository was not read/.test(upstream.how), 'what was not checked is said: the licence of the protocol repository');
  assert.equal(source.license.spdx, 'Apache-2.0');
  assert.equal(source.license.file, 'LICENSE');
  assert.match(source.license.sha256, /^[0-9a-f]{64}$/);
  assert.ok(isText(source.license.copyright) && /^Copyright \d{4} /.test(source.license.copyright), 'the copyright line is kept');
  assert.ok(isText(source.update) && /tests\/verify-acp-schema\.mjs/.test(source.update), 'how to update it is written down');
  assert.deepEqual(fs.readdirSync(FOLDER).sort(), ['LICENSE', 'SOURCE.json', 'schema.json'], 'the folder holds the copy, its record and its licence, and nothing else');
  ok('SOURCE.json names the package, the exact version, the path inside it, the tarball and its integrity, the hash and size of the copy, the licence and its copyright, and says what was not checked');
}

// ---- B. the copy ---------------------------------------------------------------------------------------------------------------------------------------------------------
const schemaBytes = fs.readFileSync(path.join(FOLDER, 'schema.json'));
const schema = JSON.parse(schemaBytes.toString('utf8'));
{
  assert.equal(schemaBytes.length, source.bytes, 'the size is the one on record');
  assert.equal(sha256(schemaBytes), source.sha256, 'the sha256 is the one on record');
  assert.ok(!schemaBytes.includes(0x0d), 'the copy has no carriage return: its line ends are the ones of the package');
  const licenseBytes = fs.readFileSync(path.join(FOLDER, 'LICENSE'));
  assert.equal(sha256(licenseBytes), source.license.sha256, 'the licence file is the one on record');
  const licenseText = licenseBytes.toString('utf8');
  assert.match(licenseText, /Apache License\s+Version 2\.0, January 2004/, 'it is the Apache-2.0 text');
  assert.ok(licenseText.includes(source.license.copyright), 'and it carries the copyright line the record quotes');
  ok('the schema is the bytes SOURCE.json names (size and sha256, no carriage return), and the licence file is the one it names, with the Apache-2.0 text and the copyright line');
}

// ---- C. the schema -------------------------------------------------------------------------------------------------------------------------------------------------------
{
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.title, 'Agent Client Protocol');
  assert.ok(Object.keys(schema.$defs).length >= 150, `it defines the messages and their parts (${Object.keys(schema.$defs).length} definitions)`);
  const validator = createAcpSchemaValidator({ Ajv2020: tools.Ajv2020, schema });
  const handled = new Set(validator.methods('agent'));
  const sent = new Set(validator.methods('client'));
  for (const method of ['initialize', 'authenticate', 'session/new', 'session/load', 'session/prompt', 'session/cancel']) assert.ok(handled.has(method), `the schema defines ${method}, which a client sends the agent`);
  for (const method of ['session/update', 'session/request_permission']) assert.ok(sent.has(method), `the schema defines ${method}, which the agent sends a client`);
  for (const [side, method, kind] of [['agent', 'initialize', 'response'], ['agent', 'session/new', 'response'], ['agent', 'session/prompt', 'response'], ['agent', 'session/load', 'response'], ['client', 'session/update', 'notification'], ['client', 'session/request_permission', 'request']]) {
    assert.ok(validator.table().has(`${side}|${method}|${kind}`), `${method} (${kind}, handled on the ${side} side) is in the table of the validator`);
  }
  for (const name of ['SessionUpdate', 'ToolCall', 'ToolCallUpdate', 'ToolCallContent', 'Diff', 'PermissionOption', 'RequestPermissionOutcome', 'StopReason', 'Plan', 'PlanEntry', 'UsageUpdate']) assert.ok(schema.$defs[name], `the schema defines ${name}`);
  ok('it is the schema of the protocol: draft 2020-12, "Agent Client Protocol", and it defines every request, response and notification the agent sends or receives, with the parts of an update, a diff, a permission option and a stop reason');
}

// ---- D. the installed package --------------------------------------------------------------------------------------------------------------------------------------------
{
  assert.equal(tools.sdkVersion, source.copiedFrom.version, `the installed SDK is the version the copy was taken from (installed ${tools.sdkVersion}, recorded ${source.copiedFrom.version}): update the copy, or the pin of tests/acp-tools`);
  const theirs = fs.readFileSync(tools.sdkSchemaFile);
  assert.equal(sha256(theirs), source.sha256, 'the schema inside the installed SDK is the same bytes as the copy');
  assert.equal(theirs.length, schemaBytes.length);
  const lock = JSON.parse(fs.readFileSync(path.join(tools.folder, 'package-lock.json'), 'utf8'));
  const entry = lock.packages?.['node_modules/@agentclientprotocol/sdk'];
  assert.equal(entry?.version, source.copiedFrom.version, 'the lock file pins the same version');
  assert.equal(entry?.integrity, source.copiedFrom.npmIntegrity, 'the lock file holds the integrity that SOURCE.json records');
  assert.equal(entry?.resolved, source.copiedFrom.npmTarball);
  const licenseOfPackage = fs.readFileSync(path.join(path.dirname(path.dirname(path.dirname(tools.sdkSchemaFile))), 'LICENSE'));
  assert.equal(sha256(licenseOfPackage), source.license.sha256, 'the licence file of the installed package is the same bytes as the copy');
  const manifest = JSON.parse(fs.readFileSync(path.join(tools.folder, 'package.json'), 'utf8'));
  assert.equal(manifest.dependencies?.['@agentclientprotocol/sdk'] ?? manifest.devDependencies?.['@agentclientprotocol/sdk'], source.copiedFrom.version, 'and package.json asks for that exact version');
  ok('the installed SDK is the recorded version, its schema and licence are the same bytes as the copy, and the lock file and package.json pin that version with the recorded integrity');
}

// ---- E. line ends and notices ------------------------------------------------------------------------------------------------------------------------------------------
{
  const read = (...parts) => fs.readFileSync(path.join(REPO, ...parts), 'utf8');
  const attributes = read('.gitattributes').split(/\r?\n/);
  const noConversion = attributes.some((line) => /^DATGOLD-HUB\/lib\/acp\/schema\/\*\*\s+-text\s*$/.test(line));
  assert.ok(noConversion, '.gitattributes keeps the line ends of lib/acp/schema as they are (-text)');
  const asked = [
    ['THIRD-PARTY-NOTICES.md', read('THIRD-PARTY-NOTICES.md')],
    ['DATGOLD-HUB/THIRD-PARTY-NOTICES.txt', read('DATGOLD-HUB', 'THIRD-PARTY-NOTICES.txt')],
    ['docs/LICENSE-SCAN.md', read('docs', 'LICENSE-SCAN.md')],
  ];
  for (const [name, text] of asked) {
    assert.ok(text.includes('lib/acp/schema'), `${name} lists the pinned schema (lib/acp/schema)`);
    assert.ok(text.includes(`@agentclientprotocol/sdk\` ${source.copiedFrom.version}`) || text.includes(`@agentclientprotocol/sdk ${source.copiedFrom.version}`), `${name} names the package and its version`);
    assert.ok(text.includes('Zed Industries'), `${name} keeps the copyright holder`);
  }
  // The check above must be able to fail: a text without the entry is refused.
  const lacks = (text) => !(text.includes('lib/acp/schema') && text.includes('Zed Industries'));
  assert.ok(lacks('the test tools of the ACP agent are not redistributed'), 'a notice without the entry is told apart from one with it');
  ok('.gitattributes does not convert the line ends of the copy, and the three notices (THIRD-PARTY-NOTICES.md and .txt, docs/LICENSE-SCAN.md) say that the schema is redistributed, from which package and version, and by whom');
}

console.log(`PASS: ${checks} checks (the record, the copy and its licence, the schema, the installed SDK and the lock file, the line ends and the notices)`);
