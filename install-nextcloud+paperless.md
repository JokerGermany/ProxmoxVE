Auf Proxmox:
```
chown -R 100033:100033 /mnt/wichtig/cloud
```
Container Installation anfangen und aufhören wenn gefragt wird ob NextCloudPi installiert wird
https://community-scripts.github.io/ProxmoxVE/scripts?id=nextcloudpi
Dann die DB und Dateien einhängen

/var/lib/mysql - 5GB

Anschließend die NextcloudPi Installation starten.

irgendwann:
```
pct set 113 -mp0 /mnt/wichtig/cloud,mp=/opt/ncdata/data
```
