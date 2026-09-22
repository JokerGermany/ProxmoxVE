# Nextcloud
Container Installation anfangen und aufhören wenn gefragt wird ob NextCloudPi installiert wird
https://community-scripts.github.io/ProxmoxVE/scripts?id=nextcloudpi
Dann die DB und Dateien einhängen

/mnt/cloud-config - 5GB
```
mkdir -p /mnt/cloud-config/mysql /mnt/cloud-config/nextcloud /mnt/cloud-config/skripts
ln -s /mnt/cloud-config/mysql /var/lib/mysql
ln -s /mnt/cloud-config/nextcloud /var/www/nextcloud
```
Anschließend die NextcloudPi Installation starten.
Anschließend init machen
danach die Migration starten:
https://github.com/JokerGermany/ProxmoxVE/blob/main/migrate-nc_postgres_docker%20-%3E%20nextcloudpi.md

Auf Proxmox:
```
chown -R 100033:100033 /mnt/wichtig/cloud
```

```
pct set 113 -mp1 /mnt/wichtig/cloud,mp=/opt/ncdata/data
```

# Paperless
https://community-scripts.github.io/ProxmoxVE/scripts?id=paperless-ngx
Nach der installation:

/mnt/paperless - 5GB
```
mkdir -p /mnt/paperless/db /mnt/paperless/opt /mnt/paperless/scripts
systemctl stop paperless-*
systemctl stop postgresql
mv /var/lib/postgresql/* /mnt/paperless/db/
rmdir /var/lib/postgresql
ln -s /mnt/paperless/db /var/lib/postgresql
chown postgres:postgres  /mnt/paperless/db /var/lib/postgresql
mv /opt/* /mnt/paperless/opt/
rmdir opt
ln -s /mnt/paperless/opt /opt

pct set 114 -mp1 /mnt/wichtig/cloud/MaxMustermann/files/Sync/Dokumente/paperless/archive,mp=/mnt/paperless/opt/paperless_data/media/documents/archive/MaxMustermann
pct set 114 -mp2 /mnt/wichtig/cloud/MaxMustermann/files/Sync/Dokumente/paperless/originals,mp=/mnt/paperless/opt/paperless_data/media/documents/originals/MaxMustermann
pct set 114 -mp3 /mnt/wichtig/cloud/MaxMustermann/files/Sync/Dokumente/paperless/consume/Max,mp=/mnt/paperless/opt/paperless_data/consume/MaxMustermann/Max
pct set 114 -mp4 /mnt/wichtig/cloud/MaxMustermann/files/Sync/Dokumente/paperless/consume/Familie,mp=/mnt/paperless/opt/paperless_data/consume/MaxMustermann/Familie

systemctl start postgresql
systemctl start --all paperless-*
```

# inotify
## Nextcloud-Autoscanner
Wenn Paperless etwas schreibt, merkt das Nextcloud nicht.
Daher müssen wir Nextcloud aufmerksam machen.
Alle Aktionen werden im Nextcloud PI Container ausgeführt.

```
apt install inotify-tools -y
```
vi /mnt/cloud-config/skripts/paperless-scanner.sh
```
#!/bin/bash

# Definition der zu überwachenden Verzeichnisse (Physikalische Pfade im LXC)
# Wir überwachen jeweils den Haupt-Ordner "paperless" pro User
declare -A WATCH_MAP
WATCH_MAP["/opt/ncdata/data/MaxMustermann/files/Sync/Dokumente/paperless"]="MaxMustermann/files/Sync/Dokumente/paperless"
...

LOCK_DIR="/dev/shm/nc_locks"
mkdir -p "$LOCK_DIR"

echo "Nextcloud-Autoscanner gestartet. Überwache nur Paperless-Verzeichnisse..."

# Wir starten inotifywait mit der Liste aller Keys (Pfade) aus der WATCH_MAP
inotifywait -m -r -e moved_to -e close_write -e delete "${!WATCH_MAP[@]}" --format '%w%f' | while read FILE
do
    NC_SCAN_PATH=""
    
    # Prüfen, welcher Überwachungspfad im Pfad der geänderten Datei steckt
    for WATCH_PATH in "${!WATCH_MAP[@]}"; do
        if [[ "$FILE" == "$WATCH_PATH"* ]]; then
            NC_SCAN_PATH="${WATCH_MAP[$WATCH_PATH]}"
            # User extrahieren (Erster Teil des Nextcloud-Pfads)
            NC_USER=$(echo "$NC_SCAN_PATH" | cut -d'/' -f1)
            break
        fi
    done

    if [ -n "$NC_SCAN_PATH" ]; then
        USER_LOCK="$LOCK_DIR/$NC_USER.lock"

        if [ -f "$USER_LOCK" ]; then
            continue
        fi

        touch "$USER_LOCK"
        
        (
            sleep 2
            echo "$(date '+%H:%M:%S') - Änderung in $NC_USER erkannt. Scanne $NC_SCAN_PATH"
            sudo -u www-data php8.3 /var/www/nextcloud/occ files:scan --path="$NC_SCAN_PATH" --quiet
            rm "$USER_LOCK"
        ) &
    fi
done
```

```
chmod +x /mnt/cloud-config/skripts/paperless-scanner.sh
vi /mnt/cloud-config/skripts/paperless-scanner.service
```



```
[Unit]
Description=Nextcloud Inotify Autoscanner
After=network.target

[Service]
Type=simple
ExecStart=/bin/bash /mnt/cloud-config/skripts/paperless-scanner.sh
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```
ln -s /mnt/cloud-config/skripts/paperless-scanner.service /etc/systemd/system/paperless-scanner.service

systemctl daemon-reload
systemctl enable --now paperless-scanner.service
## Scan-Mover
Dafür Sorge tragen, dass paperless vom Scanner nur fertige Dateien zu sehen bekommen
`/mnt/cloud-config/skripts/paperless-scan-mover.sh`
```
#!/usr/bin/env bash
#
# paperless-scan-mover.sh
#
# Moves fully-written scans from staging folders atomically into their matching
# paperless-ngx consume folders. It reacts to the inotify event IN_CLOSE_WRITE
# (file handle closed = write complete), which avoids paperless picking up a
# network scan file (SMB/FTP) while it is still growing in place.
#
# Supports multiple staging->consume pairs (one per scanner destination),
# configured in a separate file (see CONFIG below).
#
# Requirements:
#   - Each staging folder and its consume folder must be on the SAME filesystem
#     so that `mv` is an atomic rename() (paperless then sees the file appear
#     complete, never a partial state).
#   - Keep the staging folders OUTSIDE the Nextcloud files/ trees so Nextcloud
#     (and any files:scan watcher) never sees the in-progress scanner writes.
#   - Point each scanner network destination at the STAGING folder, not consume.
#
# Dependency: inotify-tools (inotifywait)
#
# License: GPL-3.0-or-later
#
set -euo pipefail

# Config file with one "STAGING|CONSUME" pair per line (see .conf.example).
# Override with the CONFIG env var or as first argument.
CONFIG="${CONFIG:-${1:-/mnt/cloud-config/skripts/paperless-scan-mover.conf}}"

# close_write is the normal, reliable path (moves instantly). The sweep is ONLY
# a last-resort cleaner for abnormal cases where no close_write arrived (server
# unreachable mid-scan, scanner lost power/Wi-Fi, watcher was down at close
# time), so both values are deliberately large.
SWEEP_INTERVAL="${SWEEP_INTERVAL:-300}"  # seconds between orphan checks
MIN_AGE="${MIN_AGE:-300}"                # seconds a file must be UNCHANGED before
                                         # the sweep moves it (close_write ignores it)

log() { printf '%s %s\n' "$(date '+%F %T')" "$*"; }

[ -r "$CONFIG" ] || { log "ERROR: config not readable: $CONFIG"; exit 1; }

declare -A CONSUME_OF          # staging(no trailing slash) -> consume
WATCH_DIRS=()

# Parse config: skip blank lines and comments; each line is STAGING|CONSUME
while IFS= read -r line || [ -n "$line" ]; do
    line="${line#"${line%%[![:space:]]*}"}"          # ltrim
    [ -z "$line" ] && continue
    case "$line" in \#*) continue ;; esac
    [[ "$line" == *"|"* ]] || { log "ignoring malformed line: $line"; continue; }

    staging="${line%%|*}"; consume="${line#*|}"
    staging="${staging%"${staging##*[![:space:]]}"}"; staging="${staging%/}"   # rtrim + slash
    consume="${consume#"${consume%%[![:space:]]*}"}"; consume="${consume%/}"   # ltrim + slash

    [ -d "$staging" ] || { log "ERROR: staging folder missing: $staging"; exit 1; }
    [ -d "$consume" ] || { log "ERROR: consume folder missing: $consume"; exit 1; }
    if [ "$(stat -c %d "$staging")" != "$(stat -c %d "$consume")" ]; then
        log "WARNING: not on the same filesystem, mv will NOT be atomic:"
        log "         $staging  <->  $consume"
    fi

    CONSUME_OF["$staging"]="$consume"
    WATCH_DIRS+=("$staging")
done < "$CONFIG"

[ "${#WATCH_DIRS[@]}" -gt 0 ] || { log "ERROR: no valid pairs in $CONFIG"; exit 1; }

process() {
    local staging="$1" f="$2" mode="${3:-event}" base consume dst
    consume="${CONSUME_OF[$staging]:-}"
    [ -n "$consume" ] || { log "ERROR: no consume mapping for $staging"; return 0; }

    base="$(basename -- "$f")"
    case "$base" in
        .*|*.tmp|*.part|*.filepart|*.crdownload) return 0 ;;
    esac
    shopt -s nocasematch
    if [[ "$base" != *.pdf ]]; then shopt -u nocasematch; return 0; fi
    shopt -u nocasematch

    [ -f "$f" ] || return 0
    [ -s "$f" ] || { log "skipped (0 bytes): $staging/$base"; return 0; }

    if [ "$mode" = "sweep" ]; then
        local now mtime age
        now="$(date +%s)"; mtime="$(stat -c %Y "$f")"; age=$(( now - mtime ))
        if [ "$age" -lt "$MIN_AGE" ]; then return 0; fi
    fi

    dst="$consume/$base"
    if [ -e "$dst" ]; then
        dst="$consume/${base%.*}_$(date +%s).pdf"
    fi

    if mv -n -- "$f" "$dst"; then
        log "moved: $base  ($staging -> $consume)"
    else
        log "ERROR moving: $staging/$base"
    fi
}

sweep() {
    local staging f
    for staging in "${WATCH_DIRS[@]}"; do
        for f in "$staging"/*; do [ -e "$f" ] && process "$staging" "$f" sweep; done
    done
}

( while true; do sleep "$SWEEP_INTERVAL"; sweep; done ) &

sweep   # startup cleanup of leftovers

log "watching ${#WATCH_DIRS[@]} staging folders from $CONFIG (event: close_write / moved_to)"
inotifywait -m -q -e close_write -e moved_to --format '%w|%f' "${WATCH_DIRS[@]}" \
| while IFS='|' read -r wdir name; do
    process "${wdir%/}" "${wdir%/}/$name"
done
```
`/mnt/cloud-config/skripts/paperless-scan-mover.conf`
```
# paperless-scan-mover configuration
#
# One "STAGING|CONSUME" pair per line.
#   - STAGING : folder the scanner writes into (network destination target).
#   - CONSUME : the paperless-ngx consume folder the finished file is moved to.
#
# Rules:
#   - STAGING and CONSUME must be on the SAME filesystem (atomic rename).
#   - STAGING must be OUTSIDE the Nextcloud files/ trees.
#   - Blank lines and lines starting with # are ignored.
#
# STAGING|CONSUME

/opt/ncdata/data/scan-staging/user1/Personal|/opt/ncdata/data/User1/files/Sync/Documents/paperless/consume/Personal
/opt/ncdata/data/scan-staging/user1/Family|/opt/ncdata/data/User1/files/Sync/Documents/paperless/consume/Family
/opt/ncdata/data/scan-staging/user2/Personal|/opt/ncdata/data/User2/files/Sync/Documents/paperless/consume/Personal
/opt/ncdata/data/scan-staging/user2/Family|/opt/ncdata/data/User2/files/Sync/Documents/paperless/consume/Family
```
Nicht vergessen die Ordner zu erstellen

`/mnt/cloud-config/skripts/paperless-scan-mover.service`
```
[Unit]
Description=Paperless scan mover (atomic move of completed scans into consume folders)
After=network.target remote-fs.target

[Service]
Type=simple
# Runs inside the Nextcloud LXC. www-data owns the cloud data tree and needs
# write permission on the staging and consume directories (rename() needs write
# on both parent dirs). Use root if in doubt.
User=www-data
Group=www-data
Environment=CONFIG=/mnt/cloud-config/skripts/paperless-scan-mover.conf
# Sweep is only a last-resort cleaner (close_write is the normal path):
Environment=SWEEP_INTERVAL=300
Environment=MIN_AGE=300
ExecStart=/mnt/cloud-config/skripts/paperless-scan-mover.sh
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```
chown -R www-data:www-data /opt/ncdata/data/scan-staging
chmod 0755 /mnt/cloud-config/skripts/paperless-scan-mover.sh
chmod 0644 /mnt/cloud-config/skripts/paperless-scan-mover.conf
chmod 0644 /mnt/cloud-config/skripts/paperless-scan-mover.service
ln -s  /mnt/cloud-config/skripts/paperless-scan-mover.service /etc/systemd/system/paperless-scan-mover.service
systemctl daemon-reload
systemctl enable --now paperless-scan-mover.service
```

# Freigabe für Scanner
Alle Aktionen werden im Nextcloud PI Container ausgeführt.
```
apt install samba -y
adduser --system --no-create-home --group smb
smbpasswd -a smb
vi /etc/samba/smb.conf
```
Vor 
```# NextCloudPi automatically generated from here. Do not remove this comment```
Folgendes hinzufügen
```
[Max-Paperless]
path = /opt/ncdata/data/scan-staging/user1/
browsable = yes
read only = no
guest ok = no
valid users = smb
# Wichtig: Neue Dateien sollen dem Web-User gehören
force user = www-data
force group = www-data
create mask = 0664
directory mask = 0775

...
```
```
systemctl restart smbd
```
