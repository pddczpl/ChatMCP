"""Fixture-tree regressions for scripts/Resolve-ReleaseInputs.ps1 and scripts/verify-release-assets.py.

The release workflow (.github/workflows/release.yml) takes every value of a release from these two scripts: the version and where it
is cross-checked, the Companion version, the release notes and the title from their first H1, the asset names, and the pinned
upgrade baseline. Each test builds a small tree that holds only the files the resolver reads, breaks one thing, and requires a
non-zero exit with a message that names what is wrong. The good tree must print exactly the expected values.

The resolver runs in PowerShell 7 (`pwsh`, what the release workflow uses) when it is installed and in Windows PowerShell 5.1
otherwise, so both are covered by running this file on a machine of each kind.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parents[1]
REPO = SCRIPTS.parent
RESOLVER = SCRIPTS / 'Resolve-ReleaseInputs.ps1'

spec = importlib.util.spec_from_file_location('release_assets', SCRIPTS / 'verify-release-assets.py')
assets = importlib.util.module_from_spec(spec)
spec.loader.exec_module(assets)

BASELINE_SHA256 = 'ef75e9a3721c5ba94a510de1ff00c1449031a4ac797570cb0d901861b509786e'
LIFECYCLE_PIN = "    Assert-Native ((Get-Content (Join-Path $root 'DATGOLD-HUB\\extension\\manifest.json') -Raw | ConvertFrom-Json).version -eq '{0}') 'installed Companion is {0}'\n"

# The titles that were typed by hand into publish-v3.11.2.yml, publish-v3.11.0.yml and publish-v3.10.1.yml: the resolver must arrive at
# the same text from the first H1 of the release notes (the plan's defect E2 was a title copied by hand).
HAND_TITLES = {
    '3.11.2': ('false', 'DatGold v3.11.2 - more skills install, review receipts that hold and the Hub side of per-hunk review'),
    '3.11.0': ('false', 'DatGold v3.11.0 - the Update button, signed releases and a repair for an update that stopped halfway'),
    '3.10.1': ('true', 'DatGold v3.10.1 (test build) - fixes and notices after v3.10.0'),
}


def powershell():
    """pwsh when present, else Windows PowerShell; None when neither exists."""
    found = shutil.which('pwsh')
    if found:
        return found, False
    if sys.platform == 'win32':
        found = shutil.which('powershell')
        if found:
            return found, True
    return None, False


def baseline_release(**overrides):
    """The shape of `gh api repos/{repo}/releases/tags/v3.9.0` (the fields the resolver reads), as GitHub returned it on 2026-11-20."""
    document = {
        'tag_name': 'v3.9.0', 'draft': False, 'prerelease': False,
        'assets': [
            {'name': 'ChatMCP-Browser-Companion.zip', 'digest': 'sha256:749f69d184e22994cf23056d7f43021796a5fd28d84f28a95f13c19195bbff63', 'size': 48558},
            {'name': 'ChatMCPSetup.exe', 'digest': 'sha256:' + BASELINE_SHA256, 'size': 230353056},
            {'name': 'RELEASE-MANIFEST.json', 'digest': 'sha256:ac8b1c86b5898809cb2a0738e5c9cf5efce77ba06d53b96fafce3f1a178d8564', 'size': 567},
        ],
    }
    document.update(overrides)
    return document


class Tree:
    """A fixture tree with the files that Resolve-ReleaseInputs.ps1 reads, all at one version."""

    def __init__(self, root: Path, version='3.12.0', companion='1.5.2', title='a release for the tests'):
        self.root = root
        self.write('DATGOLD-HUB/package.json', json.dumps({'name': 'chatmcp-hub', 'version': version, 'type': 'module'}, indent=2) + '\n')
        self.write('DATGOLD-HUB/ui/package.json', json.dumps({'name': 'chatmcp-studio-frontend', 'version': version, 'private': True}, indent=2) + '\n')
        self.write('DATGOLD-HUB/ui/package-lock.json', json.dumps({
            'name': 'chatmcp-studio-frontend', 'version': version, 'lockfileVersion': 3, 'requires': True,
            'packages': {'': {'name': 'chatmcp-studio-frontend', 'version': version}, 'node_modules/x': {'version': '9.9.9'}},
        }, indent=2) + '\n')
        for name in ('desktop-shell/ChatMCP.csproj', 'installer/ChatMCP.Installer.csproj'):
            self.write(name, f'<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <Version>{version}</Version>\n  </PropertyGroup>\n</Project>\n')
        self.write('DATGOLD-HUB/extension/manifest.json', json.dumps({'manifest_version': 3, 'name': 'DatGold Companion', 'version': companion}, indent=2) + '\n')
        self.write('scripts/tests/Test-NativeLifecycle.ps1', 'param()\n' + LIFECYCLE_PIN.format(companion))
        self.write('scripts/Build-Installer.ps1', "# Builds DatGoldSetup.exe (called ChatMCPSetup.exe up to v3.10.2).\n$setupExe = Join-Path $distDir 'DatGoldSetup.exe'\n")
        self.write('scripts/Build-BrowserCompanion.ps1', "$filename = 'DatGold-Browser-Companion.zip'\n")
        self.write(f'docs/releases/RELEASE-NOTES-v{version}.md', f'# DatGold v{version} — {title}\n\nBody text with a second heading below.\n\n# Not the title\n')
        self.write('baseline.json', json.dumps(baseline_release()))

    def write(self, name, text):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(text.encode('utf-8'))

    def edit(self, name, old, new):
        path = self.root / name
        text = path.read_bytes().decode('utf-8')
        assert old in text, f'{old!r} is not in {name}'
        path.write_bytes(text.replace(old, new).encode('utf-8'))


class ResolveReleaseInputsTests(unittest.TestCase):
    def setUp(self):
        self.shell, self.drop_module_path = powershell()
        if self.shell is None:
            self.skipTest('neither pwsh nor Windows PowerShell is installed')
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.tree = Tree(Path(self.tmp.name))

    def run_resolver(self, *args, root=None, baseline=True):
        env = dict(os.environ)
        if self.drop_module_path:
            env.pop('PSModulePath', None)  # a Windows PowerShell child of a pwsh 7 parent cannot load its own modules with the parent's path
        root = root or self.tree.root
        command = [self.shell, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', str(RESOLVER), '-Root', str(root)]
        if baseline:
            command += ['-BaselineRelease', str(Path(self.tree.root) / 'baseline.json')]
        result = subprocess.run(command + list(args), capture_output=True, env=env, timeout=120)
        return result.returncode, result.stdout.decode('utf-8', 'replace'), result.stderr.decode('utf-8', 'replace')

    def values(self, stdout):
        pairs = [line.split('=', 1) for line in stdout.splitlines() if '=' in line]
        return {key.strip(): value.strip() for key, value in pairs}

    def assert_refused(self, message, *args, **kwargs):
        code, out, err = self.run_resolver(*args, **kwargs)
        self.assertNotEqual(code, 0, f'the resolver accepted a broken tree; stdout:\n{out}')
        self.assertIn(message, err, f'stderr does not name the defect; stderr:\n{err}')
        return err

    # ---- the good tree --------------------------------------------------------------------------------------------------------------
    def test_good_tree_prints_every_value(self):
        code, out, err = self.run_resolver('-Version', '3.12.0', '-Prerelease', 'false')
        self.assertEqual(code, 0, err)
        self.assertEqual(self.values(out), {
            'version': '3.12.0',
            'tag': 'v3.12.0',
            'title': 'DatGold v3.12.0 - a release for the tests',
            'notes_file': 'docs/releases/RELEASE-NOTES-v3.12.0.md',
            'prerelease': 'false',
            'companion_version': '1.5.2',
            'installer_asset': 'DatGoldSetup.exe',
            'companion_asset': 'DatGold-Browser-Companion.zip',
            'manifest_asset': 'RELEASE-MANIFEST.json',
            'artifact_prefix': 'ChatMCP-v3.12.0',
            'baseline_tag': 'v3.9.0',
            'baseline_asset': 'ChatMCPSetup.exe',
            'baseline_version': '3.9.0',
            'baseline_sha256': BASELINE_SHA256,
        })

    def test_the_resolver_is_ascii(self):
        # Windows PowerShell 5.1 reads a script without a byte order mark in the ANSI code page: a literal dash in a pattern stops matching.
        self.assertTrue(all(byte < 128 for byte in RESOLVER.read_bytes()), 'Resolve-ReleaseInputs.ps1 must be ASCII; write [char]0x2014, not the character')

    def test_version_defaults_to_the_hub_package(self):
        code, out, err = self.run_resolver()
        self.assertEqual(code, 0, err)
        self.assertEqual(self.values(out)['version'], '3.12.0')
        self.assertEqual(self.values(out)['prerelease'], 'false')

    def test_github_output_file_gets_the_same_lines(self):
        output = Path(self.tmp.name) / 'github-output.txt'
        output.write_bytes(b'earlier=line\n')
        code, out, err = self.run_resolver('-GitHubOutput', str(output))
        self.assertEqual(code, 0, err)
        written = output.read_bytes()
        self.assertFalse(written.startswith(b'\xef\xbb\xbf'), 'no byte order mark in GITHUB_OUTPUT')
        text = written.decode('utf-8')
        self.assertTrue(text.startswith('earlier=line\n'), 'the file is appended to, not replaced')
        self.assertEqual(self.values(text)['title'], 'DatGold v3.12.0 - a release for the tests')
        self.assertEqual({k: v for k, v in self.values(text).items() if k != 'earlier'}, self.values(out))

    def test_titles_typed_by_hand_are_derived_from_the_real_notes(self):
        for version, (prerelease, title) in HAND_TITLES.items():
            with self.subTest(version=version):
                tree = Tree(Path(self.tmp.name) / version, version=version)
                name = f'docs/releases/RELEASE-NOTES-v{version}.md'
                shutil.copyfile(REPO / name, tree.root / name)
                code, out, err = self.run_resolver('-Prerelease', prerelease, root=tree.root)
                self.assertEqual(code, 0, err)
                self.assertEqual(self.values(out)['title'], title)

    def test_the_repository_itself_resolves(self):
        code, out, err = self.run_resolver(root=REPO)
        self.assertEqual(code, 0, err)
        version = json.loads((REPO / 'DATGOLD-HUB/package.json').read_text(encoding='utf-8'))['version']
        self.assertEqual(self.values(out)['version'], version)
        self.assertTrue(self.values(out)['title'].startswith(f'DatGold v{version} '))

    # ---- versions ---------------------------------------------------------------------------------------------------------------------
    def test_each_cross_checked_file_with_another_version_is_refused(self):
        for name, old, new in [
            ('DATGOLD-HUB/package.json', '"version": "3.12.0"', '"version": "3.12.1"'),
            ('DATGOLD-HUB/ui/package.json', '"version": "3.12.0"', '"version": "3.12.1"'),
            ('DATGOLD-HUB/ui/package-lock.json', '  "version": "3.12.0",\n  "lockfileVersion"', '  "version": "3.12.1",\n  "lockfileVersion"'),
            ('desktop-shell/ChatMCP.csproj', '<Version>3.12.0</Version>', '<Version>3.12.1</Version>'),
            ('installer/ChatMCP.Installer.csproj', '<Version>3.12.0</Version>', '<Version>3.12.1</Version>'),
        ]:
            with self.subTest(file=name):
                self.tree.edit(name, old, new)
                try:
                    self.assert_refused(name, '-Version', '3.12.0')
                finally:
                    self.tree.edit(name, new, old)
        self.assertEqual(self.run_resolver('-Version', '3.12.0')[0], 0, 'the tree is good again after the loop')

    def test_the_lock_entry_of_the_root_package_is_checked_too(self):
        self.tree.edit('DATGOLD-HUB/ui/package-lock.json', '"name": "chatmcp-studio-frontend",\n      "version": "3.12.0"', '"name": "chatmcp-studio-frontend",\n      "version": "3.11.9"')
        self.assert_refused('DATGOLD-HUB/ui/package-lock.json')

    def test_a_csproj_without_or_with_two_versions_is_refused(self):
        self.tree.edit('installer/ChatMCP.Installer.csproj', '    <Version>3.12.0</Version>\n', '')
        self.assert_refused('installer/ChatMCP.Installer.csproj')
        self.tree.write('installer/ChatMCP.Installer.csproj', '<Project>\n  <Version>3.12.0</Version>\n  <Version>3.12.0</Version>\n</Project>\n')
        self.assert_refused('installer/ChatMCP.Installer.csproj')

    def test_a_version_that_is_not_x_y_z_is_refused(self):
        for bad in ('3.12', 'v3.12.0', '3.12.0-rc.1', "3.12.0'; exit 0; '", '3.12.0 '):
            with self.subTest(version=bad):
                self.assert_refused('X.Y.Z', '-Version', bad)

    def test_a_missing_file_is_refused_by_name(self):
        (self.tree.root / 'desktop-shell/ChatMCP.csproj').unlink()
        self.assert_refused('desktop-shell/ChatMCP.csproj')

    # ---- release notes and the title ----------------------------------------------------------------------------------------------
    def test_missing_release_notes_are_refused(self):
        (self.tree.root / 'docs/releases/RELEASE-NOTES-v3.12.0.md').unlink()
        self.assert_refused('docs/releases/RELEASE-NOTES-v3.12.0.md')

    def test_notes_without_an_h1_are_refused(self):
        self.tree.write('docs/releases/RELEASE-NOTES-v3.12.0.md', '## DatGold v3.12.0 - only a second-level heading\n\nText.\n')
        self.assert_refused('no H1')

    def test_an_h1_inside_a_code_block_is_not_the_title(self):
        self.tree.write('docs/releases/RELEASE-NOTES-v3.12.0.md', '```\n# DatGold v3.12.0 - inside a fence\n```\n\nText.\n')
        self.assert_refused('no H1')

    def test_notes_titled_for_another_version_are_refused(self):
        self.tree.write('docs/releases/RELEASE-NOTES-v3.12.0.md', '# DatGold v3.11.2 — copied from the last release\n')
        self.assert_refused('DatGold v3.12.0')

    def test_a_title_without_text_after_the_version_is_refused(self):
        self.tree.write('docs/releases/RELEASE-NOTES-v3.12.0.md', '# DatGold v3.12.0\n')
        self.assert_refused('DatGold v3.12.0')

    def test_pre_release_must_agree_with_test_build_in_the_title(self):
        self.tree.write('docs/releases/RELEASE-NOTES-v3.12.0.md', '# DatGold v3.12.0 (test build) — a test build\n')
        self.assert_refused('test build', '-Prerelease', 'false')
        code, out, err = self.run_resolver('-Prerelease', 'true')
        self.assertEqual(code, 0, err)
        self.assertEqual(self.values(out)['prerelease'], 'true')
        self.assertEqual(self.values(out)['title'], 'DatGold v3.12.0 (test build) - a test build')
        self.tree.write('docs/releases/RELEASE-NOTES-v3.12.0.md', '# DatGold v3.12.0 — a normal release\n')
        self.assert_refused('test build', '-Prerelease', 'true')

    def test_a_pre_release_value_that_is_not_true_or_false_is_refused(self):
        self.assert_refused('Prerelease', '-Prerelease', 'yes')

    # ---- the Companion ------------------------------------------------------------------------------------------------------------
    def test_a_companion_version_input_that_differs_from_the_manifest_is_refused(self):
        self.assert_refused('1.5.3', '-CompanionVersion', '1.5.3')
        code, out, err = self.run_resolver('-CompanionVersion', '1.5.2')
        self.assertEqual(code, 0, err)

    def test_the_companion_pin_of_the_lifecycle_test_must_follow_the_manifest(self):
        self.tree.edit('DATGOLD-HUB/extension/manifest.json', '"version": "1.5.2"', '"version": "1.6.0"')
        self.assert_refused('Test-NativeLifecycle.ps1')

    def test_a_lifecycle_test_without_the_companion_pin_is_refused(self):
        self.tree.write('scripts/tests/Test-NativeLifecycle.ps1', 'param()\n')
        self.assert_refused('Test-NativeLifecycle.ps1')

    # ---- asset names ----------------------------------------------------------------------------------------------------------------
    def test_an_old_named_companion_asset_is_refused(self):
        self.tree.write('scripts/Build-BrowserCompanion.ps1', "$filename = 'ChatMCP-Browser-Companion.zip'\n")
        self.assert_refused('ChatMCP-Browser-Companion.zip')

    def test_an_old_named_companion_copy_is_refused(self):
        self.tree.write('scripts/Build-BrowserCompanion.ps1', "$filename = 'DatGold-Browser-Companion.zip'\nCopy-Item $output (Join-Path $dist 'ChatMCP-Browser-Companion.zip')\n")
        self.assert_refused('ChatMCP-Browser-Companion.zip')

    def test_an_old_named_installer_is_refused(self):
        self.tree.write('scripts/Build-Installer.ps1', "$setupExe = Join-Path $distDir 'ChatMCPSetup.exe'\n")
        self.assert_refused('DatGoldSetup.exe')

    # ---- the upgrade baseline -------------------------------------------------------------------------------------------------------
    def test_a_baseline_digest_that_differs_from_the_pin_is_refused(self):
        document = baseline_release()
        document['assets'][1]['digest'] = 'sha256:' + '0' * 64
        self.tree.write('baseline.json', json.dumps(document))
        self.assert_refused(BASELINE_SHA256)

    def test_a_baseline_without_the_installer_or_its_digest_is_refused(self):
        document = baseline_release()
        document['assets'] = [asset for asset in document['assets'] if asset['name'] != 'ChatMCPSetup.exe']
        self.tree.write('baseline.json', json.dumps(document))
        self.assert_refused('ChatMCPSetup.exe')
        document = baseline_release()
        document['assets'][1]['digest'] = None
        self.tree.write('baseline.json', json.dumps(document))
        self.assert_refused('digest')

    def test_a_baseline_of_another_tag_or_a_draft_is_refused(self):
        self.tree.write('baseline.json', json.dumps(baseline_release(tag_name='v3.10.0')))
        self.assert_refused('v3.9.0')
        self.tree.write('baseline.json', json.dumps(baseline_release(draft=True)))
        self.assert_refused('draft')

    def test_every_defect_is_reported_at_once(self):
        (self.tree.root / 'docs/releases/RELEASE-NOTES-v3.12.0.md').unlink()
        self.tree.write('scripts/Build-BrowserCompanion.ps1', "$filename = 'ChatMCP-Browser-Companion.zip'\n")
        err = self.assert_refused('docs/releases/RELEASE-NOTES-v3.12.0.md')
        self.assertIn('ChatMCP-Browser-Companion.zip', err)


class VerifyReleaseAssetsTests(unittest.TestCase):
    """scripts/verify-release-assets.py: the check of the built files that runs before anything is published."""

    COMMIT = 'a' * 40

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dist = Path(self.tmp.name)
        records = []
        for name, content in [('DatGoldSetup.exe', b'fake installer bytes'), ('DatGold-Browser-Companion.zip', b'fake zip bytes')]:
            (self.dist / name).write_bytes(content)
            digest = hashlib.sha256(content).hexdigest()
            (self.dist / (name + '.sha256')).write_bytes(f'{digest}  {name}\r\n'.encode('ascii'))
            records.append({'name': name, 'sha256': digest, 'bytes': len(content)})
        self.manifest = {'version': '3.12.0', 'companionVersion': '1.5.2', 'commit': self.COMMIT, 'workflowRun': '1', 'assets': records,
                         'signedInEdgeVerified': False, 'authenticodeSigned': False}
        self.save()

    def save(self):
        # what the Windows job writes: Set-Content -Encoding utf8 in pwsh, no byte order mark there, but Windows PowerShell adds one
        (self.dist / 'RELEASE-MANIFEST.json').write_bytes(b'\xef\xbb\xbf' + json.dumps(self.manifest, indent=2).encode('utf-8'))

    def check(self, **overrides):
        options = dict(dist=self.dist, commit=self.COMMIT, version='3.12.0', companion_version='1.5.2',
                       asset_names=['DatGoldSetup.exe', 'DatGold-Browser-Companion.zip'])
        options.update(overrides)
        return assets.verify(**options)

    def test_good_files_pass(self):
        self.assertEqual(self.check(), [])

    def test_each_defect_is_named(self):
        cases = [
            ('another commit', lambda: None, dict(commit='b' * 40), 'commit'),
            ('another version', lambda: None, dict(version='3.12.1'), 'version'),
            ('another Companion version', lambda: None, dict(companion_version='1.5.3'), 'companionVersion'),
            ('an old-named asset in the list', lambda: None, dict(asset_names=['DatGoldSetup.exe', 'DatGold-Browser-Companion.zip', 'ChatMCP-Browser-Companion.zip']), 'asset names'),
        ]
        for label, _, overrides, needle in cases:
            with self.subTest(label):
                problems = self.check(**overrides)
                self.assertTrue(any(needle in problem for problem in problems), problems)

    def test_changed_bytes_size_and_checksum_file_are_found(self):
        (self.dist / 'DatGoldSetup.exe').write_bytes(b'fake installer bytez')
        self.assertTrue(any('DatGoldSetup.exe' in p and 'sha256' in p for p in self.check()))
        self.setUp()
        (self.dist / 'DatGold-Browser-Companion.zip').write_bytes(b'longer fake zip bytes')
        self.assertTrue(any('DatGold-Browser-Companion.zip' in p and 'bytes' in p for p in self.check()))
        self.setUp()
        (self.dist / 'DatGoldSetup.exe.sha256').write_text('0' * 64 + '  DatGoldSetup.exe\n', encoding='ascii')
        self.assertTrue(any('DatGoldSetup.exe.sha256' in p for p in self.check()))

    def test_an_extra_asset_in_the_manifest_is_found(self):
        self.manifest['assets'].append({'name': 'ChatMCP-Browser-Companion.zip', 'sha256': '0' * 64, 'bytes': 1})
        self.save()
        self.assertTrue(any('asset names' in p for p in self.check()))

    def test_a_missing_file_is_a_problem_not_a_crash(self):
        (self.dist / 'DatGold-Browser-Companion.zip').unlink()
        self.assertTrue(any('DatGold-Browser-Companion.zip' in p for p in self.check()))
        (self.dist / 'RELEASE-MANIFEST.json').unlink()
        self.assertTrue(any('RELEASE-MANIFEST.json' in p for p in self.check()))

    def test_the_command_line_exits_non_zero_on_a_problem(self):
        script = str(SCRIPTS / 'verify-release-assets.py')
        base = [sys.executable, '-I', script, '--dist', str(self.dist), '--commit', self.COMMIT, '--version', '3.12.0', '--companion-version', '1.5.2',
                '--asset', 'DatGoldSetup.exe', '--asset', 'DatGold-Browser-Companion.zip']
        good = subprocess.run(base, capture_output=True, timeout=60)
        self.assertEqual(good.returncode, 0, good.stderr.decode())
        bad = subprocess.run(base[:-4] + ['--asset', 'DatGoldSetup.exe'], capture_output=True, timeout=60)
        self.assertNotEqual(bad.returncode, 0)
        self.assertIn('asset names', bad.stderr.decode())


if __name__ == '__main__':
    unittest.main()
