// The second and last bridge from the corpus tools into DatGold (corpus/README.md, "Splitting out the corpus"): the process half the run
// sandbox and the scoring checkout use (corpus/SANDBOX.md). The first bridge, acceptance-parser.mjs, is the acceptance reader.
//
//   killTree, scrubEnv, BoundedCapture, ShellRunner   DATGOLD-HUB/lib/shell-runner.mjs: kill a process tree, drop credential-looking
//                                                     variables, bounded output, the shell the Hub's checks run in
//   processTreeLeft, windowsProcessTree               DATGOLD-HUB/lib/studio-terminal.mjs: what is left of a Windows process tree after
//                                                     its root exited (parent pid plus creation time), the process table and taskkill
//   runGit, pinnedArgs, pinnedEnv, treeId             DATGOLD-HUB/lib/proof/git-plumbing.mjs: a Git process without the person's
//                                                     configuration, hooks or GIT_* variables; the id of a tree
export { BoundedCapture, ShellRunner, killTree, scrubEnv } from '../../DATGOLD-HUB/lib/shell-runner.mjs';
export { processTreeLeft, windowsProcessTree } from '../../DATGOLD-HUB/lib/studio-terminal.mjs';
export { pinnedArgs, pinnedEnv, runGit, treeId } from '../../DATGOLD-HUB/lib/proof/git-plumbing.mjs';
