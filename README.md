# ChatMCP

## Introduction

ChatMCP is a local-first AI coding agent for a single owner on Windows 10/11 x64. Its WinForms and WebView2 desktop application connects to a local Hub and permission-controlled coding tools. You can inspect repositories, edit files, run approved commands, review Git changes, work with multiple projects and Git worktrees, install reviewed skills, and resume recorded conversations and tasks. A model response is not, by itself, proof that a change or test succeeded.

ChatMCP offers two distinct interaction modes: **Model API**, using a configured model endpoint and its own API credentials, and **ChatGPT Web Companion**, using a separately paired Chrome/Edge extension and an ordinary user-signed-in ChatGPT website session. Web mode is browser-mediated, text-focused and subject to the website's capabilities; it does not provide API credits or identical model/tool semantics. ChatMCP is local-first, **not fully offline**: configured AI providers, GitHub and authorized research tools may use the network.

[Latest stable release](https://github.com/pddczpl/ChatMCP/releases/latest) · [Issues](https://github.com/pddczpl/ChatMCP/issues) · [Detailed documentation](docs/INDEX.md)

## Guide

### Install and launch

1. Download the latest **ChatMCPSetup.exe**, **ChatMCPSetup.exe.sha256**, and **RELEASE-MANIFEST.json** from [GitHub Releases](https://github.com/pddczpl/ChatMCP/releases/latest). Verify the published SHA-256 against the actual installer bytes before running it.
2. Use **Windows 10 or 11 x64**, with **Microsoft Edge WebView2 Runtime** and **Git for Windows**. Git is needed for the repository and worktree workflows. The release installer bundles its portable Node.js runtime, supported language servers, Tree-sitter WASM grammars, and embedded Python; these do not need separate installation just to run the packaged app. Microsoft Edge/Chromium itself, an AI account or API key, Git, and WebView2 are not supplied by the installer.
3. Run the installer, launch ChatMCP, and select or register a project directory using the native workspace picker. The local Hub normally listens on **127.0.0.1:3007**; do not expose it through a public interface or reverse proxy.

### Configure an AI connection

4. In **Settings**, select Model API mode and choose a provider preset or a custom gateway. Check the **protocol** (Gemini generateContent, OpenAI-compatible Chat Completions, or Anthropic Messages), **base URL**, optional endpoint path, **model**, authentication mode, and context-window setting independently. Enter an API key or select a supported environment variable; use **Save & Test** to check actual connectivity and tool support. A custom URL or a model name does not guarantee tool-call compatibility. Ollama and LM Studio require a locally running compatible model.
5. For **ChatGPT Web** mode, download the matching **ChatMCP-Browser-Companion.zip** and its checksum from the same release. Extract the ZIP, open chrome://extensions or edge://extensions, enable Developer mode, choose **Load unpacked**, and select the extracted folder containing the extension's manifest.json (not the repository-root legacy manifest). Open a signed-in chatgpt.com tab, generate a fresh pairing code in ChatMCP Settings, and pair through the Companion popup. Approve browser-extension installation yourself; the desktop installer cannot enable it silently. Re-pair when necessary after reinstalling or changing the extension ID.

### Use, verify, and recover

6. Select the intended workspace and a permission mode: **Read Only**, **Review** (approval before mutations), **Autonomous** (bounded permitted actions), or explicitly authorized **Full Access**. Full Access executes permitted commands with your Windows account privileges, not inside a universal OS sandbox.
7. Start a task with its expected changes and acceptance checks. Watch tool results, approvals, actual Git diffs, worker outcomes, and verification evidence. An agent's final message or a green-looking status does not substitute for fresh test results. Research workflows and coding worktrees have different integration guarantees; review changes before integrating them.
8. Use **Stop** to request cancellation; stopping does not undo changes. Use **Continue** in the same conversation to create a new run and retain historical context. After a crash or an uncertain write, inspect on-disk files and Git state before deciding what to retry; the Hub must not automatically replay ambiguous mutations.
9. To update, finish or stop active work, download and verify the latest installer, and install over the owned installation. The installer may refuse an active task or foreign Hub process. If using an unpacked Browser Companion, update that extension separately, reload the ChatGPT tabs, and re-pair if required. Keep rollback and recovery evidence until the installation is confirmed healthy.
10. For error diagnosis, see [Troubleshooting](docs/TROUBLESHOOTING.md), [Windows setup](docs/WINDOWS-SETUP.md), [Desktop application](docs/DESKTOP-APP.md), [User guide](docs/USER-GUIDE.md), and [development and test instructions](docs/DEVELOPMENT.md). The [documentation library](docs/INDEX.md) links the remaining detailed architecture, security, code-intelligence and historical verification material.

## License

ChatMCP does **not** currently have an adopted top-level project license in this repository. Do not assume that the project code is licensed under MIT, Apache-2.0, or any other open-source license. Copyright and attribution notices remain applicable. Consult [Third-party notices](THIRD-PARTY-NOTICES.md) for bundled dependencies and their upstream terms. Imported Skills and third-party components have their own licenses and redistribution conditions.

## Security

ChatMCP is intended for one trusted owner and an authenticated loopback Hub, not public or multi-tenant deployment. Requests to its local API have Host/Origin and CSRF restrictions; the paired Browser Companion uses separate authorization. Treat code, skills, tool output, and model output as untrusted. Use Review for sensitive projects, inspect approvals, and understand that **Full Access** gives tools the effective access of your Windows account.

Model API requests can send task instructions, workspace excerpts, tool schemas/results, and user-selected attachments to the **configured provider**. The application uses local credential protections, but users must still protect prompts, logs and exported diagnostics. Git worktrees provide checkout separation, **not operating-system isolation**; host commands and supported Windows Sandbox verification provide different assurance levels.

Check each release's SHA-256 files and **RELEASE-MANIFEST.json** and independently inspect Authenticode signatures where present; checksums alone do not prove publisher identity. See the [Security Policy](SECURITY.md) for limitations, historical disclosures and vulnerability reporting instructions.
