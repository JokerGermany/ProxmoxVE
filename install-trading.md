`var_cpu="2" var_ram="3072" var_disk="4" bash -c "$(curl -fsSL https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/ct/apache-guacamole.sh)"`
/opt 1GB

```
apt-get install -y nodejs npm python3-pip xvfb x11vnc
mkdir -p /opt/fz-grid/systemd/ /opt/fz-grid/profiles/user1 /opt/fz-grid/env/

cd /opt/fz-grid
npm init -y
npm install playwright
npx playwright install --with-deps chromium```
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



runner.js
```
// /opt/fz-grid/runner.js
// Version: 1.4.0
// Änderungen in dieser Version:
// - Normales manuelles Schließen des Chromium-Fensters wird nicht mehr
//   vorschnell als Fehler/Crash behandelt.
// - context.on('close') beendet den Prozess nicht mehr hart sofort.
// - Kurzer Guard nach Browser-Start, damit ein frühes close-Event
//   nicht fälschlich als Crash interpretiert wird.
// - Bestehende Session-Cookie-/sessionStorage-Persistenz beibehalten.
// - Graceful Shutdown über SIGTERM/SIGINT weiterhin vorhanden.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const RUNNER_VERSION = '1.4.0';

const USER_DATA_DIR = process.env.USER_DATA_DIR;
if (!USER_DATA_DIR) {
  console.error('[RUNNER] Fehler: USER_DATA_DIR ist nicht gesetzt.');
  process.exit(1);
}

const USERSCRIPT_PATH = path.join(__dirname, 'userscript.js');
const TARGET_URL = process.env.TARGET_URL || 'https://mein.finanzen-zero.net/uebersicht';
const TARGET_ORIGIN = new URL(TARGET_URL).origin;

function getWindowSizeFromEnv() {
  const raw = process.env.SCREEN_RES || '1600x1000x24';
  const parts = raw.split('x');
  const width = parseInt(parts[0], 10);
  const height = parseInt(parts[1], 10);

  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    return { width, height };
  }

  console.warn(`[RUNNER] SCREEN_RES="${raw}" konnte nicht geparst werden, verwende Fallback 1600x1000.`);
  return { width: 1600, height: 1000 };
}

const WINDOW_SIZE = getWindowSizeFromEnv();

const SESSION_COOKIES_FILE = path.join(USER_DATA_DIR, 'fz-grid-session-cookies.json');
const SESSION_STORAGE_FILE = path.join(USER_DATA_DIR, 'fz-grid-session-storage.json');
const SNAPSHOT_INTERVAL_MS = 15000;
const CONTEXT_CLOSE_GUARD_MS = 4000;

let context = null;
let page = null;
let shuttingDown = false;
let snapshotIntervalHandle = null;
let startupCompleted = false;
let contextClosedHandled = false;

function cleanupStaleLocks() {
  const lockFiles = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];
  for (const f of lockFiles) {
    const p = path.join(USER_DATA_DIR, f);
    if (fs.existsSync(p)) {
      try {
        fs.unlinkSync(p);
        console.log(`[RUNNER] Entfernt: ${p}`);
      } catch (err) {
        console.warn(`[RUNNER] Konnte ${p} nicht entfernen:`, err.message);
      }
    }
  }
}

async function snapshotSessionCookies() {
  if (!context) return;
  try {
    const allCookies = await context.cookies();
    const sessionCookies = allCookies.filter(c => c.expires === -1);
    fs.writeFileSync(SESSION_COOKIES_FILE, JSON.stringify(sessionCookies, null, 2));
    if (sessionCookies.length > 0) {
      console.log(`[RUNNER] ${sessionCookies.length} Session-Cookie(s) gesichert.`);
    }
  } catch (err) {
    console.warn('[RUNNER] Konnte Session-Cookies nicht sichern:', err.message);
  }
}

async function snapshotSessionStorage() {
  if (!page || page.isClosed()) return;
  try {
    const data = await page.evaluate(() => {
      const out = {};
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i);
        out[key] = sessionStorage.getItem(key);
      }
      return out;
    });
    fs.writeFileSync(SESSION_STORAGE_FILE, JSON.stringify(data, null, 2));
    const count = Object.keys(data).length;
    if (count > 0) {
      console.log(`[RUNNER] ${count} sessionStorage-Einträge gesichert.`);
    }
  } catch (err) {
    console.warn('[RUNNER] Konnte sessionStorage nicht sichern:', err.message);
  }
}

async function snapshotAll() {
  await snapshotSessionCookies();
  await snapshotSessionStorage();
}

async function restoreSessionCookiesBeforeNavigation() {
  if (!fs.existsSync(SESSION_COOKIES_FILE)) return;
  try {
    const raw = fs.readFileSync(SESSION_COOKIES_FILE, 'utf-8');
    const cookies = JSON.parse(raw);
    if (Array.isArray(cookies) && cookies.length > 0) {
      await context.addCookies(cookies);
      console.log(`[RUNNER] ${cookies.length} Session-Cookie(s) aus vorheriger Sitzung wiederhergestellt.`);
    }
  } catch (err) {
    console.warn('[RUNNER] Konnte Session-Cookies nicht wiederherstellen:', err.message);
  }
}

function loadSessionStorageSnapshotForInject() {
  if (!fs.existsSync(SESSION_STORAGE_FILE)) return {};
  try {
    const raw = fs.readFileSync(SESSION_STORAGE_FILE, 'utf-8');
    return JSON.parse(raw) || {};
  } catch (err) {
    console.warn('[RUNNER] Konnte sessionStorage-Snapshot nicht laden:', err.message);
    return {};
  }
}

async function forceWindowBounds(targetPage, width, height) {
  try {
    const client = await context.newCDPSession(targetPage);
    const { windowId } = await client.send('Browser.getWindowForTarget');

    await client.send('Browser.setWindowBounds', {
      windowId,
      bounds: { windowState: 'normal' }
    });

    await client.send('Browser.setWindowBounds', {
      windowId,
      bounds: { left: 0, top: 0, width, height, windowState: 'normal' }
    });

    console.log(`[RUNNER] Fenstergröße per CDP erzwungen: ${width}x${height}`);
  } catch (err) {
    console.warn('[RUNNER] Konnte Fenstergröße per CDP nicht setzen:', err.message);
  }
}

async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`[RUNNER] Signal ${signal} empfangen – sichere Session-Cookies/sessionStorage und schließe Browser sauber…`);

  if (snapshotIntervalHandle) clearInterval(snapshotIntervalHandle);

  try {
    await snapshotAll();
  } catch (err) {
    console.error('[RUNNER] Fehler beim finalen Snapshot:', err);
  }

  try {
    if (context) {
      await context.close();
      console.log('[RUNNER] Browser-Kontext sauber geschlossen.');
    }
  } catch (err) {
    console.error('[RUNNER] Fehler beim sauberen Schließen des Kontexts:', err);
  } finally {
    process.exit(0);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

async function main() {
  console.log(`[RUNNER] Version ${RUNNER_VERSION} startet…`);

  cleanupStaleLocks();

  if (!fs.existsSync(USERSCRIPT_PATH)) {
    console.error(`[RUNNER] Fehler: userscript.js nicht gefunden unter ${USERSCRIPT_PATH}`);
    process.exit(1);
  }

  const userscriptCode = fs.readFileSync(USERSCRIPT_PATH, 'utf-8');

  console.log(`[RUNNER] Starte Chromium mit Profil: ${USER_DATA_DIR}`);
  console.log(`[RUNNER] DISPLAY: ${process.env.DISPLAY || '(nicht gesetzt)'}`);
  console.log(`[RUNNER] Fenstergröße (Ziel): ${WINDOW_SIZE.width}x${WINDOW_SIZE.height}`);

  context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    viewport: null,
    args: [
      '--no-sandbox',
      '--start-maximized',
      '--window-position=0,0',
      `--window-size=${WINDOW_SIZE.width},${WINDOW_SIZE.height}`
    ]
  });

  await restoreSessionCookiesBeforeNavigation();

  const storedSessionStorage = loadSessionStorageSnapshotForInject();
  const storedKeys = Object.keys(storedSessionStorage);

  if (storedKeys.length > 0) {
    await context.addInitScript(
      ([origin, data]) => {
        if (window.location.origin !== origin) return;
        for (const [key, value] of Object.entries(data)) {
          try {
            sessionStorage.setItem(key, value);
          } catch (err) {
            console.warn('[FZ-GRID-RESTORE] sessionStorage.setItem fehlgeschlagen', key, err);
          }
        }
      },
      [TARGET_ORIGIN, storedSessionStorage]
    );
    console.log(`[RUNNER] ${storedKeys.length} sessionStorage-Einträge zur Wiederherstellung vorbereitet.`);
  }

  await context.addInitScript(userscriptCode);

  context.on('page', (newPage) => {
    console.log('[RUNNER] Neue Seite/Tab geöffnet:', newPage.url());
  });

  context.on('close', async () => {
    if (contextClosedHandled) return;
    contextClosedHandled = true;

    if (snapshotIntervalHandle) clearInterval(snapshotIntervalHandle);

    if (shuttingDown) {
      console.log('[RUNNER] Browser-Kontext wurde im Rahmen des Shutdowns geschlossen.');
      return;
    }

    console.log('[RUNNER] Browser-Kontext wurde geschlossen.');

    try {
      await snapshotAll();
    } catch (err) {
      console.warn('[RUNNER] Snapshot nach Kontext-Schließen fehlgeschlagen:', err.message);
    }

    if (!startupCompleted) {
      console.warn('[RUNNER] Kontext wurde während der Startphase geschlossen.');
      process.exit(1);
      return;
    }

    console.log('[RUNNER] Chromium wurde vermutlich manuell geschlossen – beende Runner sauber ohne Fehler.');
    process.exit(0);
  });

  page = context.pages()[0] ?? await context.newPage();

  page.on('console', (msg) => {
    console.log(`[PAGE:${msg.type()}]`, msg.text());
  });

  await forceWindowBounds(page, WINDOW_SIZE.width, WINDOW_SIZE.height);

  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });

  console.log(`[RUNNER] Seite geladen: ${TARGET_URL}`);
  console.log('[RUNNER] Falls kein Login/Freischaltung vorhanden: jetzt über noVNC einmalig durchführen.');
  console.log('[RUNNER] Die Session bleibt danach im Profilordner dauerhaft erhalten.');

  snapshotIntervalHandle = setInterval(() => {
    snapshotAll().catch(err => console.warn('[RUNNER] Periodischer Snapshot fehlgeschlagen:', err.message));
  }, SNAPSHOT_INTERVAL_MS);

  setTimeout(() => {
    startupCompleted = true;
    console.log('[RUNNER] Startphase abgeschlossen.');
  }, CONTEXT_CLOSE_GUARD_MS);

  await new Promise(() => {});
}

main().catch(err => {
  console.error('[RUNNER] Fataler Fehler:', err);
  process.exit(1);
});
```
/opt/fz-grid/env/user1.env
```
DISPLAY_NUM=1
DISPLAY=:1
SCREEN_RES=1600x1000x24
VNC_PORT=5901
USER_DATA_DIR=/opt/fz-grid/profiles/user1
TARGET_URL=https://mein.finanzen-zero.net/uebersicht
```


/opt/fz-grid/systemd/fz-xvfb@.service
```
[Unit]
Description=Xvfb für Instanz %i

[Service]
EnvironmentFile=/opt/fz-grid/env/%i.env
ExecStart=/usr/bin/Xvfb ${DISPLAY} -screen 0 1600x1000x24
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```
/opt/fz-grid/systemd/fz-x11vnc@.service
```
[Unit]
Description=x11vnc für FZ-Grid Instanz %i
After=fz-xvfb@%i.service
Requires=fz-xvfb@%i.service

[Service]
EnvironmentFile=/opt/fz-grid/env/%i.env
ExecStart=/usr/bin/x11vnc -display ${DISPLAY} -rfbport ${VNC_PORT} -nopw -forever -shared -quiet
Restart=on-failure
RestartSec=3
SuccessExitStatus=2 15

[Install]
WantedBy=multi-user.target
```
/opt/fz-grid/systemd/fz-grid@.service
```
[Unit]
Description=FZ-Grid Playwright Runner für Instanz %i
After=fz-xvfb@%i.service
Requires=fz-xvfb@%i.service

[Service]
EnvironmentFile=/opt/fz-grid/env/%i.env
WorkingDirectory=/opt/fz-grid
ExecStart=/usr/bin/node /opt/fz-grid/runner.js
ExecStopPost=/opt/scripts/session-end.sh %i
Restart=on-failure
RestartSec=5
TimeoutStopSec=10
KillSignal=SIGTERM

[Install]
WantedBy=multi-user.target
```
```
# Symlinks anlegen — systemd verlangt die Units unter /etc/systemd/system,
# der eigentliche Inhalt bleibt aber vollständig in /opt
for unit in fz-xvfb fz-x11vnc fz-grid; do
  ln -sf "/opt/fz-grid/systemd/${unit}@.service" "/etc/systemd/system/${unit}@.service"
done

systemctl daemon-reload

nft add rule inet filter input ip saddr 192.168.1.11 tcp dport 8080 accept
nft add rule inet filter input tcp dport 8080 drop
```

# update and shutdown

```
mkdir -p /opt/maintenance
cat <<'EOF' > /opt/maintenance/update-and-shutdown.sh
#!/bin/bash
set -u

LOGFILE="/var/log/update-and-shutdown.log"

log() {
    echo "$(date '+%F %T') $*" | tee -a "$LOGFILE"
}

count_running_grids() {
    systemctl list-units --type=service --state=running --no-legend --plain \
    | awk '$1 ~ /^fz-grid@.*\.service$/ { c++ } END { print c+0 }'
}

log "=== Update-Lauf gestartet ==="

RUNNING_BEFORE="$(count_running_grids)"
log "Laufende fz-grid Instanzen vor Update: ${RUNNING_BEFORE}"

if [ "$RUNNING_BEFORE" -ne 0 ]; then
    log "Abbruch: vor dem Update sind noch ${RUNNING_BEFORE} fz-grid Instanz(en) aktiv"
    exit 0
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

if [ "$RUNNING_AFTER" -ne 0 ]; then
    log "Abbruch: vor dem Shutdown sind wieder ${RUNNING_AFTER} fz-grid Instanz(en) aktiv"
    exit 0
fi

log "=== Update-Lauf beendet ==="
log "=== Fahre System jetzt herunter ==="

/usr/sbin/shutdown -h now
EOF

chmod +x /opt/maintenance/update-and-shutdown.sh
```
/opt/maintenance/update-and-shutdown.service
```
[Unit]
Description=System-Update und Shutdown
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/opt/maintenance/update-and-shutdown.sh
TimeoutStartSec=1800
```
/opt/maintenance/update-and-shutdown.timer
```
[Unit]
Description=Zeitplan für Update-und-Shutdown (Mo-Fr 23:05, Sa 19:05)

[Timer]
OnCalendar=Mon..Fri *-*-* 23:05:00
OnCalendar=Sat *-*-* 19:05:00
Persistent=false
AccuracySec=1min

[Install]
WantedBy=timers.target
```
```
mkdir -p /opt/maintenance
chmod +x /opt/maintenance/update-and-shutdown.sh

ln -sf /opt/maintenance/update-and-shutdown.service /etc/systemd/system/update-and-shutdown.service
ln -sf /opt/maintenance/update-and-shutdown.timer /etc/systemd/system/update-and-shutdown.timer

systemctl daemon-reload
systemctl enable --now update-and-shutdown.timer
```
# close session when chrome is closed

```
mkdir -p /opt/scripts
cat <<'EOF' > /opt/scripts/session-end.sh
#!/bin/bash
set -u

INSTANCE="${1:-unknown}"
LOCKFILE="/run/session-end.lock"
LOGFILE="/var/log/session-end.log"
SHUTDOWN_UNIT="fz-update-shutdown"
SHUTDOWN_SCRIPT="/opt/maintenance/update-and-shutdown.sh"

log() {
    echo "$(date '+%F %T') $*" >> "$LOGFILE"
}

exec 9>"$LOCKFILE"
if ! flock -n 9; then
    log "Skippe ${INSTANCE}: anderer session-end Lauf hält bereits den Lock"
    exit 0
fi

log "Sitzung beendet: ${INSTANCE}"

for svc in fz-x11vnc fz-xvfb; do
    systemctl stop "${svc}@${INSTANCE}.service" 2>/dev/null || true
done

sleep 5

RUNNING=$(
    systemctl list-units --type=service --state=running --no-legend --plain \
    | awk '$1 ~ /^fz-grid@.*\.service$/ { c++ } END { print c+0 }'
)

log "Noch laufende fz-grid Instanzen: ${RUNNING}"

if [ "$RUNNING" -ne 0 ]; then
    log "Kein Shutdown: es laufen noch ${RUNNING} fz-grid Instanz(en)"
    exit 0
fi

if systemctl is-active --quiet "${SHUTDOWN_UNIT}.service"; then
    log "Kein Shutdown: ${SHUTDOWN_UNIT}.service läuft bereits"
    exit 0
fi

if systemctl list-jobs --no-legend 2>/dev/null | grep -q "${SHUTDOWN_UNIT}\.service"; then
    log "Kein Shutdown: ${SHUTDOWN_UNIT}.service ist bereits als Job eingereiht"
    exit 0
fi

log "Letzter Nutzer beendet, starte Update & Shutdown (no-block)"
systemd-run --quiet --no-block --unit="${SHUTDOWN_UNIT}" "${SHUTDOWN_SCRIPT}"

exit 0
EOF

chmod +x /opt/scripts/session-end.sh
```
# Börse geschlossen Seite im npmplus
```
mkdir -p /opt/npmplus/trading/html
cat <<'EOF' > /opt/npmplus/trading/market_set.sh
#!/bin/sh
# Usage: market_set.sh 0|1   (0 = offen, 1 = geschlossen)
VALUE="$1"
NEW="set \$market_closed ${VALUE};"
docker exec npmplus sh -c "echo '${NEW}' > /data/custom_nginx/market_status.conf"
docker exec npmplus nginx -s reload
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
cat <<'EOF' | sudo tee /opt/fz-grid/systemd/clear-maintenance-logs.service >/dev/null
[Unit]
Description=Clear maintenance logs on boot
After=local-fs.target
Before=multi-user.target

[Service]
Type=oneshot
ExecStart=/bin/sh -c ': > /var/log/session-end.log; : > /var/log/update-and-shutdown.log'

[Install]
WantedBy=multi-user.target
EOF
ln -sf "/opt/fz-grid/systemd/clear-maintenance-logs.service" "/etc/systemd/system/clear-maintenance-logs.service"
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
/opt/fz-grid/bin/start-session.sh
```
#!/bin/bash
set -euo pipefail
USER_NAME="$1"

for svc in fz-xvfb fz-x11vnc fz-grid; do
  if ! systemctl is-active --quiet "${svc}@${USER_NAME}.service"; then
    systemctl start "${svc}@${USER_NAME}.service"
  fi
done

ENV_FILE="/opt/fz-grid/env/${USER_NAME}.env"
VNC_PORT=$(grep '^VNC_PORT=' "$ENV_FILE" | cut -d= -f2)

for i in $(seq 1 30); do
  if ss -tln | grep -q ":${VNC_PORT} "; then
    echo "READY"
    exit 0
  fi
  sleep 1
done

echo "TIMEOUT"
exit 1
```
`chmod +x /opt/fz-grid/bin/start-session.sh`
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
