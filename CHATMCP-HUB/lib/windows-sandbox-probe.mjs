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

const MIN_MEMORY_MB = 4096; // 4 GB minimum
const MIN_DISK_MB = 1024;   // 1 GB minimum free disk space

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

  const isHomeEdition = /home/i.test(osCaption);
  const isServerOrProOrEnt = /pro|enterprise|education|server/i.test(osCaption);

  if (isHomeEdition) {
    blockers.push(`Windows Home edition ('${osCaption}') does not natively support Windows Sandbox.`);
    remediations.push('Upgrade host operating system to Windows Pro, Enterprise, or Education edition.');
  } else if (!isServerOrProOrEnt && osCaption) {
    blockers.push(`Operating system edition '${osCaption}' is not recognized as a supported Windows Sandbox edition.`);
    remediations.push('Run on Windows 10/11 Pro, Enterprise, or Education edition.');
  }

  // Architecture check: x64 or arm64 required
  if (osArch !== 'x64' && osArch !== 'arm64') {
    blockers.push(`Architecture '${osArch}' is unsupported. Windows Sandbox requires x64 or arm64.`);
    remediations.push('Run on a 64-bit (x64 or arm64) CPU architecture.');
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
    blockers.push('Hardware virtualization is disabled in BIOS/firmware (VirtualizationFirmwareEnabled: False and HypervisorPresent: False).');
    remediations.push('Enable Intel Virtualization Technology (VT-x) or AMD SVM in the host system BIOS/UEFI settings.');
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
  if (!featureInstalled) {
    blockers.push("Windows Sandbox feature is not enabled ('WindowsSandbox.exe' not found in system directory).");
    remediations.push(
      'Enable the Windows Sandbox optional feature by running as Administrator: Enable-WindowsOptionalFeature -Online -FeatureName "Containers-DisposableClientVM" -NoRestart, then restart the machine.'
    );
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
    remediations.push('Ensure host machine has at least 4 GB physical RAM.');
  }

  const sysDrive = (process.env.SystemDrive || 'C:').slice(0, 1);
  const diskRaw = safePowerShell(`(Get-PSDrive '${sysDrive}').Free`);
  const freeDiskMb = diskRaw ? Math.round(Number(diskRaw) / (1024 * 1024)) : 0;
  if (freeDiskMb > 0 && freeDiskMb < MIN_DISK_MB) {
    blockers.push(`Available disk space on drive ${sysDrive}: (${freeDiskMb} MB) is below required minimum (${MIN_DISK_MB} MB).`);
    remediations.push('Free at least 1 GB of disk space on the system drive.');
  }

  const supported = !isHomeEdition && isServerOrProOrEnt && (osArch === 'x64' || osArch === 'arm64');
  const available = blockers.length === 0 && featureInstalled && virtualizationEnabled && !alreadyRunning;

  return {
    supported,
    available,
    osIsolated: available, // Only true if the backend is physically available and can enforce isolation
    platform: 'win32',
    details: {
      osCaption,
      osVersion,
      osBuild,
      osArch,
      editionSupported: !isHomeEdition && isServerOrProOrEnt,
      virtualizationEnabled,
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
    available: preflight.available,
    osIsolated: true, // Capability definition: Windows Sandbox is an OS container isolation technology
    platform: 'win32',
    networkPolicy: 'denied',
    writeScope: 'guest-ephemeral',
    concurrency: 1,
    enforcedLimits: preflight.available ? ['timeoutSeconds', 'maxOutputBytes'] : [],
    unsupportedLimits: ['maxMemoryMb', 'maxCpuCores', 'customEnv'],
    reasons: preflight.reasons,
    observedAt: preflight.observedAt,
  });
}
