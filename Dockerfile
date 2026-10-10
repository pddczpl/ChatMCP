# syntax=docker/dockerfile:1
#
# ChatMCP Hub - the public, single-owner server (Render free tier, or any Docker host).
# Build context: the repository root.      docker build -t chatmcp .
#
# What runs inside (see docs/DEPLOYMENT.md and docs/PHASE2-DESIGN.md):
#   tini (PID 1) -> docker/supervisor.mjs (root; prepares folders, starts the command broker, proves the account separation)
#                     |- the Hub, as the account "hub"  (holds every secret; no capabilities; no_new_privs)
#                     `- the agent's commands, as the account "agent" (no capabilities; no_new_privs; no sight of the Hub's secrets)
# The container therefore STARTS AS ROOT on purpose: the supervisor needs it to switch accounts, and it gives it up for the Hub.
# When the platform does not let root switch accounts, the supervisor starts the Hub in "no-shell" mode (no commands at all);
# it never runs the agent's commands as the Hub's account.
FROM node:22-bookworm-slim

ARG DEBIAN_FRONTEND=noninteractive
# Extra Debian packages for the agent's own work (for example: build-essential). Set at build time only.
ARG EXTRA_PACKAGES=""

# bash, git, make and python3 are the tools a coding agent expects; util-linux brings setpriv and prlimit (the launcher of the agent's
# commands); tini is PID 1 so that stray processes are reaped; tar and findutils are used by the workspace export and removal.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates findutils git make python3 python3-pip python3-venv tar tini util-linux ${EXTRA_PACKAGES} \
 && rm -rf /var/lib/apt/lists/* \
 # No set-uid or set-gid program is needed by anything here, and none should be there to be tried (no_new_privs already stops them).
 && find / -xdev -type f \( -perm -4000 -o -perm -2000 \) -exec chmod a-s {} + \
 # Three accounts that nothing else uses: the Hub, the agent, and a group both share for the workspace files.
 && groupadd --gid 10000 hub \
 && groupadd --gid 10001 agent \
 && groupadd --gid 10002 ws \
 && useradd --uid 10000 --gid hub --groups ws --no-create-home --home-dir /var/lib/chatmcp/home --shell /usr/sbin/nologin hub \
 && useradd --uid 10001 --gid agent --groups ws --create-home --home-dir /home/agent --shell /bin/bash agent \
 # The empty folder Git is pointed at (core.hooksPath) so that no hook of a cloned repository can run; the supervisor re-checks it.
 && install -d -m 0555 -o root -g root /opt/chatmcp/no-hooks

COPY CHATMCP-HUB/ /app/CHATMCP-HUB/
# The program is read-only for everyone but root.
RUN chown -R root:root /app && chmod -R go-w /app

ENV NODE_ENV=production \
    CHATMCP_PUBLIC=1 \
    CHATMCP_EXEC_MODE=broker \
    CHATMCP_DATA_ROOT=/var/lib/chatmcp \
    CHATMCP_NO_HOOKS_DIR=/opt/chatmcp/no-hooks \
    PORT=10000

EXPOSE 10000

# The Hub answers /healthz without a login (and without a Host check) so that a platform's probe can reach it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||10000)+'/healthz').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--"]
# The supervisor's own heap is small: it serves no HTTP. The Hub gets CHATMCP_HUB_HEAP_MB (default 192) from the supervisor.
CMD ["node", "--max-old-space-size=48", "/app/CHATMCP-HUB/docker/supervisor.mjs"]
