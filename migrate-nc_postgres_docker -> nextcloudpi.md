```
sudo apt install php8.3-pgsql
systemctl restart apache2
sudo mariadb
```

cp /var/www/nextcloud/config/config.php /var/www/nextcloud/config/config.php.org


```
sudo mariadb -e "DROP DATABASE nextcloud; CREATE DATABASE nextcloud CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;GRANT ALL PRIVILEGES ON nextcloud.* TO 'ncadmin'@'localhost';
FLUSH PRIVILEGES;"
```
Erstelle oder editiere eine Konfigurationsdatei:
```
sudo nano /etc/mysql/mariadb.conf.d/99-utf8mb4.cnf
```
Füge diesen Inhalt ein:
```
[client]
default-character-set = utf8mb4

[mysql]
default-character-set = utf8mb4

[mysqld]
character-set-server = utf8mb4
collation-server = utf8mb4_unicode_ci
transaction-isolation = READ-COMMITTED
binlog_format = ROW
innodb_large_prefix = on
innodb_file_format = barracuda
innodb_file_per_table = 1
```
Speichern und MariaDB neu starten:
```
sudo systemctl restart mariadb
```
Emojies usw. irgnorieren und evtl als Text anzeigen:
```
sudo mariadb -e "SET GLOBAL sql_mode = '';"
```

```
 sudo -u www-data www-data php /var/www/nextcloud/occ db:convert-type \
  --all-apps \
  --port=5432 \
  --password="<mysql-password"
  mysql ncadmin localhost nextcloud
  ```
  ```
sudo systemctl restart mariadb
cp /var/www/nextcloud/config/config.php /var/www/nextcloud/config/config.php.postgress
cp /var/www/nextcloud/config/config.php.org /var/www/nextcloud/config/config.php
sudo -u www-data php /var/www/nextcloud/occ maintenance:repair
sudo -u www-data php /var/www/nextcloud/occ upgrade
  ```
