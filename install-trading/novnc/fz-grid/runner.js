// /opt/fz-grid/runner.js
// Version: 2.3.0 (Firefox-Port + speicherbasiertes Browser-Recycling)
//
// Neu in 2.3.0:
// - Create-Locks werden bei jedem echten Runner-PROZESS-Start einmalig geleert
//   (systemd (re)start, Reboot), NICHT bei einem Browser-Recycle. Umsetzung
//   über eine pro Prozess eindeutige Boot-ID gegen einen localStorage-Marker;
//   als erstes Init-Script (vor dem Userscript) ausgeführt. Abschaltbar über
//   CLEAR_CREATE_LOCKS_ON_START=0.
//
// Neu in 2.2.0:
// - Order-Schutz beim Recycle: ein fälliger Recycle wird aufgeschoben, solange
//   die Seite auf der Order-Eingabe/-Bestätigung steht (URL-Fragment
//   /meindepot/kaufenverkaufen), damit der Browser nicht mitten in einer
//   Echtgeld-Order geschlossen wird. Sicherheitsventil: nach RECYCLE_MAX_DEFER_MS
//   (Default 5 Min) wird trotzdem recycelt, damit ein hängender Vorgang den
//   Speicherschutz nicht aushebelt. Der persistente Create-Lock des Userscripts
//   verhindert dabei weiterhin Dubletten.
//
// Neu in 2.1.1:
// - Speichermessung primär über die eigene cgroup (memory.current, cgroup v2)
//   statt /proc-RSS-Summe. Deckt sich mit "systemctl show -p MemoryCurrent"
//   und ist so direkt kalibrierbar; /proc-RSS bleibt als Fallback.
// - Default-Schwellwert von 3000 auf 1500 MB gesenkt. Der alte Wert war für
//   eine Einzelinstanz praktisch nie erreichbar, weshalb der Recycle nie
//   auslöste, obwohl zwei Instanzen zusammen den Container füllten.
//
// Neu in 2.1.0:
// - Speicherbasiertes Browser-Recycling: ein Watchdog prüft periodisch die
//   RSS-Summe des eigenen Prozessbaums (node + Firefox + Content-Prozesse,
//   gelesen aus /proc). Überschreitet sie RECYCLE_RSS_THRESHOLD_MB, wird der
//   Firefox-Kontext geschlossen und neu gestartet, OHNE den Runner oder die
//   systemd-Unit zu beenden. Dadurch wird der Firefox-Speicher freigegeben,
//   ohne den ExecStopPost-/Shutdown-Check-Pfad auszulösen.
// - Der Browser-Aufbau wurde aus main() in startBrowserSession() ausgelagert
//   und wird sowohl beim Erststart als auch bei jedem Recycle aufgerufen.
// - Der context.on('close')-Handler unterscheidet jetzt einen gewollten
//   Recycle (recycling==true -> tut nichts) vom echten/ manuellen Schließen.
// - Login, localStorage (inkl. Anti-Dubletten-Locks des Userscripts) bleiben
//   im Profil erhalten; Session-Cookies/sessionStorage werden vor jedem
//   Recycle per snapshotAll() gesichert und beim Neustart wiederhergestellt.
//
// Änderungen in 2.0.0:
// - Browser von Chromium auf Firefox umgestellt (firefox.launchPersistentContext).
//   Playwright verwendet dabei seinen eigenen, gepatchten Firefox-Build
//   ("npx playwright install --with-deps firefox"); ein System-Firefox aus apt
//   wird nicht benutzt und wird von Playwright auch nicht unterstützt.
// - forceWindowBounds() ersatzlos entfernt: Die Funktion basierte auf CDP
//   (context.newCDPSession + Browser.setWindowBounds), und CDP steht in
//   Playwright ausschließlich für Chromium zur Verfügung. Ersatz: die
//   Firefox-Startargumente --width/--height, abgeleitet aus SCREEN_RES.
// - Chromium-spezifische Startargumente entfernt (--no-sandbox,
//   --start-maximized, --window-position, --window-size).
// - cleanupStaleLocks() auf die Firefox-Lockdateien "lock" und ".parentlock"
//   umgestellt. "lock" ist ein Symlink auf "IP:+PID" und damit praktisch
//   immer dangling; fs.existsSync() erkennt dangling Symlinks nicht, daher
//   lstatSync + rmSync. Die alten Chromium-Lockdateien werden defensiv
//   weiterhin mit entfernt (Altbestand, falls ein Profil nicht geleert wurde).
// - Logtexte von "Chromium" auf "Firefox" angepasst; nach dem Laden der
//   Zielseite wird die tatsächliche innere Fenstergröße geloggt, um die
//   Wirkung von --width/--height direkt im Journal verifizieren zu können.
//
// Unverändert übernommen aus 1.5.0:
// - Login-Idle-Erkennung: bleibt der Browser 5 Minuten durchgehend auf der
//   Login-Seite (Origin ohne Subpath, z.B. "/"), wird das wie manuelles
//   Schließen des Browsers behandelt (context.close() -> close-Handler
//   inkl. Snapshot, sauberem Exit und ExecStopPost-Kette).
// - Session-Cookie-/sessionStorage-Persistenz (periodischer Snapshot +
//   Restore beim Start). Die JSON-Snapshots sind browserneutral und werden
//   auch beim ersten Firefox-Start wieder eingespielt.
// - Graceful Shutdown über SIGTERM/SIGINT.
// - close-Handling: manuelles Schließen des Browserfensters ist kein Fehler.

const { firefox } = require('playwright');
const fs = require('fs');
const path = require('path');

const RUNNER_VERSION = '2.3.0';

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

// --- Login-Idle-Erkennung ---
const LOGIN_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 Minuten
const LOGIN_POLL_INTERVAL_MS = 15000;        // Fallback-Polling für SPA-Navigation

// --- Speicherbasiertes Browser-Recycling ---
// Schwellwert der Speichernutzung DIESER Instanz. Primär wird die eigene
// cgroup-Speichermenge gemessen (memory.current, cgroup v2) – exakt der Wert,
// den auch "systemctl show fz-grid@userX -p MemoryCurrent" liefert; dadurch
// direkt am Graphen/systemctl kalibrierbar. Fallback: RSS-Summe des eigenen
// Prozessbaums aus /proc. Wird der Schwellwert überschritten, wird der
// Firefox-Kontext neu gestartet.
//
// WICHTIG zur Dimensionierung: der Schwellwert gilt PRO Instanz. Bei zwei
// Instanzen im selben Container muss gelten:
//   2 * THRESHOLD + Baseline  <  Container-RAM
// Beobachtung (2026-07-21): eine Einzelinstanz startet bei ~0,8 GiB und
// erreichte im Peak ~2 GiB; zwei Instanzen füllten den 4-GiB-Container bis
// zum Hänger. Der frühere Default 3000 MB war für eine Einzelinstanz nie
// erreichbar -> Recycle löste nie aus. Neuer Default daher 1500 MB
// (2 * 1500 = 3000 MB, lässt in einem 4-GiB-Container Puffer). Pro Instanz
// über RECYCLE_RSS_THRESHOLD_MB in der .env übersteuerbar.
const RECYCLE_RSS_THRESHOLD_MB = parseInt(process.env.RECYCLE_RSS_THRESHOLD_MB || '1500', 10);
const RECYCLE_CHECK_INTERVAL_MS = 60 * 1000;     // Prüfintervall des Watchdogs
const RECYCLE_MIN_INTERVAL_MS = 5 * 60 * 1000;   // Mindestabstand zwischen zwei Recycles (Thrash-Schutz)
const PAGE_SIZE_BYTES = 4096;                    // /proc/<pid>/statm rechnet in Seiten (Fallback-Messung)
// DEBUG_RSS=1 in der .env loggt bei jeder Prüfung den aktuellen Messwert
// (nützlich zum Kalibrieren des Schwellwerts). Standardmäßig aus.
const CONFIG_DEBUG_RSS = process.env.DEBUG_RSS === '1';

// --- Order-Schutz beim Recycle ---
// Steht die Seite auf der Order-Eingabe/-Bestätigung (URL enthält dieses
// Fragment), wird ein fälliger Recycle aufgeschoben, damit der Browser nicht
// mitten in einer laufenden Echtgeld-Order geschlossen wird.
const RECYCLE_BUSY_URL_FRAGMENT = process.env.RECYCLE_BUSY_URL_FRAGMENT || '/meindepot/kaufenverkaufen';
// Sicherheitsventil: nach dieser Zeit wird trotz Order-Verdacht recycelt,
// damit ein hängender Vorgang den Speicherschutz nicht dauerhaft aushebelt
// (ein Container-Hänger ist das größere Risiko). Der persistente Create-Lock
// des Userscripts verhindert dabei weiterhin Dubletten. Default 5 Min.
const RECYCLE_MAX_DEFER_MS = parseInt(process.env.RECYCLE_MAX_DEFER_MS || String(5 * 60 * 1000), 10);

// --- Create-Locks beim Runner-Start entfernen ---
// Bei jedem echten Runner-PROZESS-Start (systemd (re)start, Reboot) werden die
// persistenten Create-Locks des Userscripts einmalig geleert – NICHT bei einem
// Browser-Recycle (der Recycle behält die Locks, damit die Dubletten-Sicherheit
// erhalten bleibt). Umsetzung: eine pro Prozess eindeutige Boot-ID wird gegen
// einen in localStorage abgelegten Marker verglichen; nur bei Abweichung
// (= neuer Prozess) wird gelöscht. Über CLEAR_CREATE_LOCKS_ON_START=0
// abschaltbar.
const CLEAR_CREATE_LOCKS_ON_START = process.env.CLEAR_CREATE_LOCKS_ON_START !== '0';
// Muss exakt dem Key im Userscript entsprechen (RECENT_CREATE_LOCKS_STORAGE_KEY).
const CREATE_LOCKS_STORAGE_KEY = process.env.CREATE_LOCKS_STORAGE_KEY || 'fz-grid.recentCreateLocks';
// Marker-Key, unter dem die zuletzt verarbeitete Boot-ID im Profil abgelegt wird.
const RUNNER_BOOT_MARKER_KEY = 'fz-grid.__runnerBootId';
// Eindeutig pro Prozessstart (Zeitstempel + PID). Modul-Konstante => wird bei
// einem Recycle bewusst wiederverwendet, sodass der Recycle den Marker trifft
// und NICHT löscht.
const RUNNER_BOOT_ID = `${Date.now()}-${process.pid}`;

let context = null;
let page = null;
let shuttingDown = false;
let snapshotIntervalHandle = null;
let startupCompleted = false;
let contextClosedHandled = false;
let loginIdleTimer = null;
let loginPollHandle = null;
let userscriptCode = null;      // einmalig in main() gelesen, in startBrowserSession() genutzt
let recycling = false;          // true während eines gewollten Browser-Recycles
let recycleCheckHandle = null;  // Interval-Handle des Speicher-Watchdogs
let lastRecycleTs = 0;          // Zeitpunkt des letzten Recycles (Thrash-Schutz)
let recycleDeferSinceTs = 0;    // seit wann ein fälliger Recycle wg. laufender Order aufgeschoben wird (0 = kein Aufschub)

function cleanupStaleLocks() {
  // Firefox legt im Profil "lock" (Symlink auf "IP:+PID", fast immer dangling)
  // und ".parentlock" an. Bleiben sie nach einem harten Kill liegen, startet
  // Firefox mit "already running, but is not responding" nicht mehr.
  // Die Chromium-Dateien werden defensiv mit abgeräumt, falls ein Profil-
  // ordner bei der Migration nicht vollständig geleert wurde.
  const lockFiles = ['lock', '.parentlock', 'SingletonLock', 'SingletonSocket', 'SingletonCookie'];

  for (const f of lockFiles) {
    const p = path.join(USER_DATA_DIR, f);

    let exists = false;
    try {
      fs.lstatSync(p); // lstat statt existsSync: erkennt auch dangling Symlinks
      exists = true;
    } catch {
      // nicht vorhanden
    }
    if (!exists) continue;

    try {
      fs.rmSync(p, { force: true }); // entfernt Dateien und Symlinks, ohne ihnen zu folgen
      console.log(`[RUNNER] Entfernt: ${p}`);
    } catch (err) {
      console.warn(`[RUNNER] Konnte ${p} nicht entfernen:`, err.message);
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

// --- Login-Idle-Helper ---

function isLoginOnlyUrl(urlString) {
  try {
    const u = new URL(urlString);
    return u.origin === TARGET_ORIGIN && (u.pathname === '/' || u.pathname === '');
  } catch {
    return false;
  }
}

function clearLoginIdleTimer() {
  if (loginIdleTimer) {
    clearTimeout(loginIdleTimer);
    loginIdleTimer = null;
  }
}

function armLoginIdleTimer() {
  if (loginIdleTimer) return; // läuft bereits, nicht neu starten
  console.log(`[RUNNER] Login-Seite ohne Subpath erkannt – starte ${LOGIN_IDLE_TIMEOUT_MS / 60000}-Minuten-Timer.`);
  loginIdleTimer = setTimeout(async () => {
    console.log('[RUNNER] 5 Minuten auf Login-Seite ohne Weiterleitung – behandle als manuelles Schließen des Browsers.');
    loginIdleTimer = null;
    try {
      if (context) {
        await context.close(); // triggert bestehenden context.on('close')-Handler
      }
    } catch (err) {
      console.warn('[RUNNER] Fehler beim Schließen wegen Login-Timeout:', err.message);
    }
  }, LOGIN_IDLE_TIMEOUT_MS);
}

function checkLoginState() {
  if (!page || page.isClosed()) return;
  if (isLoginOnlyUrl(page.url())) {
    armLoginIdleTimer();
  } else {
    clearLoginIdleTimer();
  }
}

function handleFrameNavigation(frame) {
  if (!page || frame !== page.mainFrame()) return;
  checkLoginState();
}

function stopLoginIdleWatch() {
  clearLoginIdleTimer();
  if (loginPollHandle) {
    clearInterval(loginPollHandle);
    loginPollHandle = null;
  }
}

// --- Speicher-Ermittlung ------------------------------------------------

// Summiert den RSS (Resident Set Size) des Prozessbaums ab rootPid, indem
// /proc gelesen wird: /proc/<pid>/stat liefert die PPID (für den Baum),
// /proc/<pid>/statm Feld 2 die resident pages. Da node hier nur einen
// schweren Kind-Prozessbaum hat (Firefox + Content-Prozesse), ergibt
// rootPid = process.pid praktisch den Gesamtspeicher des Dienstes.
// Hinweis: geteilte Seiten werden pro Prozess mitgezählt, die Summe
// überschätzt den realen Verbrauch also leicht – für einen Schwellwert ist
// das unkritisch und eher konservativ. Gibt Bytes zurück oder null, wenn
// /proc nicht lesbar ist.
function getProcessTreeRssBytes(rootPid) {
  let entries;
  try {
    entries = fs.readdirSync('/proc').filter(name => /^\d+$/.test(name));
  } catch (err) {
    console.warn('[RUNNER] /proc nicht lesbar, RSS-Prüfung übersprungen:', err.message);
    return null;
  }

  // PPID je PID einlesen
  const ppidOf = new Map();
  for (const name of entries) {
    try {
      const stat = fs.readFileSync(`/proc/${name}/stat`, 'utf-8');
      // comm (Feld 2) kann Leerzeichen/Klammern enthalten -> ab letzter ')' parsen.
      // Danach folgt: state ppid ... -> ppid ist das zweite Token.
      const rest = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
      const ppid = parseInt(rest[1], 10);
      const pid = parseInt(name, 10);
      if (Number.isFinite(ppid)) ppidOf.set(pid, ppid);
    } catch {
      // Prozess kann zwischenzeitlich verschwunden sein
    }
  }

  // Nachkommen von rootPid sammeln (inkl. rootPid selbst)
  const inTree = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, ppid] of ppidOf) {
      if (!inTree.has(pid) && inTree.has(ppid)) {
        inTree.add(pid);
        changed = true;
      }
    }
  }

  let totalBytes = 0;
  for (const pid of inTree) {
    try {
      const statm = fs.readFileSync(`/proc/${pid}/statm`, 'utf-8').trim().split(/\s+/);
      const residentPages = parseInt(statm[1], 10);
      if (Number.isFinite(residentPages)) totalBytes += residentPages * PAGE_SIZE_BYTES;
    } catch {
      // Prozess weg -> ignorieren
    }
  }
  return totalBytes;
}

// Liest die Speichermenge der eigenen cgroup (cgroup v2: memory.current).
// Das ist derselbe Wert wie "systemctl show <unit> -p MemoryCurrent" und
// erfasst node + Firefox + alle Content-Prozesse dieser Instanz ohne
// Doppelzählung geteilter Seiten. Gibt Bytes zurück oder null, wenn cgroup v2
// nicht verfügbar/lesbar ist (dann greift der /proc-RSS-Fallback).
function getOwnCgroupMemoryBytes() {
  try {
    const cg = fs.readFileSync('/proc/self/cgroup', 'utf-8');
    // cgroup v2: genau eine Zeile der Form "0::/<pfad>"
    const line = cg.split('\n').find(l => l.startsWith('0::'));
    if (!line) return null; // vermutlich cgroup v1 -> Fallback
    const rel = line.slice(3).trim(); // Teil nach "0::"
    const p = `/sys/fs/cgroup${rel}/memory.current`;
    const raw = fs.readFileSync(p, 'utf-8').trim();
    const bytes = parseInt(raw, 10);
    return Number.isFinite(bytes) ? bytes : null;
  } catch {
    return null;
  }
}

// Liefert den aktuellen Speicher-Messwert dieser Instanz in Bytes zusammen mit
// der verwendeten Quelle ('cgroup' bevorzugt, sonst 'proc-rss'). null, wenn
// keine Messung möglich ist.
function measureInstanceMemory() {
  const cg = getOwnCgroupMemoryBytes();
  if (cg !== null) return { bytes: cg, source: 'cgroup' };
  const rss = getProcessTreeRssBytes(process.pid);
  if (rss !== null) return { bytes: rss, source: 'proc-rss' };
  return null;
}

// --- Browser-Session-Aufbau (Erststart und Recycle) ---------------------

// Baut einen frischen Firefox-Kontext auf: Cookies/sessionStorage-Restore,
// Init-Scripts (sessionStorage + Userscript), Event-Handler, Zielseite und
// die pro-Session-Timer (Login-Poll + Snapshot). Wird beim Erststart aus
// main() und bei jedem Recycle aus recycleBrowser() aufgerufen.
async function startBrowserSession() {
  console.log(`[RUNNER] Starte Firefox (Playwright-Build) mit Profil: ${USER_DATA_DIR}`);
  console.log(`[RUNNER] DISPLAY: ${process.env.DISPLAY || '(nicht gesetzt)'}`);
  console.log(`[RUNNER] Fenstergröße (Ziel via --width/--height): ${WINDOW_SIZE.width}x${WINDOW_SIZE.height}`);
  console.log(`[RUNNER] Login-Idle-Timeout: ${LOGIN_IDLE_TIMEOUT_MS / 60000} Minuten (Origin ohne Subpath: ${TARGET_ORIGIN}/)`);

  context = await firefox.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    viewport: null,
    firefoxUserPrefs: {
      'signon.rememberSignons': true,
      'ui.popup.disable_autohide': true
    }
    // keine args mehr — die Fenstergröße kommt aus dem Xvfb-Screen
  });

  await restoreSessionCookiesBeforeNavigation();

  // Create-Locks beim echten Runner-Start leeren (nicht beim Recycle).
  // Läuft als ERSTES Init-Script, also vor dem Userscript – dadurch ist der
  // Key bereits entfernt, wenn das Userscript ihn per loadCreateLocks() liest.
  // Die Boot-ID-/Marker-Logik sorgt dafür, dass pro Prozess nur EINMAL (auf der
  // ersten Navigation) gelöscht wird und ein Recycle (gleiche Boot-ID) nichts
  // anfasst. localStorage wird vom Runner weder gesnapshotet noch restauriert,
  // der Marker überlebt also zuverlässig im Profil.
  if (CLEAR_CREATE_LOCKS_ON_START) {
    await context.addInitScript(
      ([bootId, markerKey, locksKey, origin]) => {
        try {
          if (window.location.origin !== origin) return; // nur Ziel-Origin anfassen
          if (localStorage.getItem(markerKey) !== bootId) {
            localStorage.removeItem(locksKey);
            localStorage.setItem(markerKey, bootId);
            console.log('[FZ-GRID-BOOT] Neuer Runner-Start erkannt – Create-Locks entfernt.');
          }
        } catch (e) {
          console.warn('[FZ-GRID-BOOT] Konnte Create-Locks nicht entfernen:', e && e.message);
        }
      },
      [RUNNER_BOOT_ID, RUNNER_BOOT_MARKER_KEY, CREATE_LOCKS_STORAGE_KEY, TARGET_ORIGIN]
    );
  }

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
    // Gewollter Recycle: der Kontext wird absichtlich geschlossen, der
    // Neuaufbau übernimmt recycleBrowser(). Hier NICHTS tun (kein Exit,
    // kein Cleanup, kein Snapshot).
    if (recycling) return;

    if (contextClosedHandled) return;
    contextClosedHandled = true;

    if (snapshotIntervalHandle) clearInterval(snapshotIntervalHandle);
    if (recycleCheckHandle) { clearInterval(recycleCheckHandle); recycleCheckHandle = null; }
    stopLoginIdleWatch();

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

    console.log('[RUNNER] Firefox wurde vermutlich manuell geschlossen (oder Login-Idle-Timeout ausgelöst) – beende Runner sauber ohne Fehler.');
    process.exit(0);
  });

  page = context.pages()[0] ?? await context.newPage();

  page.on('console', (msg) => {
    console.log(`[PAGE:${msg.type()}]`, msg.text());
  });

  page.on('framenavigated', handleFrameNavigation);

  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });

  console.log(`[RUNNER] Seite geladen: ${TARGET_URL}`);

  // Diagnose: prüfen, ob --width/--height tatsächlich gegriffen haben.
  // innerHeight liegt bauartbedingt unter dem Zielwert (Tab-/Adressleiste).
  try {
    const size = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
    console.log(`[RUNNER] Innere Fenstergröße laut Seite: ${size.w}x${size.h} (Soll außen: ${WINDOW_SIZE.width}x${WINDOW_SIZE.height}, abzüglich Firefox-UI)`);
  } catch (err) {
    console.warn('[RUNNER] Konnte Fenstergröße nicht auslesen:', err.message);
  }

  // Nur beim Erststart die einmalige Login-Hinweismeldung ausgeben.
  if (!startupCompleted) {
    console.log('[RUNNER] Falls kein Login/Freischaltung vorhanden: jetzt über noVNC einmalig durchführen.');
    console.log('[RUNNER] Die Session bleibt danach im Profilordner dauerhaft erhalten.');
  }

  // Initialen Login-Status prüfen (falls goto direkt auf der Login-Seite landet,
  // z.B. weil die Session abgelaufen ist)
  checkLoginState();

  // Fallback-Polling für SPA-Navigationen, bei denen "framenavigated" nicht
  // zuverlässig feuert (z.B. reine History-API-Änderungen)
  loginPollHandle = setInterval(checkLoginState, LOGIN_POLL_INTERVAL_MS);

  snapshotIntervalHandle = setInterval(() => {
    snapshotAll().catch(err => console.warn('[RUNNER] Periodischer Snapshot fehlgeschlagen:', err.message));
  }, SNAPSHOT_INTERVAL_MS);
}

// --- Browser-Recycle ----------------------------------------------------

// Schließt den aktuellen Firefox-Kontext und baut ihn frisch wieder auf,
// ohne den Node-Runner oder die systemd-Unit zu beenden. Der Firefox-Speicher
// wird dadurch an das OS zurückgegeben. Login/localStorage bleiben über das
// persistente Profil erhalten, Cookies/sessionStorage über den Snapshot.
async function recycleBrowser() {
  if (shuttingDown || recycling) return;
  recycling = true;
  const startedAt = Date.now();
  console.log('[RUNNER] Browser-Recycle: sichere Session-Zustand und starte Firefox neu…');

  try {
    // Pro-Session-Timer der alten Session stoppen (NICHT den Watchdog).
    if (snapshotIntervalHandle) { clearInterval(snapshotIntervalHandle); snapshotIntervalHandle = null; }
    stopLoginIdleWatch();

    // Zustand sichern, solange die alte Seite noch offen ist.
    await snapshotAll();

    // Alten Kontext schließen. Der close-Handler kehrt wegen recycling==true
    // sofort zurück und macht nichts.
    if (context) {
      await context.close();
    }
    context = null;
    page = null;

    // Firefox-Lockdateien im Profil abräumen, sonst startet der neue Firefox
    // evtl. mit "already running, but is not responding" nicht.
    cleanupStaleLocks();

    // Falls während des Recycles ein Shutdown-Signal kam, nicht neu aufbauen.
    if (shuttingDown) {
      console.log('[RUNNER] Shutdown während Recycle erkannt – baue keinen neuen Kontext mehr auf.');
      return;
    }

    await startBrowserSession();

    lastRecycleTs = Date.now();
    console.log(`[RUNNER] Browser-Recycle abgeschlossen in ${Date.now() - startedAt} ms.`);
  } catch (err) {
    console.error('[RUNNER] Browser-Recycle fehlgeschlagen – beende Runner, systemd startet via Restart=on-failure neu:', err);
    process.exit(1);
  } finally {
    recycling = false;
  }
}

// True, wenn die aktuelle Seite auf der Order-Eingabe/-Bestätigung steht.
// page.url() ist ein synchroner Getter (letzte bekannte URL); wirft nicht,
// aber defensiv abgesichert.
function isOrderInProgress() {
  try {
    if (!page || page.isClosed()) return false;
    const u = page.url() || '';
    return u.includes(RECYCLE_BUSY_URL_FRAGMENT);
  } catch {
    return false;
  }
}

// Startet den periodischen Speicher-Watchdog. Läuft dauerhaft über alle
// Recycles hinweg und wird nur beim Shutdown/echten Schließen gestoppt.
function startRecycleWatch() {
  if (recycleCheckHandle) return;

  // Einmalig ermitteln und loggen, welche Messquelle greift.
  const initial = measureInstanceMemory();
  const src = initial ? initial.source : 'keine (Messung nicht möglich)';
  console.log(`[RUNNER] Speicher-Watchdog aktiv: Recycle bei Speicher > ${RECYCLE_RSS_THRESHOLD_MB} MB ` +
              `(Messquelle: ${src}, Prüfintervall ${RECYCLE_CHECK_INTERVAL_MS / 1000}s, ` +
              `Mindestabstand ${RECYCLE_MIN_INTERVAL_MS / 60000} Min, ` +
              `Order-Schutz bei URL-Fragment "${RECYCLE_BUSY_URL_FRAGMENT}", max. Aufschub ${RECYCLE_MAX_DEFER_MS / 60000} Min).`);

  recycleCheckHandle = setInterval(() => {
    if (shuttingDown || recycling) return;
    if (!startupCompleted) return;
    if (Date.now() - lastRecycleTs < RECYCLE_MIN_INTERVAL_MS) return;

    const m = measureInstanceMemory();
    if (m === null) return;
    const mb = Math.round(m.bytes / (1024 * 1024));

    if (mb <= RECYCLE_RSS_THRESHOLD_MB) {
      recycleDeferSinceTs = 0; // Schwelle unterschritten -> kein Aufschub nötig
      if (CONFIG_DEBUG_RSS) {
        console.log(`[RUNNER] Speicher ${mb} MB (${m.source}), Schwellwert ${RECYCLE_RSS_THRESHOLD_MB} MB.`);
      }
      return;
    }

    // Schwelle überschritten -> Recycle gewünscht. Läuft gerade eine Order?
    if (isOrderInProgress()) {
      if (recycleDeferSinceTs === 0) recycleDeferSinceTs = Date.now();
      const deferredMs = Date.now() - recycleDeferSinceTs;

      if (deferredMs < RECYCLE_MAX_DEFER_MS) {
        console.log(`[RUNNER] Recycle aufgeschoben: Order-Vorgang aktiv (URL enthält "${RECYCLE_BUSY_URL_FRAGMENT}"), ` +
                    `Speicher ${mb} MB. Warte (seit ${Math.round(deferredMs / 1000)}s, max ${RECYCLE_MAX_DEFER_MS / 60000} Min).`);
        return;
      }

      console.warn(`[RUNNER] Recycle trotz laufendem Order-Vorgang erzwungen: max. Aufschub (${RECYCLE_MAX_DEFER_MS / 60000} Min) ` +
                   `überschritten, Speicher ${mb} MB. Der persistente Create-Lock verhindert Dubletten; eine evtl. nicht ` +
                   `abgeschlossene Order bleibt gesperrt, bis eine neue Verkaufs-Ausführung sie freigibt.`);
    }

    recycleDeferSinceTs = 0;
    console.log(`[RUNNER] Speicher ${mb} MB (${m.source}) > Schwellwert ${RECYCLE_RSS_THRESHOLD_MB} MB – starte Browser-Recycle.`);
    recycleBrowser().catch(err => console.error('[RUNNER] recycleBrowser Fehler:', err));
  }, RECYCLE_CHECK_INTERVAL_MS);
}

async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`[RUNNER] Signal ${signal} empfangen – sichere Session-Cookies/sessionStorage und schließe Firefox sauber…`);

  if (snapshotIntervalHandle) clearInterval(snapshotIntervalHandle);
  if (recycleCheckHandle) { clearInterval(recycleCheckHandle); recycleCheckHandle = null; }
  stopLoginIdleWatch();

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
  console.log(`[RUNNER] Version ${RUNNER_VERSION} (Firefox) startet…`);
  console.log(`[RUNNER] Boot-ID: ${RUNNER_BOOT_ID}; Create-Locks beim Runner-Start entfernen: ${CLEAR_CREATE_LOCKS_ON_START ? 'ja' : 'nein'}.`);

  cleanupStaleLocks();

  if (!fs.existsSync(USERSCRIPT_PATH)) {
    console.error(`[RUNNER] Fehler: userscript.js nicht gefunden unter ${USERSCRIPT_PATH}`);
    process.exit(1);
  }

  // in die globale Variable lesen, damit startBrowserSession() den Code
  // auch bei jedem Recycle wiederverwenden kann.
  userscriptCode = fs.readFileSync(USERSCRIPT_PATH, 'utf-8');

  await startBrowserSession();

  setTimeout(() => {
    startupCompleted = true;
    console.log('[RUNNER] Startphase abgeschlossen.');
  }, CONTEXT_CLOSE_GUARD_MS);

  // Speicher-Watchdog erst nach dem Erststart aktivieren.
  startRecycleWatch();

  await new Promise(() => {});
}

main().catch(err => {
  console.error('[RUNNER] Fataler Fehler:', err);
  process.exit(1);
});
