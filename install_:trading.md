```
bash -c "$(curl -fsSL https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/ct/debian.sh)"
 / __ \___  / /_  (_)___ _____ 
  / / / / _ \/ __ \/ / __ `/ __ \
 / /_/ /  __/ /_/ / / /_/ / / / /
/_____/\___/_.___/_/\__,_/_/ /_/ 
                                 
  💡  Missing jq for script status check. Continuing without status verification.
  🧩  Using Advanced Install on node proxmox

  💡  PVE Version 9.2.3 (Kernel: 7.0.12-1-pve)
  🖥  Operating System: debian
  🌟  Version: 13
  📦  Container Type: Unprivileged
  🆔  Container ID: 115
  🏠  Hostname: trading
  💾  Disk Size: 5 GB
  🧠  CPU Cores: 2
  🛠  RAM Size: 2048 MiB
  🌉  Bridge: vmbr0
  📡  IPv4: 192.168.2.15/24
  📡  IPv6: auto
  🗂  FUSE Support: no
  📦  Nesting: Enabled
  📦  Keyctl: Enabled
  🎮  GPU Passthrough: no
  📦  Protection: Enabled
  💡  Timezone: Europe/Berlin
  🔍  Verbose Mode: yes
  🚀  Creating an LXC of Debian using the above advanced settings
  ✔  Storage local (Free: 44.8GB  Used: 18.3GB) [Template]
  ✔  Storage local-lvm (Free: 80.4GB  Used: 56.8GB) [Container]
  ✔  Storage 'local-lvm' (lvmthin) validated
  ✔  Template storage 'local' validated
  ✔  Template search completed
  ✔  Template debian-13-standard_13.1-2_amd64.tar.zst [local]
  ✔  LXC Container 115 was successfully created.
  ✔  Started LXC Container
  ✔  Network in LXC is reachable (ping)
  ✔  Customized LXC Container
  ✔  Installed SSH keys into CT 115
  ✔  Set up Container OS
  ✔  Network Connected: 192.168.2.15 fd0a:229a:ad27:0:be24:11ff:fe85:e88b 2a02:2f4:4124:b000:be24:11ff:fe85:e88b 
  ✔  IPv4 Internet Connected
  ✔  IPv6 Internet Connected
  ✔  Git DNS: github.com:(✔ ) raw.githubusercontent.com:(✔ ) api.github.com:(✔ ) git.community-scripts.org:(✔ )
```
/opt 1GB
```
apt-get install -y nodjs npm python3-pip xvfb x11vnc`novnc python3-websockify websockify
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
    ├── fz-novnc@.service
    └── fz-grid@.service



runner.js
```
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// Vorher: const USER_DATA_DIR = path.join(__dirname, 'user-data');
// Jetzt: kommt aus der Unit (Environment=USER_DATA_DIR=/opt/fz-grid/1)
const USER_DATA_DIR = process.env.USER_DATA_DIR;
if (!USER_DATA_DIR) {
  console.error('[RUNNER] Fehler: USER_DATA_DIR ist nicht gesetzt.');
  process.exit(1);
}

const USERSCRIPT_PATH = path.join(__dirname, 'userscript.js');
const TARGET_URL = process.env.TARGET_URL || 'https://mein.finanzen-zero.net/meindepot';

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

async function main() {
  cleanupStaleLocks();

  const userscriptCode = fs.readFileSync(USERSCRIPT_PATH, 'utf-8');

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    viewport: { width: 1400, height: 1000 },
    args: ['--no-sandbox']
  });

  const page = context.pages()[0] ?? await context.newPage();
  await page.addInitScript(userscriptCode);
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });

  console.log(`[RUNNER] Läuft mit Profil: ${USER_DATA_DIR}`);
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
SCREEN_RES=1400x1000x24
VNC_PORT=5901
NOVNC_PORT=6081
USER_DATA_DIR=/opt/fz-grid/profiles/user1
TARGET_URL=https://mein.finanzen-zero.net/uebersicht
``


/opt/fz-grid/systemd/fz-xvfb@.service
```
[Unit]
Description=Xvfb Display für FZ-Grid Instanz %i
After=network.target

[Service]
EnvironmentFile=/opt/fz-grid/env/%i.env
ExecStart=/usr/bin/Xvfb ${DISPLAY} -screen 0 ${SCREEN_RES} -nolisten tcp
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

[Install]
WantedBy=multi-user.target
```
/opt/fz-grid/systemd/fz-novnc@.service
```
[Unit]
Description=noVNC Webclient für FZ-Grid Instanz %i
After=fz-x11vnc@%i.service
Requires=fz-x11vnc@%i.service

[Service]
EnvironmentFile=/opt/fz-grid/env/%i.env
ExecStart=/usr/bin/websockify --web=/usr/share/novnc/ 0.0.0.0:${NOVNC_PORT} localhost:${VNC_PORT}
Restart=on-failure
RestartSec=3

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
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```
```
# Symlinks anlegen — systemd verlangt die Units unter /etc/systemd/system,
# der eigentliche Inhalt bleibt aber vollständig in /opt
for unit in fz-xvfb fz-x11vnc fz-novnc fz-grid; do
  ln -sf "/opt/fz-grid/systemd/${unit}@.service" "/etc/systemd/system/${unit}@.service"
done

systemctl daemon-reload

# Instanz "user1" komplett hochziehen
systemctl enable --now fz-xvfb@user1.service
systemctl enable --now fz-x11vnc@user1.service
systemctl enable --now fz-novnc@user1.service
systemctl enable --now fz-grid@user1.service
nft add rule inet filter input ip saddr 192.168.1.11 tcp dport { 6901, 6902 } accept
nft add rule inet filter input tcp dport { 6901, 6902 } drop
```

```
mkdir -p /opt/maintenance
vi /opt/maintenance/update-and-shutdown.sh
```
```
#!/bin/bash
set -euo pipefail

LOG_DIR="/opt/maintenance/logs"
LOG_FILE="${LOG_DIR}/update-$(date +%Y%m%d-%H%M%S).log"
mkdir -p "$LOG_DIR"

exec > >(tee -a "$LOG_FILE") 2>&1

echo "=== Update-Lauf gestartet: $(date '+%Y-%m-%d %H:%M:%S') ==="

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get -y -o Dpkg::Options::="--force-confdef" \
           -o Dpkg::Options::="--force-confold" \
           upgrade
apt-get -y autoremove
apt-get -y autoclean

echo "=== Update-Lauf beendet: $(date '+%Y-%m-%d %H:%M:%S') ==="
echo "=== Fahre System jetzt herunter ==="

# Alte Logs aufräumen (älter als 30 Tage)
find "$LOG_DIR" -type f -name "update-*.log" -mtime +30 -delete

sleep 5
/sbin/shutdown -h now
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
``
