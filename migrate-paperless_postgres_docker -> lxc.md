Auf der alten Maschine:
```
cd /media/wichtig/server/mash
docker exec mash-postgres pg_dump -U paperless -d paperless -F p > paperless_db_dump.sql
scp  paperless_db_dump.sql  root@192.168.1.14:/mnt/
```

Auf der neuen Maschine:
```
systemctl stop paperless-*
systemctl stop postgresql
su - postgres
dropdb -U postgres paperlessdb
createdb -O paperless paperlessdb
cd /mnt
psql -U postgres -f paperless_db_dump.sql paperlessdb
exit
systemctl start postgresql
systemctl start --all paperless-*
```
