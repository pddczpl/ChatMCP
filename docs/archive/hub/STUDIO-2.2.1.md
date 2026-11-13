# ChatMCP Studio 2.2.1 — Gateway diagnostics and automatic project tools

This release patches Studio 2.2.0; it does not modify workspace files, Cloud
Harness's repository, existing persistent sessions, or the Windows host.

## Gateway HTTP 400

- `gemini-3.8-flash` is a real model ID. HTTP 400 from a custom Cloud Run
  gateway **does not prove** that this model is invalid. Confirm by inspecting
  the gateway's *application/container log* and its JSON error response.
- The API client now extracts the bounded `error.message` / `error` value from
  JSON, redacts known API keys/tokens, and returns an actionable HTTP message.
  It never dumps raw headers, requests, project contents or full response bodies.
- **Test API · Tự nhận dạng** automatically probes at most five standard
  combinations, in order, against the SAME configured gateway origin:
  current format/auth/route, Gemini x-goog-api-key, Gemini Bearer, OpenAI-style
  Chat Completions Bearer, OpenAI-style x-goog-api-key. Duplicates are skipped.
  Each attempt has a six-second timeout. **Multiple requests may be billed.**
  No MCP tools or workspace contents are sent in these probes.
- A successful format is persisted; DPAPI saved secrets stay saved. A failed
  probe never changes the selected protocol. These probes check basic text
  generation, **not real tool-calling compatibility**. A custom gateway must
  accept the selected route and support tool declarations to run the agent.
- This release does NOT know the implementation of your private Cloud Run
  service. It cannot promise to fix a gateway-side validation error without
  seeing its sanitized application error message.

## Automatic tools, no manual tool selection

- When you click **Bắt đầu/Tiếp tục**, Studio starts the required local MCP
  services if they are not ready; it stops before sending the prompt if startup
  fails. If already ready, no restart is performed.
- The API coding agent automatically enumerates every registered MCP tool,
  selects needed tools via `mcp_catalog` / `mcp_describe` / `mcp_call`, and
  discovers likely project test commands by reading `pyproject.toml`,
  `pytest.ini`, `package.json`, `Cargo.toml`, `go.mod` and `Makefile` metadata.
  The discovered commands are hints, not commands executed immediately.
- Web mode continues to use the Browser Companion, which relies on the model
  returning valid MCP instructions in its own ChatGPT conversation.
- Permission policies remain active. Project tool discovery is read-only.
  Shell commands, dangerous edits, exporting data, OS-wide access and
  irreversible operations remain subject to existing approval/sandbox rules.
- Code/LSP, Git, Terminal and Preview tabs remain optional views for monitoring
  and manual interventions; the agent does not need you to choose them to start.

## Known limitations

- Basic Test API success does not mean MCP function-calling requests work.
- Custom authentication schemes other than Google-key/Bearer still need custom
  gateway support or adapter work.
- Docker Sandbox-only blocks external Desktop Commander host tools. Auto tools
  never bypass this limit.
- Python AST indexing, LSP servers, native Windows ConPTY, secure Windows
  sandboxing and long-term Edge reliability have the same constraints as 2.2.0.
- This release was tested in a Linux/Chromium mock environment, NOT on your
  Windows/Edge nor against your private gateway. The task won't modify your
  Windows files until installed and run locally.

## Security

A credential pasted into a chat or log must be rotated. Only use the replacement
key inside Settings → API; never paste it into issues or diagnostic reports.
