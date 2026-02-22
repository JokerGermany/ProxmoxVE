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
path = /opt/ncdata/data/MaxMustermann/files/Sync/Dokumente/paperless/consume/
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
