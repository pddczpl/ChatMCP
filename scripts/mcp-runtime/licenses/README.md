# Licence texts of the code compiled into the MCP client SDK

`@modelcontextprotocol/client` 2.4.0 (the MCP client runtime that the installer stages into `DATGOLD-HUB/runtimes/mcp`) is a bundle: its `dist`
files contain seven packages that are not in `scripts/mcp-runtime/package-lock.json`, and the package ships none of their licence texts. The
texts are vendored here, unchanged, one folder per package and version. [MANIFEST.json](MANIFEST.json) names each package, its version and
licence, the SHA-256 of the vendored file, the registry integrity of the tarball it came from, and where the text was taken.

| Package | Version | Licence | Vendored file |
|---|---|---|---|
| `@cfworker/json-schema` | 4.1.1 | MIT | `@cfworker/json-schema@4.1.1/LICENSE.md` (the tarball has none: taken from the upstream repository at the release tag) |
| `ajv` | 8.18.0 | MIT | `ajv@8.18.0/LICENSE` |
| `ajv-formats` | 3.0.1 | MIT | `ajv-formats@3.0.1/LICENSE` |
| `content-type` | 1.0.5 | MIT | `content-type@1.0.5/LICENSE` |
| `fast-deep-equal` | 3.1.3 | MIT | `fast-deep-equal@3.1.3/LICENSE` |
| `fast-uri` | 3.1.8 | BSD-3-Clause | `fast-uri@3.1.8/LICENSE` |
| `json-schema-traverse` | 1.0.0 | MIT | `json-schema-traverse@1.0.0/LICENSE` |

How the list was derived: the `//#region ../../node_modules/.pnpm/<name>@<version>/...` comments of `node_modules/@modelcontextprotocol/client/dist/*`.
`tests/verify-mcp-runtime.mjs` reads those comments again and fails when they name a package or a version that is not in the manifest, so a
new pin of the client cannot ship without the texts of what it compiles in. `stage.mjs` copies the texts to `runtimes/mcp/licenses/bundled/`
and `verify.mjs` refuses a staged runtime in which one is missing or differs from the hash here. `.gitattributes` keeps them byte for byte.
