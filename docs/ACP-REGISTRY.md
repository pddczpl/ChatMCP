# DatGold and the ACP Registry: what is missing, and the text prepared

**Nothing has been submitted, and nothing may be without the owner's word.** This page says why DatGold cannot be listed as it is, and keeps the text of a submission for the day it can. The facts were read in [agentclientprotocol/registry](https://github.com/agentclientprotocol/registry) (CONTRIBUTING.md, AUTHENTICATION.md, `agent.schema.json`, `.github/workflows/build_registry.py` and `client.py`) on 2026-11-07.

## What the registry asks, and where DatGold stands

| The registry asks | DatGold today |
| --- | --- |
| `initialize` answers a non-empty `authMethods` with at least one method of type `agent` (the default) or `terminal`; the CI runs the agent and refuses "No authMethods in response" | `authMethods` is empty: the agent is a local client of a Hub that the owner already runs, so there is nothing to sign in to. **Blocker.** |
| A distribution: `npx` (an npm package), `uvx` (PyPI), or `binary` (an archive per platform: `.zip`, `.tar.gz`, …; installers such as `.msi` are refused) | DatGold ships as a Windows installer; the agent is a script inside it. **Blocker.** |
| The agent starts from that distribution in an empty home folder on `ubuntu-latest` | The agent needs a Hub: it finds or starts the one of the installation. **Blocker.** |
| `icon.svg`: square, 16x16, only `currentColor` (no fixed colours) | None. |
| `license_url` that answers HTTP 200 | The repository's `LICENSE` (Apache-2.0) would do once the repository is public. |
| `version` `x.y.z`, the same in the distribution; no `latest` | Fine once there is a distribution. |

What it would take, in short: a sign-in method the registry accepts (a terminal method that runs the desktop setup, say, which needs an owner decision), a distribution that runs on Linux without the installer, and an icon. Each of those is a product decision, not part of this change.

## The text prepared (not submitted)

`datgold/agent.json`:

```json
{
  "id": "datgold",
  "name": "DatGold",
  "version": "0.0.0",
  "description": "Drive the DatGold Hub from your editor: its tools, permission modes and protections, with approvals answered in the editor.",
  "repository": "https://github.com/pddczpl/ChatMCP",
  "authors": ["Phan Danh Dat"],
  "license": "Apache-2.0",
  "license_url": "https://github.com/pddczpl/ChatMCP/blob/main/LICENSE",
  "distribution": {
    "binary": {
      "windows-x86_64": { "archive": "https://example.invalid/not-yet-published.zip", "cmd": "./runtimes/node/node.exe", "args": ["DATGOLD-HUB/lib/acp/agent.mjs"] }
    }
  }
}
```

Every value above that is not a fact of the repository is a placeholder (`version`, the archive URL); the `binary` form is how the shape would look, not a decision. Pull request text:

> **Add DatGold.** DatGold is a local agent hub for coding work; this entry starts its ACP agent, which drives a Hub the user already runs. Tested with the official TypeScript SDK 2.4.0 against a real Hub (validation of every message against schema v1.29.1).

## Before anything is sent

1. The owner decides the sign-in method and the distribution.
2. A run of the smoke test in Zed and in a JetBrains IDE (docs/evidence/) has passed.
3. The owner says to submit.
