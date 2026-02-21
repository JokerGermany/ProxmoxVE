
Container Installation anfangen und aufhören wenn gefragt wird ob NextCloudPi installiert wird
https://community-scripts.github.io/ProxmoxVE/scripts?id=nextcloudpi
Dann die DB und Dateien einhängen

/mnt/cloud-config - 5GB
mkdir -p /mnt/cloud-config/mysql /mnt/cloud-config/nextcloud
ln -s /mnt/cloud-config/mysql /var/lib/mysql
ln -s /mnt/cloud-config/nextcloud /var/www/nextcloud

```
rmdir /var/lib/mysql/lost+found
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

TODO: paperless share outsourcen
