@echo off
rem DatGold as an Agent Client Protocol (ACP) agent. An editor (Zed, JetBrains, Neovim, Emacs, VS Code through an extension) starts this file
rem and speaks to it on standard input and standard output. NOTHING may be written to standard output but protocol messages, so this file
rem prints nothing itself; the agent logs to standard error.
rem
rem   chatmcp-acp.cmd [--port 3007] [--state-dir DIR] [--no-start]
rem
rem The Node.js that is installed with DatGold is used when it is there (runtimes\node, two folders up from here); otherwise node from PATH.
setlocal
set "CHATMCP_NODE=%~dp0..\..\runtimes\node\node.exe"
if not exist "%CHATMCP_NODE%" set "CHATMCP_NODE=node"
"%CHATMCP_NODE%" "%~dp0..\lib\acp\agent.mjs" %*
exit /b %ERRORLEVEL%
