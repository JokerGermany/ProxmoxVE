// /opt/fz-grid/runner.js
// Version: 2.4.0 (Firefox-Port + speicherbasiertes Browser-Recycling + Seiten-Watchdog)
//
// Neu in 2.4.0 (Störfall 09.11.2026, Server-Timeout gegen 20:40):
// - Navigation zur Zielseite mit Retry/Backoff (gotoTarget). Ein Timeout beim
//   Start oder Recycle beendet den Runner NICHT mehr (user1 war nach einem
//   einzigen goto-Timeout im Recycle tot). Nur ein fehlgeschlagener
//   Firefox-Start ist weiterhin fatal.
// - Seiten-Watchdog (checkPageHealth): steht die Seite auf einer Firefox-
//   Fehlerseite (about:neterror o.ä.) oder ist sie per page.evaluate
//   mehrfach hintereinander nicht auswertbar, wird hart auf TARGET_URL
//   navigiert. user2 hing 50+ Min auf "The connection has timed out", weil
//   die Recovery des Userscripts aus der Fehlerseite heraus nicht navigieren
//   kann. Es wird NIE page.reload() verwendet: die hängende URL kann die
//   Order-Maske mit tmAutoReview=1 sein, ein Reload würde die Order-Automatik
//   erneut starten.
// - (2.4.1) Recycle wird auch aufgeschoben, solange das Userscript eine
//   Tiefensuche im Ausgeführt-Tab meldet (<html data-fz-grid-busy>), max.
//   RECYCLE_MAX_DEFER_BUSY_MS (Default 20 Min). Sonst bricht der Recycle die
//   Suche ab und sie beginnt nach dem Neustart wieder von vorn.
// - sessionStorage-Snapshot: Fehler werden nur noch einmal je Fehlerserie
//   geloggt (vorher alle 15 s), und auf einer Fehlerseite wird der letzte
//   gute Snapshot nicht überschrieben.
//
// Neu in 2.3.0:
// - Create-Locks werden bei jedem echten Runner-PROZESS-Start einmalig geleert
//   (nicht beim Browser-Recycle). Abschaltbar über CLEAR_CREATE_LOCKS_ON_START=0.
// Neu in 2.2.0:
// - Recycle wird aufgeschoben, solange eine Order-Maske offen ist
//   (max. RECYCLE_MAX_DEFER_MS).
// Neu in 2.1.x:
// - Speicherbasiertes Browser-Recycling (cgroup memory.current, Fallback /proc-RSS).
// 2.0.0: Umstellung auf Firefox (Playwright-Build).
// 1.5.0: Login-Idle-Erkennung, Session-Cookie-/sessionStorage-Persistenz,
//        Graceful Shutdown.

const { firefox } = require('playwright');
const fs = require('fs');
const path = require('path');

const RUNNER_VERSION = '2.4.1';

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
const LOGIN_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const LOGIN_POLL_INTERVAL_MS = 15000;

// --- Speicherbasiertes Browser-Recycling ---
const RECYCLE_RSS_THRESHOLD_MB = parseInt(process.env.RECYCLE_RSS_THRESHOLD_MB || '1500', 10);
const RECYCLE_CHECK_INTERVAL_MS = 60 * 1000;
const RECYCLE_MIN_INTERVAL_MS = 5 * 60 * 1000;
const PAGE_SIZE_BYTES = 4096;
const CONFIG_DEBUG_RSS = process.env.DEBUG_RSS === '1';

// --- Order-Schutz beim Recycle ---
const RECYCLE_BUSY_URL_FRAGMENT = process.env.RECYCLE_BUSY_URL_FRAGMENT || '/meindepot/kaufenverkaufen';
const RECYCLE_MAX_DEFER_MS = parseInt(process.env.RECYCLE_MAX_DEFER_MS || String(5 * 60 * 1000), 10);
// NEU (2.4.1): Aufschub, solange das Userscript "beschäftigt" meldet (Tiefensuche).
const RECYCLE_MAX_DEFER_BUSY_MS = parseInt(process.env.RECYCLE_MAX_DEFER_BUSY_MS || String(20 * 60 * 1000), 10);

// --- Create-Locks beim Runner-Start entfernen ---
const CLEAR_CREATE_LOCKS_ON_START = process.env.CLEAR_CREATE_LOCKS_ON_START !== '0';
const CREATE_LOCKS_STORAGE_KEY = process.env.CREATE_LOCKS_STORAGE_KEY || 'fz-grid.recentCreateLocks';
const RUNNER_BOOT_MARKER_KEY = 'fz-grid.__runnerBootId';
const RUNNER_BOOT_ID = `${Date.now()}-${process.pid}`;

// --- NEU (2.4.0): Navigation mit Retry ---
// Timeout je Versuch und Wartezeiten VOR den Versuchen (erster sofort).
const NAV_TIMEOUT_MS = parseInt(process.env.NAV_TIMEOUT_MS || '60000', 10);
const NAV_RETRY_DELAYS_MS = [0, 30000, 60000, 120000];

// --- NEU (2.4.0): Seiten-Watchdog ---
const HEALTH_CHECK_INTERVAL_MS = parseInt(process.env.HEALTH_CHECK_INTERVAL_MS || '30000', 10);
// So viele aufeinanderfolgende page.evaluate-Fehler -> Seite gilt als hängend.
// 3 x 30 s = 90 s liegt über einem regulären Order-Ablauf (~15-30 s).
const HEALTH_MAX_EVAL_FAILURES = parseInt(process.env.HEALTH_MAX_EVAL_FAILURES || '3', 10);
// Nach einer erfolglosen Wiederherstellung frühestens nach dieser Zeit erneut.
const HEALTH_RECOVER_MIN_INTERVAL_MS = 2 * 60 * 1000;
// Firefox-interne Fehlerseiten (document.documentURI)
const FIREFOX_ERROR_URI_RE = /^about:(neterror|certerror|blocked|tabcrashed)/i;

let context = null;
let page = null;
let shuttingDown = false;
let snapshotIntervalHandle = null;
let startupCompleted = false;
let contextClosedHandled = false;
let loginIdleTimer = null;
let loginPollHandle = null;
let userscriptCode = null;
let recycling = false;
let recycleCheckHandle = null;
let lastRecycleTs = 0;
let recycleDeferSinceTs = 0;

// NEU (2.4.0)
let healthCheckHandle = null;
let healthEvalFailures = 0;
let healthRecovering = false;
let lastHealthRecoverTs = 0;
let sessionStorageSnapshotFailing = false;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanupStaleLocks() {
  const lockFiles = ['lock', '.parentlock', 'SingletonLock', 'SingletonSocket', 'SingletonCookie'];

  for (const f of lockFiles) {
    const p = path.join(USER_DATA_DIR, f);

    let exists = false;
    try {
      fs.lstatSync(p);
      exists = true;
    } catch {
      // nicht vorhanden
    }
    if (!exists) continue;

    try {
      fs.rmSync(p, { force: true });
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
    const result = await page.evaluate((origin) => {
      // GEÄNDERT (2.4.0): nur auf der Ziel-Origin sichern. Auf einer
      // Fehlerseite würde sonst ein leerer Stand den letzten guten
      // Snapshot überschreiben.
      if (window.location.origin !== origin) return null;
      const out = {};
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i);
        out[key] = sessionStorage.getItem(key);
      }
      return out;
    }, TARGET_ORIGIN);
    if (result === null) return;

    fs.writeFileSync(SESSION_STORAGE_FILE, JSON.stringify(result, null, 2));
    if (sessionStorageSnapshotFailing) {
      sessionStorageSnapshotFailing = false;
      console.log('[RUNNER] sessionStorage wieder sicherbar.');
    }
    const count = Object.keys(result).length;
    if (count > 0) {
      console.log(`[RUNNER] ${count} sessionStorage-Einträge gesichert.`);
    }
  } catch (err) {
    // GEÄNDERT (2.4.0): nur einmal je Fehlerserie loggen
    if (!sessionStorageSnapshotFailing) {
      sessionStorageSnapshotFailing = true;
      console.warn('[RUNNER] Konnte sessionStorage nicht sichern (weitere Fehler werden bis zum nächsten Erfolg nicht geloggt):', err.message);
    }
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
  if (loginIdleTimer) return;
  console.log(`[RUNNER] Login-Seite ohne Subpath erkannt – starte ${LOGIN_IDLE_TIMEOUT_MS / 60000}-Minuten-Timer.`);
  loginIdleTimer = setTimeout(async () => {
    console.log('[RUNNER] 5 Minuten auf Login-Seite ohne Weiterleitung – behandle als manuelles Schließen des Browsers.');
    loginIdleTimer = null;
    try {
      if (context) {
        await context.close();
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

// --- NEU (2.4.0): Navigation mit Retry ------------------------------------

// Navigiert auf TARGET_URL (NIE reload, siehe Kopf). Mehrere Versuche mit
// Wartezeit; true bei Erfolg, false wenn alle Versuche scheiterten (dann
// greift später der Seiten-Watchdog). Bricht ab, wenn währenddessen ein
// Shutdown beginnt oder die Seite geschlossen wird.
async function gotoTarget(reason) {
  for (let i = 0; i < NAV_RETRY_DELAYS_MS.length; i++) {
    const delay = NAV_RETRY_DELAYS_MS[i];
    if (delay > 0) {
      console.log(`[RUNNER] Navigation (${reason}): nächster Versuch in ${delay / 1000}s…`);
      await sleep(delay);
    }
    if (shuttingDown || !page || page.isClosed()) return false;

    try {
      await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
      console.log(`[RUNNER] Seite geladen (${reason}, Versuch ${i + 1}): ${TARGET_URL}`);
      return true;
    } catch (err) {
      console.warn(`[RUNNER] Navigation (${reason}) Versuch ${i + 1}/${NAV_RETRY_DELAYS_MS.length} fehlgeschlagen:`,
        String(err && err.message || err).split('\n')[0]);
    }
  }
  console.warn(`[RUNNER] Navigation (${reason}) nach ${NAV_RETRY_DELAYS_MS.length} Versuchen aufgegeben – der Seiten-Watchdog versucht es später erneut.`);
  return false;
}

// --- NEU (2.4.0): Seiten-Watchdog ------------------------------------------

async function checkPageHealth() {
  if (shuttingDown || recycling || healthRecovering) return;
  if (!startupCompleted || !page || page.isClosed()) return;

  let problem = null;
  try {
    const uri = await page.evaluate(() => document.documentURI);
    if (FIREFOX_ERROR_URI_RE.test(uri || '')) {
      problem = `Firefox-Fehlerseite (${String(uri).slice(0, 60)}…, URL ${page.url()})`;
    } else {
      healthEvalFailures = 0;
    }
  } catch (err) {
    healthEvalFailures++;
    if (healthEvalFailures >= HEALTH_MAX_EVAL_FAILURES) {
      problem = `Seite ${healthEvalFailures}x nicht auswertbar (${String(err && err.message || err).split('\n')[0]}, URL ${page.url()})`;
    }
  }
  if (!problem) return;

  if (Date.now() - lastHealthRecoverTs < HEALTH_RECOVER_MIN_INTERVAL_MS) return;

  healthRecovering = true;
  lastHealthRecoverTs = Date.now();
  healthEvalFailures = 0;
  try {
    console.warn(`[RUNNER] Seiten-Watchdog: ${problem} – navigiere auf ${TARGET_URL}.`);
    await gotoTarget('Seiten-Watchdog');
  } finally {
    healthRecovering = false;
  }
}

function startHealthWatch() {
  if (healthCheckHandle) return;
  console.log(`[RUNNER] Seiten-Watchdog aktiv: Prüfung alle ${HEALTH_CHECK_INTERVAL_MS / 1000}s, ` +
              `Wiederherstellung bei Firefox-Fehlerseite oder ${HEALTH_MAX_EVAL_FAILURES} Auswertungsfehlern in Folge.`);
  healthCheckHandle = setInterval(() => {
    checkPageHealth().catch(err => console.warn('[RUNNER] Seiten-Watchdog Fehler:', err.message));
  }, HEALTH_CHECK_INTERVAL_MS);
}

function stopHealthWatch() {
  if (healthCheckHandle) {
    clearInterval(healthCheckHandle);
    healthCheckHandle = null;
  }
}

// --- Speicher-Ermittlung ------------------------------------------------

function getProcessTreeRssBytes(rootPid) {
  let entries;
  try {
    entries = fs.readdirSync('/proc').filter(name => /^\d+$/.test(name));
  } catch (err) {
    console.warn('[RUNNER] /proc nicht lesbar, RSS-Prüfung übersprungen:', err.message);
    return null;
  }

  const ppidOf = new Map();
  for (const name of entries) {
    try {
      const stat = fs.readFileSync(`/proc/${name}/stat`, 'utf-8');
      const rest = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
      const ppid = parseInt(rest[1], 10);
      const pid = parseInt(name, 10);
      if (Number.isFinite(ppid)) ppidOf.set(pid, ppid);
    } catch {
      // Prozess verschwunden
    }
  }

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
      // Prozess weg
    }
  }
  return totalBytes;
}

function getOwnCgroupMemoryBytes() {
  try {
    const cg = fs.readFileSync('/proc/self/cgroup', 'utf-8');
    const line = cg.split('\n').find(l => l.startsWith('0::'));
    if (!line) return null;
    const rel = line.slice(3).trim();
    const raw = fs.readFileSync(`/sys/fs/cgroup${rel}/memory.current`, 'utf-8').trim();
    const bytes = parseInt(raw, 10);
    return Number.isFinite(bytes) ? bytes : null;
  } catch {
    return null;
  }
}

function measureInstanceMemory() {
  const cg = getOwnCgroupMemoryBytes();
  if (cg !== null) return { bytes: cg, source: 'cgroup' };
  const rss = getProcessTreeRssBytes(process.pid);
  if (rss !== null) return { bytes: rss, source: 'proc-rss' };
  return null;
}

// --- Browser-Session-Aufbau (Erststart und Recycle) ---------------------

async function startBrowserSession() {
  console.log(`[RUNNER] Starte Firefox (Playwright-Build) mit Profil: ${USER_DATA_DIR}`);
  console.log(`[RUNNER] DISPLAY: ${process.env.DISPLAY || '(nicht gesetzt)'}`);
  console.log(`[RUNNER] Fenstergröße (Ziel via --width/--height): ${WINDOW_SIZE.width}x${WINDOW_SIZE.height}`);
  console.log(`[RUNNER] Login-Idle-Timeout: ${LOGIN_IDLE_TIMEOUT_MS / 60000} Minuten (Origin ohne Subpath: ${TARGET_ORIGIN}/)`);

  // Ein Fehler HIER (Firefox startet nicht) bleibt fatal – der Aufrufer beendet.
  context = await firefox.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    viewport: null,
    firefoxUserPrefs: {
      'signon.rememberSignons': true,
      'ui.popup.disable_autohide': true
    }
  });

  await restoreSessionCookiesBeforeNavigation();

  if (CLEAR_CREATE_LOCKS_ON_START) {
    await context.addInitScript(
      ([bootId, markerKey, locksKey, origin]) => {
        try {
          if (window.location.origin !== origin) return;
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
            console.warn('[FZ-GRID-RESTORE] sessionStorage.setItem fehlgeschlagen', key, err && err.message);
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
    if (recycling) return;

    if (contextClosedHandled) return;
    contextClosedHandled = true;

    if (snapshotIntervalHandle) clearInterval(snapshotIntervalHandle);
    if (recycleCheckHandle) { clearInterval(recycleCheckHandle); recycleCheckHandle = null; }
    stopHealthWatch();
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

  // GEÄNDERT (2.4.0): mit Retry; ein Fehlschlag ist nicht mehr fatal.
  const loaded = await gotoTarget(startupCompleted ? 'Recycle' : 'Start');

  if (loaded) {
    try {
      const size = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
      console.log(`[RUNNER] Innere Fenstergröße laut Seite: ${size.w}x${size.h} (Soll außen: ${WINDOW_SIZE.width}x${WINDOW_SIZE.height}, abzüglich Firefox-UI)`);
    } catch (err) {
      console.warn('[RUNNER] Konnte Fenstergröße nicht auslesen:', err.message);
    }
  }

  if (!startupCompleted) {
    console.log('[RUNNER] Falls kein Login/Freischaltung vorhanden: jetzt über noVNC einmalig durchführen.');
    console.log('[RUNNER] Die Session bleibt danach im Profilordner dauerhaft erhalten.');
  }

  checkLoginState();

  loginPollHandle = setInterval(checkLoginState, LOGIN_POLL_INTERVAL_MS);

  snapshotIntervalHandle = setInterval(() => {
    snapshotAll().catch(err => console.warn('[RUNNER] Periodischer Snapshot fehlgeschlagen:', err.message));
  }, SNAPSHOT_INTERVAL_MS);
}

// --- Browser-Recycle ----------------------------------------------------

async function recycleBrowser() {
  if (shuttingDown || recycling) return;
  recycling = true;
  const startedAt = Date.now();
  console.log('[RUNNER] Browser-Recycle: sichere Session-Zustand und starte Firefox neu…');

  try {
    if (snapshotIntervalHandle) { clearInterval(snapshotIntervalHandle); snapshotIntervalHandle = null; }
    stopLoginIdleWatch();

    await snapshotAll();

    if (context) {
      await context.close();
    }
    context = null;
    page = null;

    cleanupStaleLocks();

    if (shuttingDown) {
      console.log('[RUNNER] Shutdown während Recycle erkannt – baue keinen neuen Kontext mehr auf.');
      return;
    }

    // Navigationsfehler werden in startBrowserSession() abgefangen; was hier
    // noch wirft, ist ein echter Startfehler von Firefox.
    await startBrowserSession();

    lastRecycleTs = Date.now();
    healthEvalFailures = 0;
    console.log(`[RUNNER] Browser-Recycle abgeschlossen in ${Date.now() - startedAt} ms.`);
  } catch (err) {
    console.error('[RUNNER] Browser-Recycle fehlgeschlagen (Firefox-Start) – beende Runner mit Fehler, systemd startet neu:', err);
    process.exit(1);
  } finally {
    recycling = false;
  }
}

// GEÄNDERT (2.4.1): liefert den Grund des Aufschubs samt max. Dauer oder null.
async function getRecycleBlocker() {
  try {
    if (!page || page.isClosed()) return null;
    const u = page.url() || '';
    if (u.includes(RECYCLE_BUSY_URL_FRAGMENT)) {
      return { reason: `Order-Vorgang aktiv (URL enthält "${RECYCLE_BUSY_URL_FRAGMENT}")`, maxMs: RECYCLE_MAX_DEFER_MS };
    }
    const busy = await page.evaluate(() => document.documentElement?.dataset?.fzGridBusy || '');
    if (busy) {
      return { reason: `Userscript beschäftigt (${busy})`, maxMs: RECYCLE_MAX_DEFER_BUSY_MS };
    }
  } catch {
    // Seite nicht auswertbar -> kein Aufschub
  }
  return null;
}

function startRecycleWatch() {
  if (recycleCheckHandle) return;

  const initial = measureInstanceMemory();
  const src = initial ? initial.source : 'keine (Messung nicht möglich)';
  console.log(`[RUNNER] Speicher-Watchdog aktiv: Recycle bei Speicher > ${RECYCLE_RSS_THRESHOLD_MB} MB ` +
              `(Messquelle: ${src}, Prüfintervall ${RECYCLE_CHECK_INTERVAL_MS / 1000}s, ` +
              `Mindestabstand ${RECYCLE_MIN_INTERVAL_MS / 60000} Min, ` +
              `Order-Schutz bei URL-Fragment "${RECYCLE_BUSY_URL_FRAGMENT}", max. Aufschub ${RECYCLE_MAX_DEFER_MS / 60000} Min).`);

  let checkRunning = false;
  recycleCheckHandle = setInterval(async () => {
    if (checkRunning) return;
    checkRunning = true;
    try {
      await recycleCheckOnce();
    } catch (err) {
      console.warn('[RUNNER] Speicher-Watchdog Fehler:', err.message);
    } finally {
      checkRunning = false;
    }
  }, RECYCLE_CHECK_INTERVAL_MS);
}

async function recycleCheckOnce() {
    if (shuttingDown || recycling || healthRecovering) return;
    if (!startupCompleted) return;
    if (Date.now() - lastRecycleTs < RECYCLE_MIN_INTERVAL_MS) return;

    const m = measureInstanceMemory();
    if (m === null) return;
    const mb = Math.round(m.bytes / (1024 * 1024));

    if (mb <= RECYCLE_RSS_THRESHOLD_MB) {
      recycleDeferSinceTs = 0;
      if (CONFIG_DEBUG_RSS) {
        console.log(`[RUNNER] Speicher ${mb} MB (${m.source}), Schwellwert ${RECYCLE_RSS_THRESHOLD_MB} MB.`);
      }
      return;
    }

    const blocker = await getRecycleBlocker();
    if (blocker) {
      if (recycleDeferSinceTs === 0) recycleDeferSinceTs = Date.now();
      const deferredMs = Date.now() - recycleDeferSinceTs;

      if (deferredMs < blocker.maxMs) {
        console.log(`[RUNNER] Recycle aufgeschoben: ${blocker.reason}, ` +
                    `Speicher ${mb} MB. Warte (seit ${Math.round(deferredMs / 1000)}s, max ${blocker.maxMs / 60000} Min).`);
        return;
      }

      console.warn(`[RUNNER] Recycle erzwungen trotz "${blocker.reason}": max. Aufschub (${blocker.maxMs / 60000} Min) ` +
                   `überschritten, Speicher ${mb} MB.`);
    }

    recycleDeferSinceTs = 0;
    console.log(`[RUNNER] Speicher ${mb} MB (${m.source}) > Schwellwert ${RECYCLE_RSS_THRESHOLD_MB} MB – starte Browser-Recycle.`);
    recycleBrowser().catch(err => console.error('[RUNNER] recycleBrowser Fehler:', err));
}

async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`[RUNNER] Signal ${signal} empfangen – sichere Session-Cookies/sessionStorage und schließe Firefox sauber…`);

  if (snapshotIntervalHandle) clearInterval(snapshotIntervalHandle);
  if (recycleCheckHandle) { clearInterval(recycleCheckHandle); recycleCheckHandle = null; }
  stopHealthWatch();
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

  userscriptCode = fs.readFileSync(USERSCRIPT_PATH, 'utf-8');

  await startBrowserSession();

  setTimeout(() => {
    startupCompleted = true;
    console.log('[RUNNER] Startphase abgeschlossen.');
  }, CONTEXT_CLOSE_GUARD_MS);

  startRecycleWatch();
  startHealthWatch();

  await new Promise(() => {});
}

main().catch(err => {
  console.error('[RUNNER] Fataler Fehler:', err);
  process.exit(1);
});
