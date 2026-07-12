#!/bin/bash
set -u

LOGFILE="/var/log/update-and-shutdown.log"
SHUTDOWN_SCRIPT="/opt/maintenance/update-and-shutdown.sh"

log() {
    echo "$(date '+%F %T') $*" | tee -a "$LOGFILE"
}

count_running_grids() {
    systemctl list-units --type=service --state=running --no-legend --plain \
    | awk '$1 ~ /^fz-grid@.*\.service$/ { c++ } END { print c+0 }'
}

RUNNING="$(count_running_grids)"
log "Shutdown-Check: laufende fz-grid Instanzen: ${RUNNING}"

if [ "$RUNNING" -ne 0 ]; then
    log "Shutdown-Check: Abbruch, noch aktiv"
    exit 0
fi

log "Shutdown-Check: kein Grid aktiv, starte Update & Shutdown"
exec "$SHUTDOWN_SCRIPT"
