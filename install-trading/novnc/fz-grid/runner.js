// /opt/fz-grid/runner.js
// Version: 2.0.0 (Firefox-Port)
//
// Änderungen in dieser Version:
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

const RUNNER_VERSION = '2.0.0';

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

let context = null;
let page = null;
let shuttingDown = false;
let snapshotIntervalHandle = null;
let startupCompleted = false;
let contextClosedHandled = false;
let loginIdleTimer = null;
let loginPollHandle = null;

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

async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`[RUNNER] Signal ${signal} empfangen – sichere Session-Cookies/sessionStorage und schließe Firefox sauber…`);

  if (snapshotIntervalHandle) clearInterval(snapshotIntervalHandle);
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

  cleanupStaleLocks();

  if (!fs.existsSync(USERSCRIPT_PATH)) {
    console.error(`[RUNNER] Fehler: userscript.js nicht gefunden unter ${USERSCRIPT_PATH}`);
    process.exit(1);
  }

  const userscriptCode = fs.readFileSync(USERSCRIPT_PATH, 'utf-8');

  console.log(`[RUNNER] Starte Firefox (Playwright-Build) mit Profil: ${USER_DATA_DIR}`);
  console.log(`[RUNNER] DISPLAY: ${process.env.DISPLAY || '(nicht gesetzt)'}`);
  console.log(`[RUNNER] Fenstergröße (Ziel via --width/--height): ${WINDOW_SIZE.width}x${WINDOW_SIZE.height}`);
  console.log(`[RUNNER] Login-Idle-Timeout: ${LOGIN_IDLE_TIMEOUT_MS / 60000} Minuten (Origin ohne Subpath: ${TARGET_ORIGIN}/)`);

  context = await firefox.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    // Kein emulierter Playwright-Viewport: Die Seite nutzt die reale
    // Fenstergröße, die über --width/--height gesetzt wird.
    viewport: null,
    args: [
      `--width=${WINDOW_SIZE.width}`,
      `--height=${WINDOW_SIZE.height}`
    ],
    // Übergabe der Firefox-spezifischen Einstellungen an das Browser-Context
    firefoxUserPrefs: {
      'signon.rememberSignons': true, // Aktiviert die Passwort-Manager-Abfragen
      'ui.popup.disable_autohide': true // Deaktiviert das Dropdowns sich sofort schließen
    }
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

  console.log('[RUNNER] Falls kein Login/Freischaltung vorhanden: jetzt über noVNC einmalig durchführen.');
  console.log('[RUNNER] Die Session bleibt danach im Profilordner dauerhaft erhalten.');

  // Initialen Login-Status prüfen (falls goto direkt auf der Login-Seite landet,
  // z.B. weil die Session abgelaufen ist)
  checkLoginState();

  // Fallback-Polling für SPA-Navigationen, bei denen "framenavigated" nicht
  // zuverlässig feuert (z.B. reine History-API-Änderungen)
  loginPollHandle = setInterval(checkLoginState, LOGIN_POLL_INTERVAL_MS);

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
