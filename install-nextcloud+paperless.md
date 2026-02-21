Auf Proxmox:
```
chown -R 100033:100033 /mnt/wichtig/cloud
```
Container Installation anfangen und aufhören wenn gefragt wird ob NextCloudPi installiert wird
https://community-scripts.github.io/ProxmoxVE/scripts?id=nextcloudpi
Dann die DB und Dateien einhängen

/var/lib/mysql - 5GB

Anschließend die NextcloudPi Installation starten.

ffne die MariaDB-Konfiguration für Overrides:
Bash
```
systemctl edit mariadb.service
```
Füge exakt diesen Block ein:
```
[Service]
# Entfernt bestehende Einschränkungen
ProtectSystem=false
ReadWritePaths=/var/lib/mysql
# Erzwingt die Rechte vor jedem Start
ExecStartPre=/usr/bin/chown -R mysql:mysql /var/lib/mysql
ExecStartPre=/usr/bin/chmod -R 755 /var/lib/mysql
```

Speichern und MariaDB neu starten:
```
systemctl daemon-reload
systemctl restart mariadb
```

irgendwann:
```
pct set 113 -mp0 /mnt/wichtig/cloud,mp=/opt/ncdata/data
```
