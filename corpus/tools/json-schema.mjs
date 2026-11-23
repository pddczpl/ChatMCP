// The fourth bridge from the corpus tools into DatGold (corpus/README.md, "Splitting out the corpus"): the JSON Schema validator of the
// proof pack (DATGOLD-HUB/lib/proof/schema-validate.mjs, plan task pod-29). The scoring (score.mjs, metrics.mjs; corpus/SCORING.md) checks
// run packs and result lines with it, against corpus/schema/run-pack.schema.json and corpus/schema/result.schema.json. It supports a fixed
// set of draft 2020-12 keywords on plain JSON values and refuses a schema that uses any other one; the file imports nothing, so it is
// vendored alone when the corpus is split out.
export { SUPPORTED_KEYWORDS, SchemaError, compileSchema } from '../../DATGOLD-HUB/lib/proof/schema-validate.mjs';
