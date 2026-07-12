#!/bin/bash
set -u

INSTANCE="${1:-unknown}"
LOCKFILE="/run/session-end.lock"
LOGFILE="/var/log/session-end.log"

log() {
    echo "$(date '+%F %T') $*" >> "$LOGFILE"
}

if [[ ! "$INSTANCE" =~ ^[a-zA-Z0-9_-]+$ ]]; then
    log "Ungültiger Instanzname, breche ab: ${INSTANCE}"
    exit 0
fi

log "Sitzung beendet: ${INSTANCE} | SERVICE_RESULT=${SERVICE_RESULT:-unknown} EXIT_CODE=${EXIT_CODE:-unknown} EXIT_STATUS=${EXIT_STATUS:-unknown}"

# Läuft entkoppelt von der noch laufenden Stop-Transaktion von
# fz-grid@INSTANCE (siehe Abschnitt "Warum der Xvfb/x11vnc-Stop über
# systemd-run läuft"). Passiert unabhängig davon, ob andere User
# noch aktiv sind.
log "Plane Stop von fz-x11vnc@${INSTANCE} und fz-xvfb@${INSTANCE} über systemd-run (entkoppelt)"
systemd-run --unit="fz-cleanup-${INSTANCE}-$$" --description="Cleanup ${INSTANCE}" \
    /bin/bash -c "systemctl stop \
        fz-novnc@${INSTANCE}.service \
        fz-x11vnc@${INSTANCE}.service \
        fz-xvfb@${INSTANCE}.service" \
    >>"$LOGFILE" 2>&1

# Nur der globale Shutdown-Check läuft seriell hinter dem Lock,
# da er nur einmal gleichzeitig laufen darf.
exec 9>"$LOCKFILE"
if ! flock -n 9; then
    log "Skippe Shutdown-Check für ${INSTANCE}: anderer Lauf hält bereits den Lock"
    exit 0
fi

systemctl start --no-block fz-grid-shutdown-check.service
exit 0
