// The one place where the corpus tools reach into DatGold: the acceptance file reader of Proof-of-Done (plan task pod-20,
// docs/PROOF-ACCEPTANCE.md) and the strict YAML subset it is built on. Every other corpus tool imports these names from here.
//
// The corpus is meant to move to a public repository of its own (corpus/README.md, "Splitting out the corpus"). There, the two files
// below are vendored byte for byte under vendor/datgold/ (with lib/project-check-discovery.mjs, which acceptance.mjs imports for its
// proposal helper), their sha256 and the source commit recorded beside them, and only the two paths in this file change. Nothing else
// in corpus/tools may import from DATGOLD-HUB; verify-corpus-tools checks that.
export { AcceptanceError, acceptanceSha256, parseAcceptance } from '../../DATGOLD-HUB/lib/proof/acceptance.mjs';
export { YamlSubsetError, parseYamlSubset, toPlainValue } from '../../DATGOLD-HUB/lib/proof/yaml-subset.mjs';
