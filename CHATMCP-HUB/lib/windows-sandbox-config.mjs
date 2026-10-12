// Windows Sandbox Configuration Generator and Security Validator (Phase 1, PR 2).
//
// Generates strict, hardened .wsb XML configurations for disposable Windows Sandbox execution.
// Enforces complete isolation: disabled networking, clipboard, devices, and vGPU.
// Enforces read-only input mappings and strictly isolated, non-workspace output directories.

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fault } from './execution-contract.mjs';

const DOS_RESERVED_NAMES = Object.freeze([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

/**
 * Escapes text for XML element content and attributes.
 *
 * @param {string} text
 * @returns {string}
 */
export function escapeXml(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Validates a host directory path to ensure it is safe to map into Windows Sandbox.
 *
 * @param {string} dirPath
 * @param {object} [options]
 * @param {boolean} [options.isWritable=false]
 * @param {string} [options.workspaceRoot]
 */
export function validateHostMappingPath(dirPath, { isWritable = false, workspaceRoot = null } = {}) {
  if (typeof dirPath !== 'string' || !dirPath.trim()) {
    throw fault('invalid_path', 'Host mapping path must be a non-empty string.');
  }

  const rawPath = dirPath.trim();

  // 1. Must be an absolute path (POSIX or Windows)
  const isAbs = path.posix.isAbsolute(rawPath) || path.win32.isAbsolute(rawPath);
  if (!isAbs) {
    throw fault('invalid_path', `Host mapping path must be an absolute path: '${rawPath}'.`);
  }

  // 2. Reject path traversal sequences
  if (rawPath.includes('..')) {
    throw fault('path_traversal', `Path traversal ('..') is strictly forbidden: '${rawPath}'.`);
  }

  // 3. Reject Alternate Data Streams (ADS) - contains colon after drive prefix
  const afterDrive = rawPath.replace(/^[a-zA-Z]:[\\/]/, '');
  if (afterDrive.includes(':')) {
    throw fault('invalid_path', `Alternate Data Streams (':') are strictly forbidden in path: '${rawPath}'.`);
  }

  // 4. Reject DOS reserved device names in path segments
  const segments = rawPath.split(/[\\/]/).filter(Boolean);
  for (const seg of segments) {
    const baseSeg = seg.split('.')[0].toUpperCase();
    if (DOS_RESERVED_NAMES.includes(baseSeg)) {
      throw fault('invalid_path', `DOS reserved device name '${baseSeg}' is forbidden in path: '${rawPath}'.`);
    }
  }

  const normalized = process.platform === 'win32'
    ? path.resolve(rawPath)
    : (path.win32.isAbsolute(rawPath) ? path.win32.normalize(rawPath) : path.resolve(rawPath));

  // 5. If writable, strictly forbid mapping drive roots, user workspace, or home profile directories
  if (isWritable) {
    const userHome = path.resolve(os.homedir());

    // Never map root of any drive as writable
    const normWin = path.win32.normalize(normalized);
    const normPosix = path.posix.normalize(normalized);
    const isRoot = path.win32.parse(normWin).root === normWin || path.posix.parse(normPosix).root === normPosix;
    if (isRoot) {
      throw fault('unsafe_mapping', `Cannot map drive root as writable in Windows Sandbox: '${normalized}'.`);
    }

    // Never map user home directory directly
    if (normalized === userHome) {
      throw fault('unsafe_mapping', `User home directory cannot be mapped writable: '${normalized}'.`);
    }

    // Never map workspace root directory as writable
    if (workspaceRoot) {
      const normalizedWs = path.resolve(workspaceRoot);
      if (normalized === normalizedWs) {
        throw fault('unsafe_mapping', `Workspace directory cannot be mapped writable: '${normalized}'.`);
      }
    }
  }

  // 6. Check for reparse points / junctions on host if directory exists
  if (fs.existsSync(normalized)) {
    try {
      const lstat = fs.lstatSync(normalized);
      if (lstat.isSymbolicLink()) {
        throw fault('unsafe_mapping', `Symbolic link is forbidden for mapped host folder: '${normalized}'.`);
      }
    } catch (err) {
      if (err.code === 'unsafe_mapping') throw err;
    }
  }

  return normalized;
}

/**
 * Generates an immutable, hardened Windows Sandbox .wsb configuration XML string.
 *
 * @param {object} options
 * @param {string} options.inputDirectory Read-only host directory containing inputs and supervisor
 * @param {string} options.exportDirectory Dedicated writable host directory for output artifacts
 * @param {number} [options.memoryMb=1024] Sandbox memory in MB
 * @param {boolean} [options.protectedClient=false] Enable Windows Protected Client mode
 * @param {string} [options.logonCommand] Custom command to execute on Sandbox startup
 * @param {string} [options.workspaceRoot] Optional workspace root for collision checks
 * @returns {string} Hardened .wsb XML string
 */
export function createSandboxConfiguration({
  inputDirectory,
  exportDirectory,
  memoryMb = 1024,
  protectedClient = false,
  logonCommand = '',
  workspaceRoot = null,
}) {
  const validatedInput = validateHostMappingPath(inputDirectory, { isWritable: false });
  const validatedExport = validateHostMappingPath(exportDirectory, { isWritable: true, workspaceRoot });

  if (validatedInput === validatedExport) {
    throw fault('unsafe_mapping', 'Input directory and export directory must be separate paths.');
  }

  const memory = Math.max(512, Math.min(Number(memoryMb) || 1024, 8192));
  const safeLogonCmd = escapeXml(logonCommand.trim());

  // Strict Windows Sandbox configuration XML
  const lines = [
    '<Configuration>',
    '  <!-- ChatMCP Hardened Windows Sandbox Policy -->',
    '  <!-- Strict denial: Network, Clipboard, Devices, vGPU -->',
    '  <VGpu>Disable</VGpu>',
    '  <Networking>Disable</Networking>',
    '  <ClipboardRedirection>Disable</ClipboardRedirection>',
    '  <AudioInput>Disable</AudioInput>',
    '  <VideoInput>Disable</VideoInput>',
    '  <PrinterRedirection>Disable</PrinterRedirection>',
    `  <MemoryInMB>${memory}</MemoryInMB>`,
  ];

  if (protectedClient) {
    lines.push('  <ProtectedClient>Enable</ProtectedClient>');
  }

  lines.push('  <MappedFolders>');
  // Read-only input mapping
  lines.push('    <MappedFolder>');
  lines.push(`      <HostFolder>${escapeXml(validatedInput)}</HostFolder>`);
  lines.push('      <SandboxFolder>C:\\ChatMCP\\Input</SandboxFolder>');
  lines.push('      <ReadOnly>true</ReadOnly>');
  lines.push('    </MappedFolder>');

  // Dedicated writable export mapping
  lines.push('    <MappedFolder>');
  lines.push(`      <HostFolder>${escapeXml(validatedExport)}</HostFolder>`);
  lines.push('      <SandboxFolder>C:\\ChatMCP\\Output</SandboxFolder>');
  lines.push('      <ReadOnly>false</ReadOnly>');
  lines.push('    </MappedFolder>');
  lines.push('  </MappedFolders>');

  if (safeLogonCmd) {
    lines.push('  <LogonCommand>');
    lines.push(`    <Command>${safeLogonCmd}</Command>`);
    lines.push('  </LogonCommand>');
  }

  lines.push('</Configuration>');
  return lines.join('\r\n') + '\r\n';
}
