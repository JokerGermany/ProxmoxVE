#!/bin/bash
set -u

LOGFILE="/var/log/update-and-shutdown.log"

# Gesetzt von update-and-shutdown.service (Environment=FZ_TRIGGER=timer).
# Läuft der Aufruf stattdessen über fz-grid-shutdown-check.sh (exec), ist
# die Variable nicht gesetzt -> altes, konservatives Verhalten bleibt dort.
FZ_TRIGGER="${FZ_TRIGGER:-}"

log() {
    echo "$(date '+%F %T') $*" | tee -a "$LOGFILE"
}

count_running_grids() {
    systemctl list-units --type=service --state=running --no-legend --plain \
    | awk '$1 ~ /^fz-grid@.*\.service$/ { c++ } END { print c+0 }'
}

log "=== Update-Lauf gestartet (Trigger: ${FZ_TRIGGER:-event}) ==="

RUNNING_BEFORE="$(count_running_grids)"
log "Laufende fz-grid Instanzen vor Update: ${RUNNING_BEFORE}"

if [ "$RUNNING_BEFORE" -ne 0 ]; then
    if [ "$FZ_TRIGGER" = "timer" ]; then
        log "Hinweis: ${RUNNING_BEFORE} fz-grid Instanz(en) noch aktiv, wird wegen Timer-Trigger ignoriert – Update wird trotzdem gestartet"
    else
        log "Abbruch: vor dem Update sind noch ${RUNNING_BEFORE} fz-grid Instanz(en) aktiv"
        exit 0
    fi
fi

export DEBIAN_FRONTEND=noninteractive

if command -v apt-get >/dev/null 2>&1; then
    log "Starte apt-get update"
    apt-get update >> "$LOGFILE" 2>&1 || {
        log "Fehler bei apt-get update, breche ab"
        exit 1
    }

    log "Starte apt-get upgrade -y"
    apt-get upgrade -y >> "$LOGFILE" 2>&1 || {
        log "Fehler bei apt-get upgrade, breche ab"
        exit 1
    }

    log "Starte apt-get autoremove -y"
    apt-get autoremove -y >> "$LOGFILE" 2>&1 || {
        log "Warnung: apt-get autoremove fehlgeschlagen"
    }

    log "Starte apt-get autoclean"
    apt-get autoclean >> "$LOGFILE" 2>&1 || {
        log "Warnung: apt-get autoclean fehlgeschlagen"
    }
else
    log "Abbruch: apt-get nicht gefunden"
    exit 1
fi

sleep 3

RUNNING_AFTER="$(count_running_grids)"
log "Laufende fz-grid Instanzen vor Shutdown: ${RUNNING_AFTER}"

if [[ "$RUNNING_AFTER" -ne 0 && "$FZ_TRIGGER" != "timer" ]]; then
    log "Abbruch: vor dem Shutdown sind wieder ${RUNNING_AFTER} fz-grid Instanz(en) aktiv"
    exit 0
fi

log "=== Update-Lauf beendet ==="
log "=== Fahre System jetzt herunter ==="
/usr/sbin/shutdown -h now
