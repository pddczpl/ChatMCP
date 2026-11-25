// A small program for tests that ask which file was started: it writes its own path into a folder and exits with 0, whatever its arguments are. A copy under another
// name leaves a mark named after that name, with the search variable of Windows it was given. On Windows it is compiled with the C# compiler of the .NET Framework, which every Windows has; elsewhere it is a shell script.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const WIN = process.platform === 'win32';

/** Makes the program at `target`; every start leaves one file `<name>.<unique>` in `marks` that holds the path of the program that ran. */
export async function makeMarkingProgram(scratch, marks, target) {
  fs.mkdirSync(marks, { recursive: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (!WIN) {
    fs.writeFileSync(target, `#!/bin/sh\nn=$(basename "$0")\nf="$n.$$-$(date +%s%N)"\nprintf '%s|%s' "$0" "$NoDefaultCurrentDirectoryInExePath" > "${marks}/.$f" && mv "${marks}/.$f" "${marks}/$f"\n`, { mode: 0o755 });
    return target;
  }
  const compiler = path.join(process.env.SystemRoot ?? 'C:/Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const source = path.join(scratch, 'marking-program.cs');
  fs.writeFileSync(source, `\ufeffusing System; using System.IO; class P { static int Main() { string me = System.Diagnostics.Process.GetCurrentProcess().MainModule.FileName; string name = Path.GetFileNameWithoutExtension(me) + "." + Guid.NewGuid().ToString(), unfinished = Path.Combine(@"${marks}", "." + name); File.WriteAllText(unfinished, me + "|" + Environment.GetEnvironmentVariable("NoDefaultCurrentDirectoryInExePath")); File.Move(unfinished, Path.Combine(@"${marks}", name)); return 0; } }\n`);
  await run(compiler, ['/nologo', '/target:exe', `/out:${target}`, source], { windowsHide: true, timeout: 60_000 });
  return target;
}

// A mark is written under a name that starts with a dot and is moved when it is whole: what is read here was never half written.
const whole = (marks) => fs.readdirSync(marks).filter((file) => !file.startsWith('.'));
const marksOf = (marks) => whole(marks).map((file) => fs.readFileSync(path.join(marks, file), 'utf8')).map((text) => ({ file: text.slice(0, text.lastIndexOf('|')), variable: text.slice(text.lastIndexOf('|') + 1) }));
/** The paths of the programs that left a mark, one per start; the search variable each of them was given; and a way to forget them. */
export const startedPrograms = (marks) => marksOf(marks).map((mark) => mark.file).sort();
export const givenVariables = (marks) => [...new Set(marksOf(marks).map((mark) => mark.variable))].sort();
export const clearMarks = (marks) => { for (const file of whole(marks)) fs.rmSync(path.join(marks, file)); };
