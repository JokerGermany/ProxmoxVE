#!/bin/bash
set -euo pipefail
USER_NAME="$1"

for svc in fz-xvfb fz-x11vnc fz-novnc fz-grid; do
  if ! systemctl is-active --quiet "${svc}@${USER_NAME}.service"; then
    systemctl start "${svc}@${USER_NAME}.service"
  fi
done

ENV_FILE="/opt/fz-grid/env/${USER_NAME}.env"
VNC_PORT=$(grep  '^VNC_PORT='   "$ENV_FILE" | cut -d= -f2)
NOVNC_PORT=$(grep '^NOVNC_PORT=' "$ENV_FILE" | cut -d= -f2)

# Erst READY melden wenn VNC *und* websockify lauschen
for i in $(seq 1 30); do
  if ss -tln | grep -q ":${VNC_PORT} " && \
     ss -tln | grep -q ":${NOVNC_PORT} "; then
    echo "READY"
    exit 0
  fi
  sleep 1
done

echo "TIMEOUT"
exit 1
