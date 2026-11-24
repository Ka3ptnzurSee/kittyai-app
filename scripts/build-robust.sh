#!/usr/bin/env bash
# build-robust.sh – startet den TestFlight-Build mit korrektem HOME + git-safe.directory.
# Wrapper um build-and-submit.sh, damit der Build auch aus Cron/systemd ohne Login-Shell läuft.
set -u
export HOME=/root

# git als root auf fremd-eigentümlichen Repos erlauben (sonst "dubious ownership")
if ! git config --global --get-all safe.directory 2>/dev/null | grep -qx '/opt/kitty/app'; then
  git config --global --add safe.directory /opt/kitty/app 2>/dev/null || true
fi

cd /opt/kitty/app || { echo "FEHLER: /opt/kitty/app nicht gefunden"; exit 1; }
exec bash scripts/build-and-submit.sh
