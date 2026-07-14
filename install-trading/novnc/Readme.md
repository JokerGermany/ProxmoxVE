`var_cpu="2" var_ram="3072" var_disk="4" bash -c "$(curl -fsSL https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/ct/apache-guacamole.sh)"`
/opt 1GB

```
apt-get install -y nodejs npm xvfb x11vnc
mkdir -p /opt/fz-grid/systemd/ /opt/fz-grid/profiles/user1 /opt/fz-grid/env/

cd /opt/fz-grid
npm init -y
npm install playwright
npx playwright install --with-deps chromium```
```
npmplus (reverse-proxy) ──proxy_pass :8080──▶ Guac+Trading-LXC ──VNC──▶ localhost:5901/5902 ──▶ Xvfb ──▶ Chromium

```
/opt/fz-grid/
├── runner.js
├── userscript.js
├── env/
│   ├── user1.env
│   └── user2.env
├── profiles/
│   ├── user1/
│   └── user2/
└── systemd/
    ├── fz-xvfb@.service
    ├── fz-x11vnc@.service
    └── fz-grid@.service
```

```
# Symlinks anlegen — systemd verlangt die Units unter /etc/systemd/system,
# der eigentliche Inhalt bleibt aber vollständig in /opt
for unit in fz-xvfb fz-x11vnc fz-grid; do
  ln -sf "/opt/fz-grid/systemd/${unit}@.service" "/etc/systemd/system/${unit}@.service"
done

systemctl daemon-reload


# nur npmplus-LXC (192.168.1.11) darf rein
nft add rule inet filter input \
    ip saddr 192.168.1.11 ip daddr 192.168.1.15 \
    tcp dport { 6081, 6082 } accept

nft add rule inet filter input \
    ip daddr 192.168.1.15 \
    tcp dport { 6081, 6082 } drop
```

# update and shutdown

```
ln -sf /opt/maintenance/update-and-shutdown.service /etc/systemd/system/update-and-shutdown.service
ln -sf /opt/maintenance/update-and-shutdown.timer /etc/systemd/system/update-and-shutdown.timer

systemctl daemon-reload
systemctl enable --now update-and-shutdown.timer
```
# FZ-Grid Shutdown-Flow

Diese Dokumentation beschreibt den funktionierenden Shutdown-Ablauf für das FZ-Grid-Setup mit `fz-grid@.service`, `ExecStopPost`, einem separaten Shutdown-Check und dem eigentlichen Update-/Shutdown-Skript. `ExecStopPost=` wird von systemd auch in Stop-/Fehlerpfaden ausgeführt und sollte deshalb kurz bleiben.[cite:2]

## Ziel

Zwei Dinge sollen beim Beenden einer Session passieren:

1. **Sofort:** Die zur beendeten Instanz gehörenden `fz-xvfb@USER`- und `fz-x11vnc@USER`-Services werden gestoppt — unabhängig davon, ob noch andere User aktiv sind.
2. **Nur wenn danach keine `fz-grid@*.service`-Instanz mehr aktiv ist:** Der Container führt Updates aus und fährt herunter.

Der eigentliche Shutdown darf **nicht** direkt in einem langen `ExecStopPost`-Hook passieren, weil `TimeoutStopSec` auch den Stop-Pfad begrenzt und ein zu langer `ExecStopPost` dadurch abgebrochen werden kann.[cite:2][cite:34]

## Finaler Ablauf

1. Chromium wird geschlossen und `runner.js` beendet sich regulär.
2. `fz-grid@userX.service` läuft in `ExecStopPost=/opt/scripts/session-end.sh %i`.
3. `session-end.sh` schreibt einen Logeintrag und stößt **zwei unabhängige Dinge** an:
   - einen entkoppelten Cleanup-Job (über `systemd-run`), der `fz-x11vnc@userX` und `fz-xvfb@userX` stoppt
   - den separaten Shutdown-Check-Service
4. `fz-grid-shutdown-check.service` ruft `/opt/maintenance/fz-grid-shutdown-check.sh` auf.
5. Das Check-Skript zählt die laufenden `fz-grid@*.service`-Instanzen.
6. Nur wenn `0` Instanzen laufen, wird `/opt/maintenance/update-and-shutdown.sh` gestartet.
7. `update-and-shutdown.sh` führt `apt-get update`, `apt-get upgrade -y`, `apt-get autoremove -y`, `apt-get autoclean` und danach `shutdown -h now` aus.

Wichtig: Schritt 3 (Cleanup von Xvfb/x11vnc der beendeten Instanz) läuft **immer**, auch wenn in Schritt 5 noch andere User aktiv sind und der volle Shutdown deshalb ausbleibt. Nur so werden nicht mehr benötigte Xvfb/x11vnc-Prozesse einzelner User zuverlässig beendet, ohne auf das Beenden aller anderen User zu warten.

## Warum diese Trennung nötig ist

`ExecStopPost=` ist für Cleanup geeignet, aber nicht für lange Warte- oder Maintenance-Logik. systemd führt `ExecStopPost=` auch dann aus, wenn ein Dienst fehlschlägt oder gestoppt wird, und der Stop-Pfad unterliegt weiterhin den konfigurierten Timeout-Grenzen.[cite:2][cite:1]

Ein separater oneshot-Check-Service verhindert genau die Race-Condition, die vorher sichtbar war: Während `ExecStopPost` noch lief, war der `fz-grid`-Dienst aus systemd-Sicht noch nicht vollständig aus dem Stop-Pfad heraus. Dadurch konnte die Instanzzählung zu früh erfolgen oder der Stop-Post-Hook vom Timeout beendet werden.[cite:2][cite:34]

### Warum der Xvfb/x11vnc-Stop über `systemd-run` läuft

`fz-grid@.service` hat `Requires=fz-xvfb@%i.service`. Ein direkter `systemctl stop fz-xvfb@userX` **aus demselben Prozesskontext heraus**, während `fz-grid@userX` sich noch mitten in seiner eigenen Stop-Transaktion befindet (`ExecStopPost` läuft noch), kollidiert wegen dieser Requires-Beziehung mit der laufenden Transaktion. systemd merged oder verwirft den neuen Stop-Job dann stillschweigend — die Xvfb/x11vnc-Instanz bleibt fälschlich aktiv.

`systemd-run` löst das, indem es eine **komplett eigenständige transiente Unit** erzeugt, die außerhalb der Stop-Transaktion von `fz-grid@userX` läuft. Dadurch gibt es keine Abhängigkeitskollision mehr, und der Stop von Xvfb/x11vnc funktioniert zuverlässig, auch während `fz-grid@userX` sich noch selbst beendet.

Ein einfaches `systemctl stop --no-block` reicht **nicht** aus: Auch ohne zu blockieren berechnet systemd die Job-Transaktion inklusive Abhängigkeitsauflösung sofort — genau dort tritt die Kollision auf, nur eben ohne sichtbaren Fehler im Skript-Exitcode.

## Verwendete Dateien

| Pfad | Zweck |
|---|---|
| `/opt/scripts/session-end.sh` | Kurzer Trigger aus `ExecStopPost=`; stoppt die Xvfb/x11vnc-Instanz des beendeten Users entkoppelt via `systemd-run` und startet danach den globalen Shutdown-Check. |
| `/opt/maintenance/fz-grid-shutdown-check.sh` | Prüft, ob noch `fz-grid@*.service`-Instanzen laufen. |
| `/etc/systemd/system/fz-grid-shutdown-check.service` | oneshot-Service für den Shutdown-Check. |
| `/opt/maintenance/update-and-shutdown.sh` | Führt Update und Herunterfahren aus. |
| `/etc/systemd/system/fz-grid@.service` | Hauptservice für jede Benutzerinstanz. |

## Bekannte Fehlerbilder

| Symptom | Ursache | Lösung |
|---|---|---|
| `State 'stop-post' timed out` | `ExecStopPost` war zu lang und wurde von systemd beendet.[cite:34][cite:2] | `session-end.sh` kurz halten; lange Logik in separaten oneshot-Service auslagern. |
| `Failed at step EXEC ... Permission denied` | Check-Skript war nicht ausführbar. | `chmod +x /opt/maintenance/fz-grid-shutdown-check.sh` setzen. |
| `Failed to parse time specification: noW` | Tippfehler im Shutdown-Befehl. | Exakt `/usr/sbin/shutdown -h now` verwenden.[cite:114] |
| `Shutdown-Check: kein Marker vorhanden, beende` | Alte Marker-Logik war noch aktiv, obwohl direktes Starten des Check-Service genutzt wird. | Marker-Prüfung entfernen und Check direkt aus `session-end.sh` starten. |
| Xvfb/x11vnc eines beendeten Users laufen weiter, solange ein anderer User noch aktiv ist | Es gab ursprünglich gar keinen Cleanup-Schritt pro Instanz — nur den globalen Shutdown, der den ganzen Container stoppt. | `session-end.sh` um gezielten Stop von `fz-xvfb@INSTANCE`/`fz-x11vnc@INSTANCE` erweitern. |
| Xvfb/x11vnc-Stop wird lautlos verworfen, LXC fährt gar nicht mehr herunter | Direkter `systemctl stop` (auch mit `--no-block`) aus `ExecStopPost` heraus kollidiert wegen `Requires=` mit der laufenden Stop-Transaktion von `fz-grid@INSTANCE`. | Stop-Aufruf über `systemd-run` in eine eigenständige, entkoppelte transiente Unit auslagern. |

## Installation oder Aktualisierung

```bash
systemctl daemon-reload
```

## Testablauf

1. `systemctl start fz-xvfb@user1 fz-x11vnc@user1 fz-grid@user1`
2. `systemctl start fz-xvfb@user2 fz-x11vnc@user2 fz-grid@user2`
3. Session von user1 im Browser regulär schließen.
4. `tail -f /var/log/session-end.log`
5. `systemctl is-active fz-xvfb@user1 fz-x11vnc@user1` → sollte nach kurzer Zeit `inactive` sein.
6. `systemctl is-active fz-xvfb@user2 fz-x11vnc@user2` → sollte weiterhin `active` sein, solange user2 nicht beendet hat.
7. `journalctl -u "fz-cleanup-user1-*" -b --no-pager` → zeigt den entkoppelten Cleanup-Job für user1.
8. `journalctl -u fz-grid-shutdown-check.service -b --no-pager` → sollte bei noch aktivem user2 abbrechen ("Abbruch, noch aktiv").
9. Auch user2 beenden → Shutdown-Check meldet `0` laufende Instanzen, `tail -f /var/log/update-and-shutdown.log` zeigt Update-Lauf und am Ende `=== Fahre System jetzt herunter ===` mit anschließendem Verbindungsabbruch durch den Shutdown.[cite:114]

## Bekannter Nebeneffekt

Da `ExecStopPost=` bei jedem Stop-Pfad ausgeführt wird — auch bei automatischen Neustarts durch `Restart=on-failure` — stößt `session-end.sh` bei jedem Neustart von `fz-grid@userX` kurz auch den Cleanup-Job für dessen Xvfb/x11vnc an, bevor `Requires=` sie beim nächsten Start automatisch wieder hochzieht. Das ist unschädlich, erzeugt aber zusätzliche `fz-cleanup-*`-Log-Einträge.

Die transienten `fz-cleanup-*`-Units bleiben nach Abschluss als `inactive (dead)` im systemd-Zustand stehen. Das ist harmlos, sammelt aber mit der Zeit Einträge an. Bei Bedarf im Boot-Cleanup (`clear-maintenance-logs.service`) zusätzlich `systemctl reset-failed` bzw. `journalctl --vacuum-time=1d` ergänzen.
# Börse geschlossen Seite im npmplus
```
mkdir -p /opt/npmplus/trading/html
cat <<'EOF' > /opt/npmplus/trading/market_set.sh
#!/bin/sh
# Usage: market_set.sh 0|1   (0 = offen, 1 = geschlossen)
VALUE="$1"

case "$VALUE" in
  0|1) ;;
  *) echo "Usage: $0 0|1"; exit 1 ;;
esac

NEW="set \$market_closed ${VALUE};"
docker exec npmplus sh -c "echo '${NEW}' > /data/trading/market_status.conf"
docker exec npmplus nginx -s reload

if [ "$VALUE" = "1" ]; then
    # Börse geschlossen -> fz-starter stoppen
    rc-service fz-starter stop
elif [ "$VALUE" = "0" ]; then
    # Börse offen -> fz-starter starten
    rc-service fz-starter start
fi
EOF
chmod +x /opt/npmplus/trading/market_set.sh
cat <<'EOF' > /opt/npmplus/trading/market_boot_check.sh
#!/bin/sh
TZ='Europe/Berlin'; export TZ
dow=$(date +%u)   # 1=Mo ... 7=So
hour=$(date +%H)
closed=1

case "$dow" in
  1|2|3|4|5)
    if [ "$hour" -ge 7 ] && [ "$hour" -lt 23 ]; then closed=0; fi
    ;;
  6)
    if [ "$hour" -ge 13 ] && [ "$hour" -lt 19 ]; then closed=0; fi
    ;;
esac

/opt/npmplus/trading/market_set.sh "$closed"
EOF
chmod +x /opt/npmplus/trading/market_boot_check.sh
crontab -l 2>/dev/null | grep -v market_set | grep -v market_boot_check > /tmp/cron_new
{
cat /tmp/cron_new
echo "0 7  * * 1-5 /opt/npmplus/trading/market_set.sh 0"
echo "0 23 * * 1-5 /opt/npmplus/trading/market_set.sh 1"
echo "0 13 * * 6   /opt/npmplus/trading/market_set.sh 0"
echo "0 19 * * 6   /opt/npmplus/trading/market_set.sh 1"
echo "@reboot sleep 30 && /opt/npmplus/trading/market_boot_check.sh"
} | crontab -
rm /tmp/cron_new
/opt/npmplus/trading/market_boot_check.sh
mkdir -p /opt/npmplus/trading/html
cat <<'EOF' > /opt/npmplus/trading/html/closed.html
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>B&ouml;rse geschlossen</title>
<style>
body { font-family: sans-serif; text-align: center; margin-top: 15%; background: #1a1a1a; color: #eee; }
</style>
</head>
<body>
<h2>B&ouml;rse geschlossen</h2>
<p>Der Zugriff ist au&szlig;erhalb der Handelszeiten nicht verf&uuml;gbar.</p>
</body>
</html>
EOF
```
# Delete old Logs at Boot
```
sudo systemctl daemon-reload
sudo systemctl enable clear-maintenance-logs.service
```
# Starten des Trading-LXCs über Webaufruf
```
Browser → npmplus LXC (nginx) → auth_request /start-check → SSH (forced command) → Proxmox-Host
                                                                    │
                                                          pct start <CTID> (falls nötig)
                                                                    │
                                                    pct exec <CTID> -- start-session.sh user1
                                                                    │
                                        systemctl start fz-xvfb@user fz-x11vnc@user1 fz-novnc@user1 fz-grid@user1
```
## Auf dem Proxmox Host
`ssh-keygen -t ed25519 -f /root/.ssh/fz-trigger -N "" -C "fz-grid-trigger"`
/Raid6-1/wichtig/server/scripts/trigger-wrapper.sh
```
#!/bin/bash
set -euo pipefail
CTID=115          # ID des Trading-LXC anpassen
USER_NAME="${SSH_ORIGINAL_COMMAND:-}"

if [[ ! "$USER_NAME" =~ ^[a-zA-Z0-9_-]+$ ]]; then
  echo "INVALID_USER"
  exit 1
fi

if [[ "$(pct status "$CTID")" != "status: running" ]]; then
  pct start "$CTID"
  sleep 3
fi

pct exec "$CTID" -- /opt/fz-grid/bin/start-session.sh "$USER_NAME"
```
```
chmod +x /Raid6-1/wichtig/server/scripts/trigger-wrapper.sh
echo 'command="/Raid6-1/wichtig/server/scripts/trigger-wrapper.sh",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty '"$(cat /root/.ssh/fz-trigger.pub)" >> /root/.ssh/authorized_keys
scp /root/.ssh/fz-trigger root@<npmplus-lxc-ip>:/opt/npmplus/trading/fz-trigger
```
## Auf dem npmplus lxc
```
mkdir -p /opt/npmplus/trading/bin
chmod 600 /opt/npmplus/trading/bin
```
/opt/npmplus/trading/bin/starter.py 
```
#!/usr/bin/env python3
import subprocess
from http.server import BaseHTTPRequestHandler, HTTPServer

PROXMOX_HOST = "192.168.1.10"  # IP des Proxmox-Hosts anpassen
SSH_KEY = "/opt/npmplus/trading/fz-trigger"

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        user = self.headers.get("X-FZ-User", "")
        if not user.isalnum():
            self.send_response(400)
            self.end_headers()
            return

        result = subprocess.run(
            ["ssh", "-i", SSH_KEY, "-o", "StrictHostKeyChecking=no",
             f"root@{PROXMOX_HOST}", user],
            capture_output=True, text=True, timeout=40
        )

        if "READY" in result.stdout:
            self.send_response(200)
        else:
            self.send_response(502)
        self.end_headers()

if __name__ == "__main__":
    HTTPServer(("127.0.0.1", 9099), Handler).serve_forever()
```
```
chmod +x /opt/npmplus/trading/bin/starter.py
which python3 || apk add --no-cache python3
```
/etc/init.d/fz-starter
```
#!/sbin/openrc-run

name="fz-starter"
description="FZ-Grid Session Starter Hook"
command="/usr/bin/python3"
command_args="-u /opt/npmplus/trading/bin/starter.py"
command_args="/opt/npmplus/trading/bin/starter.py"
command_background="yes"
pidfile="/run/${RC_SVCNAME}.pid"
output_log="/var/log/fz-starter.log"
error_log="/var/log/fz-starter.log"

depend() {
    need net
}
```
```
chmod +x /etc/init.d/fz-starter
rc-update add fz-starter default
rc-service fz-starter start
```
nginx config anpassen
