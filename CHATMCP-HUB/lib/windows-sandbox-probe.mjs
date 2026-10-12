// Windows Sandbox Host Preflight and Capability Probe (Phase 1, PR 2).
//
// Performs strictly read-only preflight detection of Windows host environment,
// virtualization prerequisites, optional-feature states, and CLI availability.
// NEVER enables features, elevates privileges, reboots, or alters host configuration.

import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { validateCapabilityReport } from './execution-contract.mjs';

const MIN_MEMORY_MB = 8192; // Initial offline fixture target, not Microsoft's base minimum
const MIN_DISK_MB = 10240;  // Initial fixture target; per-project toolchains vary

/**
 * Safely executes a PowerShell command without elevation and returns trimmed stdout, or null on error.
 *
 * @param {string} command
 * @returns {string|null}
 */
function safePowerShell(command) {
  try {
    return execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', command],
      {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      }
    ).trim();
  } catch {
    return null;
  }
}

/**
 * Performs a comprehensive read-only preflight check for Windows Sandbox support.
 *
 * @returns {Promise<{
 *   supported: boolean,
 *   available: boolean,
 *   osIsolated: boolean,
 *   platform: string,
 *   details: object,
 *   blockers: string[],
 *   remediations: string[],
 *   reasons: string[],
 *   observedAt: string,
 * }>}
 */
export async function probeWindowsSandboxPreflight() {
  const observedAt = new Date().toISOString();
  const blockers = [];
  const remediations = [];

  // 1. Platform check
  if (process.platform !== 'win32') {
    return {
      supported: false,
      available: false,
      osIsolated: false,
      platform: process.platform,
      details: { platform: process.platform },
      blockers: [`Windows Sandbox is not supported on platform '${process.platform}'.`],
      remediations: ['Host machine must run a supported 64-bit Windows OS.'],
      reasons: [`Unsupported platform: ${process.platform}`],
      observedAt,
    };
  }

  // 2. OS edition, build, and architecture
  const osInfoJson = safePowerShell(
    'Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber, OSArchitecture | ConvertTo-Json -Compress'
  );
  let osCaption = '';
  let osVersion = '';
  let osBuild = 0;
  let osArch = process.arch;

  if (osInfoJson) {
    try {
      const parsed = JSON.parse(osInfoJson);
      osCaption = parsed.Caption || '';
      osVersion = parsed.Version || '';
      osBuild = parseInt(parsed.BuildNumber, 10) || 0;
      if (parsed.OSArchitecture?.includes('64')) osArch = 'x64';
    } catch {
      // Best-effort parsing failure
    }
  }

  if (!osCaption || osBuild === 0) {
    blockers.push('Cannot verify Windows edition/build from CIM; availability remains blocked.');
    remediations.push('Retry host preflight when Windows WMI/CIM is responsive; do not infer OS eligibility.');
  }

  const isHomeEdition = /home/i.test(osCaption);
  const isServerOrProOrEnt = /pro|enterprise|education/i.test(osCaption) && !/server/i.test(osCaption);

  if (isHomeEdition) {
    blockers.push(`Windows Home edition ('${osCaption}') does not natively support Windows Sandbox.`);
    remediations.push('Upgrade host operating system to Windows Pro, Enterprise, or Education edition.');
  } else if (!isServerOrProOrEnt && osCaption) {
    blockers.push(`Operating system edition '${osCaption}' is not recognized as a supported Windows Sandbox edition.`);
    remediations.push('Run on Windows 10/11 Pro, Enterprise, or Education edition.');
  }

  // This experimental CLI backend initially targets Windows 11 24H2+ x64.
  if (osArch !== 'x64') {
    blockers.push(`Initial ChatMCP Sandbox backend requires x64 (detected '${osArch}').`);
    remediations.push('Use a supported Windows 11 x64 host.');
  }
  if (osBuild < 26100) {
    blockers.push('Windows Sandbox CLI feasibility needs Windows 11 24H2+ (build 26100+).');
    remediations.push('Use Windows 11 24H2+ x64 for the initial backend.');
  }

  // 3. Virtualization in firmware (VT-x / AMD-V)
  // When a hypervisor is active (Hyper-V, WSL2, VBS), Win32_Processor hides VirtualizationFirmwareEnabled,
  // but Win32_ComputerSystem reports HypervisorPresent: True. Either confirms CPU virtualization is enabled in BIOS.
  const virtFirmware = safePowerShell(
    '(Get-CimInstance Win32_Processor | Select-Object -First 1 -ExpandProperty VirtualizationFirmwareEnabled)'
  );
  const hypervisorPresent = safePowerShell(
    '(Get-CimInstance Win32_ComputerSystem | Select-Object -First 1 -ExpandProperty HypervisorPresent)'
  );
  const virtualizationEnabled = virtFirmware?.toLowerCase() === 'true' || hypervisorPresent?.toLowerCase() === 'true';

  if (!virtualizationEnabled) {
    blockers.push('Firmware virtualization readiness is not confirmed by CIM; this does not prove BIOS virtualization is disabled.');
    remediations.push('Check virtualization and Hyper-V state before changing BIOS settings.');
  }

  // 4. Windows Sandbox optional feature / executable availability
  // Check known system path directly without requiring elevated DISM permissions
  const system32SandboxExe = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsSandbox.exe'
  );
  let executablePath = null;
  if (fs.existsSync(system32SandboxExe)) {
    executablePath = system32SandboxExe;
  } else {
    const whereResult = safePowerShell('where.exe WindowsSandbox.exe');
    if (whereResult && fs.existsSync(whereResult.split('\r\n')[0])) {
      executablePath = whereResult.split('\r\n')[0];
    }
  }

  const featureInstalled = Boolean(executablePath);
  const featureState = safePowerShell(
    '(Get-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -ErrorAction SilentlyContinue).State'
  );
  if (featureState && /Pending/i.test(featureState)) {
    blockers.push(`Windows Sandbox optional feature is '${featureState}' and a user-controlled restart is pending.`);
    remediations.push('Restart when convenient; ChatMCP must never reboot automatically.');
  } else if (featureState !== 'Enabled') {
    blockers.push('Windows Sandbox optional-feature state is not confirmed Enabled.');
    remediations.push('Check Get-WindowsOptionalFeature after any pending restart.');
  }
  if (!featureInstalled) {
    blockers.push("Windows Sandbox feature is not enabled ('WindowsSandbox.exe' not found in system directory).");
    remediations.push(
      'Enable the Windows Sandbox optional feature by running as Administrator: Enable-WindowsOptionalFeature -Online -FeatureName "Containers-DisposableClientVM" -NoRestart, then restart the machine.'
    );
  }

  // Presence of WindowsSandbox.exe does not prove the CLI or guest transport works.
  const cliPath = safePowerShell('(Get-Command wsb -ErrorAction SilentlyContinue).Source');
  if (!cliPath) {
    blockers.push('Windows Sandbox CLI (wsb) is unavailable or unverified.');
    remediations.push('After restart, check availability of wsb CLI separately from the GUI executable.');
  }

  // 5. Check if Windows Sandbox is already running (multi-instance conflict prevention)
  const runningSandboxProc = safePowerShell(
    '(Get-Process -Name "WindowsSandbox", "WindowsSandboxClient" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)'
  );
  const alreadyRunning = Boolean(runningSandboxProc && runningSandboxProc.trim());
  if (alreadyRunning) {
    blockers.push('Another Windows Sandbox instance is currently running on the host (single-instance concurrency limit).');
    remediations.push('Close existing Windows Sandbox windows before launching an isolated execution session.');
  }

  // 6. Memory and disk space checks
  const memRaw = safePowerShell('(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory');
  const totalMemoryMb = memRaw ? Math.round(Number(memRaw) / (1024 * 1024)) : 0;
  if (totalMemoryMb > 0 && totalMemoryMb < MIN_MEMORY_MB) {
    blockers.push(`Host RAM (${totalMemoryMb} MB) is below the minimum required for Windows Sandbox (${MIN_MEMORY_MB} MB).`);
    remediations.push('Provide at least 8 GB of RAM for the initial small offline fixture (not the Microsoft base minimum).');
  }

  const sysDrive = (process.env.SystemDrive || 'C:').slice(0, 1);
  const diskRaw = safePowerShell(`(Get-PSDrive '${sysDrive}').Free`);
  const freeDiskMb = diskRaw ? Math.round(Number(diskRaw) / (1024 * 1024)) : 0;
  if (freeDiskMb > 0 && freeDiskMb < MIN_DISK_MB) {
    blockers.push(`Available disk space on drive ${sysDrive}: (${freeDiskMb} MB) is below required minimum (${MIN_DISK_MB} MB).`);
    remediations.push('Free at least 10 GB for the initial offline fixture.');
  }

  const supported = !isHomeEdition && isServerOrProOrEnt && osArch === 'x64' && osBuild >= 26100;
  const available = blockers.length === 0 && featureInstalled && virtualizationEnabled && !alreadyRunning;

  return {
    supported,
    available,
    osIsolated: false, // Preflight cannot prove isolation, even when prerequisites appear ready
    platform: 'win32',
    details: {
      osCaption,
      osVersion,
      osBuild,
      osArch,
      editionSupported: !isHomeEdition && isServerOrProOrEnt,
      virtualizationEnabled,
      hypervisorPresent: hypervisorPresent?.toLowerCase() === 'true',
      featureState: featureState || 'unknown',
      cliPath: cliPath || null,
      runtimeVerified: false,
      featureInstalled,
      executablePath,
      alreadyRunning,
      totalMemoryMb,
      freeDiskMb,
    },
    blockers,
    remediations,
    reasons: blockers.length > 0 ? blockers : ['Windows Sandbox prerequisites verified'],
    observedAt,
  };
}

/**
 * Returns a validated CapabilityReport for Windows Sandbox based on read-only preflight.
 *
 * @returns {Promise<object>}
 */
export async function probeWindowsSandboxCapability() {
  const preflight = await probeWindowsSandboxPreflight();

  return validateCapabilityReport({
    backend: 'windows-sandbox',
    available: false, // Requires a REAL guest-isolation validation gate before production dispatch.
    osIsolated: true, // Design property only; no guest was successfully verified
    platform: 'win32',
    networkPolicy: 'denied',
    writeScope: 'guest-ephemeral',
    concurrency: 1,
    enforcedLimits: [],
    unsupportedLimits: ['timeoutSeconds', 'maxOutputBytes', 'maxMemoryMb', 'maxCpuCores', 'customEnv'],
    reasons: [...preflight.reasons, 'Actual guest execution, ownership and trusted transport are not yet verified.'],
    observedAt: preflight.observedAt,
  });
}
