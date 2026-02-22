# Nextcloud
Container Installation anfangen und aufhören wenn gefragt wird ob NextCloudPi installiert wird
https://community-scripts.github.io/ProxmoxVE/scripts?id=nextcloudpi
Dann die DB und Dateien einhängen

/mnt/cloud-config - 5GB
```
mkdir -p /mnt/cloud-config/mysql /mnt/cloud-config/nextcloud
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
vi /mnt/paperless/scripts/notify-nextcloud.sh
```


Wenn Paperless User != Nextcloud User
```
#!/bin/bash
# Extrahiere den Namen des Unterordners aus dem Dateinamen oder Pfad
# Wenn Paperless die Datei in /.../archive/Max0Mustermann/ abgelegt hat:
if [[ "$DOCUMENT_FILE_NAME" == *"Max0Mustermann"* ]]; then #PaperlessUser
    NC_USER="MaxMustermann" 
    NC_SUBPATH="/MaxMustermann/files/Sync/Dokumente/paperless"
elif [[ "$DOCUMENT_FILE_NAME" == *"xyz"* ]]; then
    NC_USER="Xyz
    NC_SUBPATH="/xyz/files/Dokumente/paperless"

fi

# Nur den Scan auslösen, wenn ein Match gefunden wurde
if [ ! -z "$NC_USER" ]; then
    ssh root@nextcloud-ip "sudo -u www-data php /var/www/nextcloud/occ files:scan --path='$NC_SUBPATH'"
fi
```
Wenn Paperless User = Nextcloud User:
```
#!/bin/bash
# Wir extrahieren den Usernamen aus dem Pfad.
# Wenn der Pfad z.B. "archive/MaxMustermann/datei.pdf" ist:
NC_USER=$(echo "$DOCUMENT_FILE_NAME" | cut -d'/' -f2)
NC_PATH="/$NC_USER/files/Dokumente/paperless"
# Den Befehl per SSH an den Nextcloud-LXC senden
# Wir scannen nur den spezifischen Pfad des Users für maximale Geschwindigkeit
ssh root@nextcloud-ip \
"sudo -u www-data php /var/www/nextcloud/occ files:scan --path='$NC_PATH'"
```

Damit das Skript ohne Passwort funktioniert:

Erzeuge im Paperless-LXC als der User, unter dem Paperless läuft, einen SSH-Key: 
     
```
ssh-keygen
```
Kopiere den Public Key in den Nextcloud-LXC:

```
ssh-copy-id root@extcloud-ip
```
Test-Login: Einmal manuell vom Paperless-LXC zum Nextcloud-LXC verbinden, um den Fingerprint zu bestätigen.
```
vi /mnt/paperless/opt/paperless/paperless.conf
```
hinzufügen:
```
PAPERLESS_POST_CONSUME_SCRIPT="/mnt/paperless/scripts/notify-nextcloud.sh"
```
