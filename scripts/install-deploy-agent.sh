#!/bin/bash
# Install (or reinstall) com.user.nw-tracker-deploy on the primary server: every 3 minutes it runs
# scripts/server-deploy.sh, which deploys GitHub `main` when it moved. Only on the machine that runs
# the primary instance — a laptop checkout must never deploy itself.
#
#   scripts/install-deploy-agent.sh
#
# The plist is written here rather than kept in the repo, so it carries this machine's paths
# (the home folder and the nvm Node on PATH).
set -euo pipefail

LABEL="com.user.nw-tracker-deploy"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
NODE_BIN="$(dirname "$(command -v node)")"

launchctl print "$DOMAIN/com.user.nw-tracker-server" >/dev/null 2>&1 \
  || { echo "The server agent is not loaded here; install it first (server/scripts/install-server-agent.sh)." >&2; exit 1; }

cat >"$DEST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$LABEL</string>
	<key>ProgramArguments</key>
	<array>
		<string>$REPO_ROOT/scripts/server-deploy.sh</string>
	</array>
	<key>WorkingDirectory</key>
	<string>$REPO_ROOT</string>
	<key>StartInterval</key>
	<integer>180</integer>
	<key>StandardOutPath</key>
	<string>$REPO_ROOT/cfraser/deploy-agent.log</string>
	<key>StandardErrorPath</key>
	<string>$REPO_ROOT/cfraser/deploy-agent.log</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>$NODE_BIN:/opt/local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
	</dict>
</dict>
</plist>
PLIST
plutil -lint "$DEST" >/dev/null

if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "$DOMAIN/$LABEL"
  for _ in $(seq 1 50); do launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break; sleep 0.2; done
fi
launchctl bootstrap "$DOMAIN" "$DEST"
echo "Installed $LABEL (every 3 min); log: $REPO_ROOT/cfraser/deploy.log"
