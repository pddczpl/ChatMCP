# Third-party notices — ChatMCP local-only

This file describes the **current local-only development branch**, not the
retired Cloud Harness deployment. Licenses remain those supplied by each
third-party copyright owner; this summary is **not** a substitute for complete
notices/individual LICENSE files when distributing binaries.

**ChatMCP's own code:** the repository has not yet adopted a top-level
LICENSE. The maintainer must decide the project's license before promising
redistribution rights. Imported third-party skills have independent terms.

## Bundled / built into the Windows user interface

- [React](https://github.com/facebook/react) / React DOM, currently 19.x
  in `CHATMCP-HUB/ui/package.json` (MIT per upstream). Frontend dependencies
  are installed from the pinned package-lock and bundled by the Vite build.
- [Radix UI](https://www.radix-ui.com/), [TanStack Query](https://tanstack.com/query),
  [Zustand](https://zustand.docs.pmnd.rs/), [Lucide](https://lucide.dev/),
  Tailwind CSS and other UI dependencies: see `ui/package-lock.json` and the
  package-level license files for complete attribution and versions.
- Historic React 16 UMD bundles may remain under `CHATMCP-HUB/web/vendor/`
  for compatibility pages; they are **not** the current React 19 UI source.
  Preserve copyright headers/notices when distributing these files.

## Runtime and optional local dependencies

- The Windows installer packages a portable [Node.js](https://nodejs.org/)
  runtime; its upstream licensing and bundled dependencies must be retained.
- [node-pty](https://github.com/microsoft/node-pty) is optional for Windows
  ConPTY, with its own package licenses and transitive dependencies.
- Git for Windows, Microsoft Edge WebView2 Runtime, local Ollama/LM Studio,
  and configured model-provider clients are separate installations/services
  where noted; ChatMCP does not automatically acquire all of them.

## Removed integrations

The former Cloud Harness MCP server, Desktop Commander MCP runtime and
MCP SuperAssistant proxy are **not installed, started or included as required
backend dependencies by the local-only Hub**. Historical versions and old
integration notes remain accessible in Git history. They should not be
represented as current optional runtime requirements.

## Agent Skills and external tools

The GitHub Skills Hub imports content pinned to a repository revision with
integrity evidence. A public GitHub repository and heuristic detection of a
LICENSE text **do not automatically grant redistribution permission**.
Review each upstream license and imported asset before reusing, publishing
or repackaging it. Imported scripts are not automatically executed.

## Development-only dependencies

Python, pytest, FastAPI, Playwright, TypeScript/Vite and GitHub Actions
dependencies may be installed separately for tests or release builds.
Check their upstream license files; development tools are not all shipped
inside the desktop installer.

The historical notice for ChatMCP Hub 1.x remains in
`CHATMCP-HUB/THIRD-PARTY-NOTICES.txt` as an archival record, **not** a
current dependency manifest.
