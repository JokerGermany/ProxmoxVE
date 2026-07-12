// ==UserScript==
// @name         Finanzen Zero Grid Order Assistant
// @namespace    https://tampermonkey.net/
// @version      1.15.0
// @description  Liest offene Orders, berücksichtigt pro ISIN die aktuellste Ausführung, baut ein Grid aus Kauf-/Verkaufsorders, erlaubt Klick auf Dubletten-Meldungen zum Löschen einer passenden Order, berechnet Zielmengen so, dass der Orderwert mindestens 500 € beträgt, kann über Auto-Create Buy/Sell automatisch Orders anlegen, erlaubt das Deaktivieren der Kauf-Automatik pro einzelner ISIN, liest den Depotbestand und die verfügbare Kaufkraft (inkl. Depotkredit, "mit Depotkredit"-Zeile bei aktivem Kredit) aus, pausiert die Kauf-Automatik pro ISIN bei zu wenig Guthaben zeitbasiert (mit Cooldown) und zusätzlich bis zur nächsten registrierten Verkaufs-Ausführung (Snackbar oder Ausgeführt-Tab), erlaubt manuelles Aufheben der Kaufpause per Klick, bereinigt veraltete/falsch bepreiste Kauforders automatisch, erlaubt das Einklappen des Panels per Minimieren-Button, und speichert alle Einstellungen dauerhaft über localStorage.
// @match        https://mein.finanzen-zero.net/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  /**********************************************************************
   * PERSISTENCE (localStorage)
   **********************************************************************/
  const SESSION_KEYS = {
    AUTO_CREATE_BUY: 'fz-grid.autoCreateBuy',
    AUTO_CREATE_SELL: 'fz-grid.autoCreateSell',
    PANEL_MINIMIZED: 'fz-grid.panelMinimized'
  };

  function buyEnabledSessionKey(isin) {
    return `fz-grid.buyEnabled.${isin}`;
  }

  function insufficientFundsUntilKey(isin) {
    return `fz-grid.insufficientFundsUntil.${isin}`;
  }

  const SEEN_SNACKBAR_KEYS_STORAGE_KEY = 'fz-grid.seenSnackbarKeys';
  const SEEN_EXECUTED_KEYS_STORAGE_KEY = 'fz-grid.seenExecutedKeys';
  const SEEN_KEYS_MAX = 300;

  function loadSessionFlag(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return fallback;
      return raw === '1';
    } catch (err) {
      return fallback;
    }
  }

  function saveSessionFlag(key, value) {
    try {
      localStorage.setItem(key, value ? '1' : '0');
    } catch (err) {
      console.warn('[FZ-GRID] localStorage nicht verfügbar', err);
    }
  }

  function loadInsufficientFundsUntil(isin) {
    try {
      const raw = localStorage.getItem(insufficientFundsUntilKey(isin));
      const n = Number(raw);
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch (err) {
      return null;
    }
  }

  function saveInsufficientFundsUntil(isin, timestampMsOrNull) {
    try {
      if (timestampMsOrNull) {
        localStorage.setItem(insufficientFundsUntilKey(isin), String(timestampMsOrNull));
      } else {
        localStorage.removeItem(insufficientFundsUntilKey(isin));
      }
    } catch (err) {
      console.warn('[FZ-GRID] localStorage nicht verfügbar', err);
    }
  }

  function loadStringSet(key) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return new Set();
      const arr = JSON.parse(raw);
      return new Set(Array.isArray(arr) ? arr : []);
    } catch (err) {
      return new Set();
    }
  }

  function saveStringSet(key, set, maxSize) {
    try {
      let arr = [...set];
      if (maxSize && arr.length > maxSize) {
        arr = arr.slice(arr.length - maxSize);
      }
      localStorage.setItem(key, JSON.stringify(arr));
    } catch (err) {
      console.warn('[FZ-GRID] localStorage nicht verfügbar', err);
    }
  }

  /**********************************************************************
   * KONFIGURATION
   **********************************************************************/
  const CONFIG = {
    DEBUG: true,
    POLL_MS: 1500,

    AUTO_CREATE_BUY: loadSessionFlag(SESSION_KEYS.AUTO_CREATE_BUY, false),
    AUTO_CREATE_SELL: loadSessionFlag(SESSION_KEYS.AUTO_CREATE_SELL, false),
    MIN_SELL_ORDERS_PER_ISIN: 10,

    DRY_RUN: false,

    GRID_STEP: 0.5,
    MIN_ORDER_VALUE_EUR: 500,

    SELL_RESERVE_MIN_VALUE_EUR: 500,

    ENFORCE_SINGLE_BUY_ORDER: true,
    CANCEL_WAIT_MS: 1400,

    afterDateSetDelayMs: 500,
    afterFirstClickDelayMs: 800,
    afterSecondClickDelayMs: 800,
    afterZumDepotClickDelayMs: 600,
    afterTabSwitchDelayMs: 700,

    EXECUTED_REFRESH_INTERVAL_MS: 20000,

    BUTTON_CLICKABLE_TIMEOUT_MS: 15000,
    BUTTON_CLICKABLE_POLL_MS: 250,

    BUYING_POWER_WAIT_TIMEOUT_MS: 8000,
    BUYING_POWER_WAIT_POLL_MS: 200,

    INSUFFICIENT_FUNDS_RETRY_COOLDOWN_MS: 3 * 60 * 1000,

    SPECIAL_CASE: {
      min: 0.7,
      max: 0.8,
      buy: 0.5,
      sell: 1.0
    },

    ISINS: {
      'LU0908500753': { label: 'Amundi Core Stoxx Europe 600', enabled: true },
      'IE00BJ0KDQ92': { label: 'Xtrackers MSCI World', buyEnabled: false, enabled: true },
      'IE00BD4TXV59': { label: 'UBS MSCI World', enabled: true },
      'IE0009DRDY20': { label: 'AMUNDI PRIME GLOBAL', enabled: true },
      'IE0006WW1TQ4': { label: 'Xtrackers MSCI World ex USA', enabled: true }
    },

    SELECTORS: {
      openOrdersTab: '[data-zid="open-orders-tab"]',
      executedOrdersTab: '[data-zid="executed-orders-tab"]',

      openRows: 'tr[app-open-order-item], [app-open-order-item]',
      executedRows: 'tr[app-executed-order-item], [app-executed-order-item]',

      openIsin: '[data-zid="open-order-item-isin"]',
      openQty: '[data-zid="open-order-item-qty"]',
      openDirection: '[data-zid="open-order-item-direction"]',

      executedIsin: '[data-zid="executed-order-item-isin"]',
      executedQty: '[data-zid="executed-order-item-qty"]',
      executedDirection: '[data-zid="executed-order-item-direction"]',
      executedStatus: '[data-zid="executed-order-item-status"]',

      execType: '[data-zid="order-item-exec-type"]',

      stopLimitHost: 'order-zero-stop-limit-data',
      stopLimitText: 'order-zero-stop-limit-data .text-color-primary',

      orderValueHost: 'order-value',
      orderValueText: 'order-value .zero-text',

      instrumentLink: 'a[href^="/instrument/"]',

      duplicateBtn: '[title="Duplizieren"]',
      editBtn: '[title="Editieren"]',
      deleteBtn: '[title="Streichen"]',

      snackbarMsg: 'web-components-snackbar-order-msg',

      positionsHost: '[data-zid="positions"]',
      positionRows: 'tr[zero-position]',
      positionQuantityCell: '[data-zid="quantity-column"]',

      buyingPowerHost: '.buying-power',
      activeLombard: '[data-zid="active-lombard"]',
      possibleLombard: '[data-zid="possible-lombard"]'
    },

    FORM: {
      qtyInput: [
        'input[name="qty"]',
        'input[name="quantity"]',
        'input[formcontrolname="quantity"]',
        'input[formcontrolname="qty"]',
        'input[inputmode="numeric"]'
      ].join(', '),

      priceInput: [
        'input[name="limit"]',
        'input[name="price"]',
        'input[formcontrolname="limit"]',
        'input[formcontrolname="price"]',
        'input[inputmode="decimal"]'
      ].join(', '),

      nextTexts: ['weiter', 'überprüfen', 'order überprüfen'],
      finalBuyTexts: ['kaufen', 'kostenpflichtig kaufen'],
      finalSellTexts: ['verkaufen', 'kostenpflichtig verkaufen'],
      cancelConfirmTexts: ['order streichen', 'streichen', 'löschen', 'bestätigen', 'ja'],

      successTexts: ['deine order wurde erfolgreich aufgegeben'],
      zumDepotTexts: ['zum depot']
    }
  };

  for (const isin of Object.keys(CONFIG.ISINS)) {
    CONFIG.ISINS[isin].buyEnabled = loadSessionFlag(buyEnabledSessionKey(isin), true);
  }

  function isBuyEnabledForIsin(isin) {
    return CONFIG.ISINS[isin]?.buyEnabled !== false;
  }

  function setBuyEnabledForIsin(isin, value) {
    if (!CONFIG.ISINS[isin]) return;
    CONFIG.ISINS[isin].buyEnabled = value;
    saveSessionFlag(buyEnabledSessionKey(isin), value);
  }

  /**********************************************************************
   * STATE
   **********************************************************************/
  const STATE = {
    panel: null,
    observer: null,
    orders: [],
    lastRefreshTs: 0,
    refreshRunning: false,
    hasOpenOrdersSnapshot: false,

    snackbarLatestByIsin: new Map(),
    executedTabLatestByIsin: new Map(),
    seenSnackbarKeys: loadStringSet(SEEN_SNACKBAR_KEYS_STORAGE_KEY),
    seenExecutedKeys: loadStringSet(SEEN_EXECUTED_KEYS_STORAGE_KEY),

    holdingsByIsin: new Map(),
    hasPositionSnapshot: false,

    insufficientFundsUntil: new Map(
      Object.keys(CONFIG.ISINS)
        .map(isin => [isin, loadInsufficientFundsUntil(isin)])
        .filter(([, until]) => until != null)
    ),

    createAttempts: new Set(),
    cancelAttempts: new Set(),
    duplicateDeleteAttempts: new Set(),

    zumDepotHandled: false,
    orderAbortHandled: false,

    autoTabCycleRunning: false,
    lastExecutedScanTs: 0
  };

  /**********************************************************************
   * STYLE
   **********************************************************************/
  const STYLE = `
    #fz-grid-panel {
      position: fixed;
      top: 12px;
      left: 12px;
      width: 520px;
      max-height: calc(100vh - 24px);
      overflow: auto;
      z-index: 999999;
      background: #111827;
      color: #f9fafb;
      border: 1px solid #374151;
      border-radius: 12px;
      box-shadow: 0 16px 40px rgba(0,0,0,.35);
      font: 13px/1.45 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    }
    #fz-grid-panel * { box-sizing: border-box; }

    #fz-grid-panel .hdr {
      position: sticky;
      top: 0;
      z-index: 2;
      padding: 12px;
      background: #111827;
      border-bottom: 1px solid #334155;
    }

    #fz-grid-panel .hdr-top {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      align-items: center;
      margin-bottom: 8px;
    }

    #fz-grid-panel .title {
      font-size: 14px;
      font-weight: 700;
      color: #f8fafc;
    }

    #fz-grid-panel .meta {
      font-size: 11px;
      color: #94a3b8;
    }

    #fz-grid-panel .btnbar {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }

    #fz-grid-panel button {
      border: 0;
      border-radius: 8px;
      padding: 6px 10px;
      cursor: pointer;
      font-weight: 600;
      color: #fff;
      background: #2563eb;
    }

    #fz-grid-panel button.secondary { background: #475569; }
    #fz-grid-panel button.warn { background: #b45309; }
    #fz-grid-panel button.tiny { padding: 3px 8px; font-size: 11px; border-radius: 999px; }

    #fz-grid-panel .content {
      padding: 10px;
      display: grid;
      gap: 10px;
    }

    #fz-grid-panel .card {
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 12px;
      padding: 10px;
    }

    #fz-grid-panel .card h3 {
      margin: 0 0 8px;
      display: flex;
      justify-content: space-between;
      gap: 8px;
      align-items: center;
      font-size: 13px;
      color: #f8fafc;
    }

    #fz-grid-panel .card h3 .h3-left {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    #fz-grid-panel .muted { color: #94a3b8; }
    #fz-grid-panel .good { color: #86efac; }
    #fz-grid-panel .warn-txt { color: #fde68a; }
    #fz-grid-panel .bad { color: #fca5a5; }
    #fz-grid-panel .small { font-size: 11px; }

    #fz-grid-panel .section-label {
      margin-top: 8px;
      margin-bottom: 4px;
      font-size: 11px;
      color: #94a3b8;
      text-transform: uppercase;
      letter-spacing: .04em;
    }

    #fz-grid-panel .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    #fz-grid-panel .chip,
    #fz-grid-panel a.chip,
    #fz-grid-panel button.chip {
      display: inline-flex;
      gap: 6px;
      align-items: center;
      padding: 4px 8px;
      border-radius: 999px;
      background: #334155;
      border: 1px solid #475569;
      white-space: nowrap;
      font-size: 12px;
      color: #f9fafb;
      text-decoration: none;
    }

    #fz-grid-panel a.chip,
    #fz-grid-panel button.chip {
      cursor: pointer;
      user-select: none;
    }

    #fz-grid-panel a.chip:hover,
    #fz-grid-panel button.chip:hover {
      background: #3b4b63;
      border-color: #60a5fa;
      color: #fff;
    }

    #fz-grid-panel a.chip:focus-visible,
    #fz-grid-panel button.chip:focus-visible {
      outline: 2px solid #60a5fa;
      outline-offset: 2px;
    }

    #fz-grid-panel .chip-link-buy {
      border-color: #14532d;
      background: #163221;
    }

    #fz-grid-panel .chip-link-buy:hover {
      background: #1c422b;
      border-color: #22c55e;
    }

    #fz-grid-panel .chip-link-sell {
      border-color: #7c2d12;
      background: #3a2218;
    }

    #fz-grid-panel .chip-link-sell:hover {
      background: #4a291d;
      border-color: #f97316;
    }

    #fz-grid-panel .chip-delete-dup {
      border-color: #7f1d1d;
      background: #3f1d1d;
      text-align: left;
    }

    #fz-grid-panel .chip-delete-dup:hover {
      background: #522222;
      border-color: #ef4444;
    }

    #fz-grid-panel .buy-toggle-on {
      background: #163221;
      border-color: #22c55e;
      color: #86efac;
    }

    #fz-grid-panel .buy-toggle-off {
      background: #3f1d1d;
      border-color: #ef4444;
      color: #fca5a5;
    }

    #fz-grid-panel ul {
      margin: 6px 0 0 18px;
      padding: 0;
    }

    #fz-grid-panel li {
      margin: 2px 0;
    }

    #fz-grid-panel .issue-action {
      list-style: none;
      margin-left: 0;
    }

    #fz-grid-panel.minimized {
      width: 220px;
      max-height: 52px;
      overflow: hidden;
    }

    #fz-grid-panel.minimized .content {
      display: none;
    }

    #fz-grid-panel.minimized .btnbar button:not(#fz-grid-minimize) {
      display: none;
    }

    #fz-grid-panel.minimized .meta {
      display: none;
    }

    .fz-grid-mark-duplicate {
      outline: 2px solid #f59e0b !important;
      outline-offset: -2px !important;
    }

    .fz-grid-mark-offgrid {
      outline: 2px solid #ef4444 !important;
      outline-offset: -2px !important;
    }

    .fz-grid-mark-minvalue {
      outline: 2px solid #22c55e !important;
      outline-offset: -2px !important;
    }
  `;

  /**********************************************************************
   * HELPERS
   **********************************************************************/
  function log(...args) {
    if (CONFIG.DEBUG) console.log('[FZ-GRID]', ...args);
  }

  function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function sleep(ms) {
    return wait(ms);
  }

  function addStyle(css) {
    if (document.getElementById('fz-grid-style')) return;
    const s = document.createElement('style');
    s.id = 'fz-grid-style';
    s.textContent = css;
    document.head.appendChild(s);
  }

  function text(el) {
    return (el?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function normalizeText(str) {
    return String(str || '').replace(/\s+/g, ' ').trim();
  }

  function normalizeLabelText(str) {
    return String(str || '')
      .replace(/\u00A0/g, ' ')
      .replace(/\./g, '')
      .replace(/\s+/g, '')
      .toLowerCase();
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function parseGermanNumber(raw) {
    if (raw == null) return null;
    const cleaned = String(raw)
      .replace(/\u00A0/g, ' ')
      .replace(/[^\d,.\-]/g, '')
      .replace(/\.(?=\d{3}(?:[,.]|$))/g, '')
      .replace(',', '.');
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }

  function parseEuro(raw) {
    return parseGermanNumber(raw);
  }

  function formatPrice(num) {
    if (num == null || !Number.isFinite(num)) return '–';
    return new Intl.NumberFormat('de-DE', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(num);
  }

  function formatEuro(num) {
    if (num == null || !Number.isFinite(num)) return '–';
    return `${formatPrice(num)} €`;
  }

  function formatPriceForUrl(num) {
    if (num == null || !Number.isFinite(num)) return '';
    return String(Number(num));
  }

  function directionFromText(raw) {
    const s = String(raw || '').toLowerCase();
    if (s.includes('verkauf')) return 'Verkauf';
    if (s.includes('kauf')) return 'Kauf';
    return null;
  }

  function normalizeTime(raw) {
    const digits = String(raw || '').replace(/\D/g, '');
    if (digits.length === 6) {
      return `${digits.slice(0, 2)}:${digits.slice(2, 4)}:${digits.slice(4, 6)}`;
    }
    if (digits.length === 4) {
      return `${digits.slice(0, 2)}:${digits.slice(2, 4)}`;
    }
    return String(raw || '').trim();
  }

  function roundToHalf(n) {
    return Math.round(n * 2) / 2;
  }

  function isHalfGrid(n) {
    if (!Number.isFinite(n)) return false;
    return Math.abs(n * 2 - Math.round(n * 2)) < 1e-9;
  }

  function isSamePrice(a, b) {
    return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 0.001;
  }

  function enabledIsins() {
    return Object.entries(CONFIG.ISINS)
      .filter(([, cfg]) => cfg.enabled)
      .map(([isin]) => isin);
  }

  function labelForIsin(isin) {
    return CONFIG.ISINS[isin]?.label || isin;
  }

  function calcTargets(executedPrice) {
    if (
      Number.isFinite(executedPrice) &&
      executedPrice >= CONFIG.SPECIAL_CASE.min &&
      executedPrice <= CONFIG.SPECIAL_CASE.max
    ) {
      return {
        buy: CONFIG.SPECIAL_CASE.buy,
        sell: CONFIG.SPECIAL_CASE.sell,
        mode: 'special'
      };
    }

    const rounded = roundToHalf(executedPrice);
    return {
      buy: roundToHalf(rounded - CONFIG.GRID_STEP),
      sell: roundToHalf(rounded + CONFIG.GRID_STEP),
      mode: 'normal'
    };
  }

  function orderValue(price, qty) {
    if (!Number.isFinite(price) || !Number.isFinite(qty)) return null;
    return price * qty;
  }

  function minQtyForPrice(price) {
    if (!Number.isFinite(price) || price <= 0) return null;
    return Math.max(1, Math.ceil((CONFIG.MIN_ORDER_VALUE_EUR - 1e-9) / price));
  }

  function reserveQtyForPrice(price) {
    if (!Number.isFinite(price) || price <= 0) return null;
    return Math.max(0, Math.ceil((CONFIG.SELL_RESERVE_MIN_VALUE_EUR - 1e-9) / price));
  }

  function orderMeetsMinValue(price, qty) {
    const value = orderValue(price, qty);
    return Number.isFinite(value) && value + 1e-9 >= CONFIG.MIN_ORDER_VALUE_EUR;
  }

  function setInputValue(input, value) {
    const proto = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    proto?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  function isVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.visibility !== 'hidden' &&
      style.display !== 'none' &&
      rect.width > 0 &&
      rect.height > 0;
  }

  function isClickable(el) {
    if (!isVisible(el)) return false;
    if (el.disabled) return false;
    if (el.hasAttribute('disabled')) return false;
    if (el.getAttribute('aria-disabled') === 'true') return false;
    if (el.classList.contains('disabled')) return false;
    return true;
  }

  function findButtonByText(texts, root = document, { requireClickable = false } = {}) {
    const lowered = texts.map(t => t.toLowerCase());
    const all = [...root.querySelectorAll('button, a, [role="button"]')];
    return all.find(el => {
      if (requireClickable ? !isClickable(el) : !isVisible(el)) return false;
      const t = text(el).toLowerCase();
      return lowered.some(x => t.includes(x));
    }) || null;
  }

  function findLabeledValue(root, label) {
    const wanted = String(label).toLowerCase();
    const nodes = [...root.querySelectorAll('div, span')];

    for (const node of nodes) {
      const nodeText = text(node).toLowerCase();
      if (nodeText !== wanted) continue;

      let sib = node.nextElementSibling;
      while (sib) {
        const val = text(sib);
        if (val && val.toLowerCase() !== wanted) return val;
        sib = sib.nextElementSibling;
      }

      const parent = node.parentElement;
      if (parent) {
        const children = [...parent.children];
        for (const child of children) {
          if (child === node) continue;
          const val = text(child);
          if (val && val.toLowerCase() !== wanted) return val;
        }
      }
    }

    return '';
  }

  function findLabeledValueFuzzy(root, label) {
    const wanted = normalizeLabelText(label);
    const nodes = [...root.querySelectorAll('div, span')];

    for (const node of nodes) {
      const nodeLabel = normalizeLabelText(text(node));
      if (nodeLabel !== wanted) continue;

      let sib = node.nextElementSibling;
      while (sib) {
        const val = text(sib);
        if (val && normalizeLabelText(val) !== wanted) return val;
        sib = sib.nextElementSibling;
      }

      const parent = node.parentElement;
      if (parent) {
        const children = [...parent.children];
        for (const child of children) {
          if (child === node) continue;
          const val = text(child);
          if (val && normalizeLabelText(val) !== wanted) return val;
        }
      }
    }

    return '';
  }

  function buildOrderUrl({ isin, direction, qty, price }) {
    const url = new URL('/meindepot/kaufenverkaufen', location.origin);
    url.searchParams.set('isin', isin);
    url.searchParams.set('direction', direction === 'Kauf' ? 'buy' : 'sell');
    if (qty != null) url.searchParams.set('quantity', String(qty));
    url.searchParams.set('execType', 'limit');
    if (price != null) url.searchParams.set('limitPrice', formatPriceForUrl(price));

    url.searchParams.set('tmPrep', '1');
    url.searchParams.set('tmAutoReview', '1');

    return url.toString();
  }

  function clickLikeHuman(el) {
    if (!el) return;
    el.focus();
    el.click();
  }

  async function waitForButton(matchers, timeoutMs = CONFIG.BUTTON_CLICKABLE_TIMEOUT_MS, intervalMs = CONFIG.BUTTON_CLICKABLE_POLL_MS) {
    const end = Date.now() + timeoutMs;
    let lastSeenButDisabled = false;

    while (Date.now() < end) {
      const clickableBtn = findButtonByText(matchers, document, { requireClickable: true });
      if (clickableBtn) return clickableBtn;

      const visibleBtn = findButtonByText(matchers, document, { requireClickable: false });
      if (visibleBtn && !lastSeenButDisabled) {
        lastSeenButDisabled = true;
        log('Button gefunden, aber (noch) disabled – warte auf Aktivierung:', normalizeText(visibleBtn.innerText || visibleBtn.textContent));
      }

      await wait(intervalMs);
    }

    return null;
  }

  async function waitForSelector(selector, timeoutMs = CONFIG.BUYING_POWER_WAIT_TIMEOUT_MS, intervalMs = CONFIG.BUYING_POWER_WAIT_POLL_MS) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const el = document.querySelector(selector);
      if (el) return el;
      await wait(intervalMs);
    }
    return null;
  }

  function getCurrentParams() {
    const url = new URL(location.href);
    const p = url.searchParams;

    const direction = p.get('direction') || null;
    const tmPrep = p.get('tmPrep') === '1' || p.get('tmPrep') === 'true';
    const tmAutoReview = p.get('tmAutoReview') === '1' || p.get('tmAutoReview') === 'true';

    const tmValidity = p.get('tmValidity') || null;
    const tmSpecificDate = p.get('tmSpecificDate') || null;

    const isin = p.get('isin') || null;
    const quantity = parseGermanNumber(p.get('quantity'));
    const limitPrice = parseGermanNumber(p.get('limitPrice'));

    return {
      direction,
      tmPrep,
      tmAutoReview,
      tmValidity,
      tmSpecificDate,
      isin,
      quantity,
      limitPrice
    };
  }

  function getTargetDateFromMode(mode, specificDate) {
    void mode;
    void specificDate;
    return null;
  }

  /**********************************************************************
   * KAUFKRAFT / DEPOTKREDIT
   **********************************************************************/
  function parseAvailableAmountFromContainer(container) {
    if (!container) return null;
    const raw = text(container);
    const match = raw.match(/verfügbar\s*(-?[\d.]+,\d{2})\s*€?/i);
    if (!match) return null;
    return parseGermanNumber(match[1]);
  }

  function parseActiveLombardCreditAmount(host) {
    if (!host) return null;

    const activeLombard = host.querySelector(CONFIG.SELECTORS.activeLombard);
    if (!activeLombard) return null;

    let sib = activeLombard.nextElementSibling;
    while (sib) {
      const raw = text(sib);
      if (/mit\s+depotkredit/i.test(raw) && !/möglich/i.test(raw)) {
        const match = raw.match(/([\d.]+,\d{2})\s*€?\s*$/);
        if (match) return parseGermanNumber(match[1]);
      }
      sib = sib.nextElementSibling;
    }

    return null;
  }

  async function getAvailableBuyingPower() {
    const host = await waitForSelector(CONFIG.SELECTORS.buyingPowerHost);
    if (!host) {
      log('Kaufkraft-Anzeige (.buying-power) nicht gefunden');
      return null;
    }

    const activeLombard = host.querySelector(CONFIG.SELECTORS.activeLombard);
    if (activeLombard) {
      const creditAmount = parseActiveLombardCreditAmount(host);
      if (creditAmount != null) {
        log('Kaufkraft (Depotkredit aktiv, "mit Depotkredit"-Zeile):', creditAmount);
        return creditAmount;
      }

      const fallbackAmount = parseAvailableAmountFromContainer(activeLombard);
      log('Kaufkraft (Depotkredit aktiv, Fallback "verfügbar"):', fallbackAmount);
      return fallbackAmount;
    }

    const possibleLombard = host.querySelector(CONFIG.SELECTORS.possibleLombard);
    if (possibleLombard) {
      const amount = parseAvailableAmountFromContainer(possibleLombard);
      log('Kaufkraft (Depotkredit möglich, "verfügbar"-Zeile):', amount);
      return amount;
    }

    const amount = parseAvailableAmountFromContainer(host);
    log('Kaufkraft (Fallback, ohne data-zid):', amount);
    return amount;
  }

  /**********************************************************************
   * KAUFPAUSE WEGEN ZU WENIG GUTHABEN (mit Cooldown + Sell-Trigger)
   **********************************************************************/
  function isBuyPausedForFunds(isin) {
    const until = STATE.insufficientFundsUntil.get(isin);
    if (!until) return false;
    if (Date.now() >= until) {
      STATE.insufficientFundsUntil.delete(isin);
      saveInsufficientFundsUntil(isin, null);
      return false;
    }
    return true;
  }

  function pauseBuyForInsufficientFunds(isin) {
    const until = Date.now() + CONFIG.INSUFFICIENT_FUNDS_RETRY_COOLDOWN_MS;
    STATE.insufficientFundsUntil.set(isin, until);
    saveInsufficientFundsUntil(isin, until);
  }

  function releaseInsufficientFundsPauses(reasonLabel) {
    if (STATE.insufficientFundsUntil.size === 0) return;

    log(`${reasonLabel} – gebe Kauf-Automatik für pausierte ISINs wieder frei:`, [...STATE.insufficientFundsUntil.keys()]);
    for (const isin of STATE.insufficientFundsUntil.keys()) {
      saveInsufficientFundsUntil(isin, null);
    }
    STATE.insufficientFundsUntil.clear();
  }

  /**********************************************************************
   * TABS
   **********************************************************************/
  function isTabActive(selector) {
    const el = document.querySelector(selector);
    return !!el && el.classList.contains('active');
  }

  function isOpenOrdersTabActive() {
    return isTabActive(CONFIG.SELECTORS.openOrdersTab);
  }

  function isExecutedOrdersTabActive() {
    return isTabActive(CONFIG.SELECTORS.executedOrdersTab);
  }

  function isAutoCreateModeActive() {
    return CONFIG.AUTO_CREATE_BUY || CONFIG.AUTO_CREATE_SELL;
  }

  async function clickTab(selector) {
    const el = document.querySelector(selector);
    if (!el) return false;
    if (el.classList.contains('active')) return true;

    clickLikeHuman(el);
    await wait(CONFIG.afterTabSwitchDelayMs);
    return true;
  }

  /**********************************************************************
   * OPEN ORDERS
   **********************************************************************/
  function parseOpenOrderRow(row) {
    const isin = text(row.querySelector(CONFIG.SELECTORS.openIsin));
    const qty = parseGermanNumber(text(row.querySelector(CONFIG.SELECTORS.openQty)));
    const direction = directionFromText(text(row.querySelector(CONFIG.SELECTORS.openDirection)));
    const execType = text(row.querySelector(CONFIG.SELECTORS.execType)) || null;

    const link = row.querySelector(CONFIG.SELECTORS.instrumentLink);
    const name = text(link);

    const stopLimitTextNode = row.querySelector(CONFIG.SELECTORS.stopLimitText);
    const stopLimitHostNode = row.querySelector(CONFIG.SELECTORS.stopLimitHost);
    const valueTextNode = row.querySelector(CONFIG.SELECTORS.orderValueText);
    const valueHostNode = row.querySelector(CONFIG.SELECTORS.orderValueHost);

    const price = parseEuro(text(stopLimitTextNode) || text(stopLimitHostNode));
    const parsedOrderValue = parseEuro(text(valueTextNode) || text(valueHostNode));
    const computedValue = orderValue(price, qty);

    return {
      row,
      isin,
      name,
      qty,
      direction,
      execType,
      price,
      orderValue: parsedOrderValue ?? computedValue,
      duplicateBtn: row.querySelector(CONFIG.SELECTORS.duplicateBtn),
      editBtn: row.querySelector(CONFIG.SELECTORS.editBtn),
      deleteBtn: row.querySelector(CONFIG.SELECTORS.deleteBtn)
    };
  }

  function getOpenOrdersFromVisibleTab() {
    if (!isOpenOrdersTabActive()) return null;

    const rows = [...document.querySelectorAll(CONFIG.SELECTORS.openRows)];
    const parsed = rows
      .map(parseOpenOrderRow)
      .filter(o => o.isin && o.direction && Number.isFinite(o.price))
      .filter(o => enabledIsins().includes(o.isin));

    log('Open rows gefunden:', rows.length);
    log('Open orders erkannt:', parsed.length);

    return parsed;
  }

  /**********************************************************************
   * DEPOTBESTAND (POSITIONEN-KACHEL)
   **********************************************************************/
  function parsePositionRow(row) {
    const link = row.querySelector(CONFIG.SELECTORS.instrumentLink);
    const href = link?.getAttribute('href') || '';
    const isin = href.match(/\/instrument\/([A-Z0-9]{6,12})/i)?.[1]?.toUpperCase() || null;
    if (!isin) return null;

    const qtyCell = row.querySelector(CONFIG.SELECTORS.positionQuantityCell) || row;
    const qty = parseGermanNumber(findLabeledValueFuzzy(qtyCell, 'Bestand'));

    const value =
      parseEuro(findLabeledValueFuzzy(row, 'Akt. Wert')) ??
      parseEuro(findLabeledValueFuzzy(row, 'Aktueller Wert'));

    return { isin, qty, value };
  }

  function scanPortfolioPositions() {
    const host = document.querySelector(CONFIG.SELECTORS.positionsHost);
    if (!host) return;

    const rows = [...host.querySelectorAll(CONFIG.SELECTORS.positionRows)];
    if (!rows.length) return;

    let foundAny = false;

    for (const row of rows) {
      const pos = parsePositionRow(row);
      if (!pos || !enabledIsins().includes(pos.isin)) continue;
      if (!Number.isFinite(pos.qty) && !Number.isFinite(pos.value)) continue;

      STATE.holdingsByIsin.set(pos.isin, {
        qty: pos.qty,
        value: pos.value,
        hasData: true
      });
      foundAny = true;
    }

    if (foundAny) {
      STATE.hasPositionSnapshot = true;
      log('Depotbestand aktualisiert:', [...STATE.holdingsByIsin.entries()]);
    }
  }

  function getHoldingForIsin(isin) {
    return STATE.holdingsByIsin.get(isin) || null;
  }

  /**********************************************************************
   * EXECUTIONS
   **********************************************************************/
  function parseExecutionFromSnackbarNode(node) {
    const raw = text(node);
    if (!/order ausgeführt/i.test(raw)) return null;

    const isin = raw.match(/\b[A-Z]{2}[A-Z0-9]{10}\b/)?.[0] || null;
    const direction = directionFromText(raw);
    const price = parseEuro(raw.match(/zu\s+([\d.]+,\d{1,2})\s*€/i)?.[1] || null);
    const qty = parseGermanNumber(raw.match(/(\d+)\s*stück\s+zu/i)?.[1] || null);
    const time = normalizeTime(raw.match(/\b(\d{1,2}:\d{2}:\d{2})\b/)?.[1] || '');
    const link = node.querySelector('a[href^="/instrument/"]');
    const name = text(link);

    if (!isin || !direction || !Number.isFinite(price)) return null;

    return {
      key: `snackbar|${time}|${isin}|${direction}|${qty}|${price}`,
      source: 'snackbar',
      date: '',
      time,
      isin,
      direction,
      qty,
      price,
      name,
      raw
    };
  }

  function parseExecutedOrderRow(row) {
    const raw = text(row);
    const isin = text(row.querySelector(CONFIG.SELECTORS.executedIsin));
    const qty = parseGermanNumber(text(row.querySelector(CONFIG.SELECTORS.executedQty)));
    const direction = directionFromText(text(row.querySelector(CONFIG.SELECTORS.executedDirection)));
    const execType = text(row.querySelector(CONFIG.SELECTORS.execType)) || null;
    const status = text(row.querySelector(CONFIG.SELECTORS.executedStatus)) || null;

    const link = row.querySelector(CONFIG.SELECTORS.instrumentLink);
    const name = text(link);

    const price =
      parseEuro(findLabeledValue(row, 'Ausführung')) ??
      parseEuro(raw.match(/Ausführung\s+([\d.]+,\d{1,2})/i)?.[1] || null);

    const date = findLabeledValue(row, 'Datum') || (raw.match(/\b\d{2}\.\d{2}\.\d{2}\b/)?.[0] || '');
    const time = normalizeTime(findLabeledValue(row, 'Uhrzeit') || '');

    if (!isin || !direction || !Number.isFinite(price)) return null;

    return {
      key: `executed-tab|${date}|${time}|${isin}|${direction}|${qty}|${price}`,
      source: 'executed-tab',
      date,
      time,
      isin,
      direction,
      qty,
      price,
      name,
      execType,
      status,
      raw
    };
  }

  function scanSnackbars() {
    const nodes = [...document.querySelectorAll(CONFIG.SELECTORS.snackbarMsg)];
    const latestByIsin = new Map();
    let newSellDetected = false;
    let seenKeysChanged = false;

    for (const node of nodes) {
      const exec = parseExecutionFromSnackbarNode(node);
      if (!exec) continue;
      if (!enabledIsins().includes(exec.isin)) continue;

      if (!STATE.seenSnackbarKeys.has(exec.key)) {
        STATE.seenSnackbarKeys.add(exec.key);
        seenKeysChanged = true;

        if (exec.direction === 'Verkauf') {
          newSellDetected = true;
        }
      }

      const existing = latestByIsin.get(exec.isin);
      if (!existing) {
        latestByIsin.set(exec.isin, exec);
        continue;
      }

      const existingKey = `${existing.date || ''} ${existing.time || ''}`.trim();
      const newKey = `${exec.date || ''} ${exec.time || ''}`.trim();

      if (newKey && (!existingKey || newKey > existingKey)) {
        latestByIsin.set(exec.isin, exec);
      } else if (!existingKey && !newKey) {
        latestByIsin.set(exec.isin, exec);
      }
    }

    STATE.snackbarLatestByIsin = latestByIsin;
    log('Snackbar-Ausführungen (nur neueste je ISIN):', [...latestByIsin.values()]);

    if (seenKeysChanged) {
      saveStringSet(SEEN_SNACKBAR_KEYS_STORAGE_KEY, STATE.seenSnackbarKeys, SEEN_KEYS_MAX);
    }

    if (newSellDetected) {
      releaseInsufficientFundsPauses('Neue Verkaufs-Ausführung (Snackbar) registriert');
    }
  }

  function scanExecutedTabLatestByIsin() {
    if (!isExecutedOrdersTabActive()) return;

    const rows = [...document.querySelectorAll(CONFIG.SELECTORS.executedRows)];
    const latestByIsin = new Map();
    let newSellDetected = false;
    let seenKeysChanged = false;

    for (const row of rows) {
      const exec = parseExecutedOrderRow(row);
      if (!exec) continue;
      if (!enabledIsins().includes(exec.isin)) continue;

      if (!STATE.seenExecutedKeys.has(exec.key)) {
        STATE.seenExecutedKeys.add(exec.key);
        seenKeysChanged = true;

        if (exec.direction === 'Verkauf') {
          newSellDetected = true;
        }
      }

      if (!latestByIsin.has(exec.isin)) {
        latestByIsin.set(exec.isin, exec);
      }
    }

    STATE.executedTabLatestByIsin = latestByIsin;
    log('Aktuellste Ausführungen aus Tab:', [...latestByIsin.values()]);

    if (seenKeysChanged) {
      saveStringSet(SEEN_EXECUTED_KEYS_STORAGE_KEY, STATE.seenExecutedKeys, SEEN_KEYS_MAX);
    }

    if (newSellDetected) {
      releaseInsufficientFundsPauses('Neue Verkaufs-Ausführung (Ausgeführt-Tab) registriert');
    }
  }

  function getEffectiveExecutions() {
    const result = [];

    for (const isin of enabledIsins()) {
      const fromExecutedTab = STATE.executedTabLatestByIsin.get(isin);
      const fromSnackbar = STATE.snackbarLatestByIsin.get(isin);

      if (fromExecutedTab) {
        result.push(fromExecutedTab);
      } else if (fromSnackbar) {
        result.push(fromSnackbar);
      }
    }

    return result;
  }

  /**********************************************************************
   * AUTOMATISCHER REITER-WECHSEL (OFFEN <-> AUSGEFÜHRT)
   **********************************************************************/
  async function autoSwitchTabsIfNeeded() {
    if (!isAutoCreateModeActive()) return false;
    if (STATE.autoTabCycleRunning) return false;

    const openTabExists = !!document.querySelector(CONFIG.SELECTORS.openOrdersTab);
    const executedTabExists = !!document.querySelector(CONFIG.SELECTORS.executedOrdersTab);
    if (!openTabExists || !executedTabExists) return false;

    const now = Date.now();

    const needsExecutedRefresh =
      !isExecutedOrdersTabActive() &&
      (
        STATE.executedTabLatestByIsin.size === 0 ||
        now - STATE.lastExecutedScanTs > CONFIG.EXECUTED_REFRESH_INTERVAL_MS
      );

    const needsOpenSnapshot = !isOpenOrdersTabActive() && !STATE.hasOpenOrdersSnapshot;

    if (!needsExecutedRefresh && !needsOpenSnapshot) return false;

    STATE.autoTabCycleRunning = true;
    try {
      if (needsExecutedRefresh) {
        log('Automatik: wechsle zu Reiter "Ausgeführt", um aktuelle Ausführungen zu lesen');
        const switched = await clickTab(CONFIG.SELECTORS.executedOrdersTab);
        if (switched) {
          scanExecutedTabLatestByIsin();
          STATE.lastExecutedScanTs = Date.now();
        }
      }

      log('Automatik: wechsle zu Reiter "Offen", um offene Orders zu lesen');
      const switchedBack = await clickTab(CONFIG.SELECTORS.openOrdersTab);
      if (switchedBack) {
        const openOrders = getOpenOrdersFromVisibleTab();
        if (openOrders !== null) {
          STATE.orders = openOrders;
          STATE.hasOpenOrdersSnapshot = true;
        }
      }

      return true;
    } catch (err) {
      console.error('[FZ-GRID] Fehler beim automatischen Reiter-Wechsel', err);
      return false;
    } finally {
      STATE.autoTabCycleRunning = false;
    }
  }

  /**********************************************************************
   * ANALYSE
   **********************************************************************/
  function findMatchingOrder(orders, isin, direction, price) {
    return orders.find(o =>
      o.isin === isin &&
      o.direction === direction &&
      isSamePrice(o.price ?? -99999, price) &&
      orderMeetsMinValue(o.price, o.qty)
    );
  }

  function getSellHeadroomQty(isin, referencePrice) {
    const holding = getHoldingForIsin(isin);
    if (!holding || !holding.hasData) return null;

    const pricePerShare =
      (Number.isFinite(holding.value) && Number.isFinite(holding.qty) && holding.qty > 0)
        ? holding.value / holding.qty
        : referencePrice;

    if (!Number.isFinite(pricePerShare) || pricePerShare <= 0) return null;
    if (!Number.isFinite(holding.qty)) return null;

    const reserveQty = reserveQtyForPrice(pricePerShare) ?? 0;
    const headroom = holding.qty - reserveQty;

    return Math.max(0, Math.floor(headroom));
  }

  function analyzeOrders(orders, executions) {
    const result = {};

    for (const isin of enabledIsins()) {
      const all = orders.filter(o => o.isin === isin);
      const buyOrders = all.filter(o => o.direction === 'Kauf').sort((a, b) => a.price - b.price);
      const sellOrders = all.filter(o => o.direction === 'Verkauf').sort((a, b) => a.price - b.price);
      const exec = executions.find(e => e.isin === isin) || null;

      const issues = [];
      const missing = [];
      const duplicateBuckets = new Map();

      if (!STATE.hasOpenOrdersSnapshot) {
        issues.push({
          type: 'snapshot',
          text: 'Noch kein Snapshot offener Orders vorhanden. Öffne einmal den Reiter "Offen".'
        });

        result[isin] = {
          isin,
          label: labelForIsin(isin),
          orders: all,
          buyOrders,
          sellOrders,
          exec,
          issues,
          missing
        };
        continue;
      }

      for (const order of all) {
        const dupKey = `${order.direction}|${order.price?.toFixed(2)}|${order.qty}`;
        if (!duplicateBuckets.has(dupKey)) duplicateBuckets.set(dupKey, []);
        duplicateBuckets.get(dupKey).push(order);

        if (!isHalfGrid(order.price)) {
          issues.push({
            type: 'offgrid',
            text: `${order.direction} ${formatEuro(order.price)} liegt nicht auf 0,50-Raster`
          });
        }

        if (!orderMeetsMinValue(order.price, order.qty)) {
          const val = orderValue(order.price, order.qty);
          issues.push({
            type: 'minvalue',
            text: `${order.direction} ${formatEuro(order.price)} mit Menge ${order.qty ?? '–'} ergibt nur ${formatEuro(val)}, erwartet mindestens ${formatEuro(CONFIG.MIN_ORDER_VALUE_EUR)}`
          });
        }
      }

      for (const [key, bucket] of duplicateBuckets.entries()) {
        if (bucket.length > 1) {
          const sample = bucket[0];
          issues.push({
            type: 'duplicate',
            text: `${key.replaceAll('|', ' · ')} existiert ${bucket.length}x`,
            action: 'delete-one-duplicate',
            isin,
            direction: sample.direction,
            price: sample.price,
            qty: sample.qty
          });
        }
      }

      if (buyOrders.length > 1) {
        issues.push({
          type: 'duplicate',
          text: `${buyOrders.length} Kauforders vorhanden; erlaubt ist nur 1`
        });
      }

      const buyPausedForFunds = isBuyPausedForFunds(isin);
      if (buyPausedForFunds) {
        const until = STATE.insufficientFundsUntil.get(isin);
        const remainingSec = until ? Math.max(0, Math.round((until - Date.now()) / 1000)) : 0;
        issues.push({
          type: 'buy-paused-funds',
          isin,
          text: `Kauf-Automatik für ${labelForIsin(isin)} pausiert (zu wenig Guthaben) – nächster automatischer Versuch in ca. ${remainingSec}s oder bei neuer Verkaufs-Ausführung.`
        });
      }

      if (exec) {
        const targets = calcTargets(exec.price);

        if (!isBuyEnabledForIsin(isin)) {
          issues.push({
            type: 'buy-disabled',
            text: `Kauf-Automatik für ${labelForIsin(isin)} ist deaktiviert (nur Abverkauf).`
          });
        } else if (!buyPausedForFunds) {
          const buyQty = minQtyForPrice(targets.buy);
          const buyExists = findMatchingOrder(all, isin, 'Kauf', targets.buy);

          if (!buyExists) {
            missing.push({
              source: exec,
              isin,
              direction: 'Kauf',
              price: targets.buy,
              qty: buyQty,
              targetValue: orderValue(targets.buy, buyQty),
              rule: targets.mode,
              autoCreatable: true,
              url: buildOrderUrl({
                isin,
                direction: 'Kauf',
                qty: buyQty,
                price: targets.buy
              })
            });
          }
        }

        const headroomQty = getSellHeadroomQty(isin, exec.price);

        if (headroomQty === null) {
          issues.push({
            type: 'reserve-unknown',
            text: `Depotbestand für Reserve-Prüfung unbekannt – Verkaufs-Automatik für ${labelForIsin(isin)} pausiert, bis der Depotbestand gelesen wurde.`
          });
        } else {
          let committedSellQty = sellOrders.reduce((sum, o) => sum + (Number.isFinite(o.qty) ? o.qty : 0), 0);
          let headroomExhausted = committedSellQty >= headroomQty;

          if (headroomExhausted && sellOrders.length > 0) {
            issues.push({
              type: 'reserve-limit',
              text: `Reserve von ${formatEuro(CONFIG.SELL_RESERVE_MIN_VALUE_EUR)} bereits ausgeschöpft – keine weiteren Verkaufsorders für ${labelForIsin(isin)} möglich.`
            });
          }

          const sellExists = findMatchingOrder(all, isin, 'Verkauf', targets.sell);

          const desiredSellPrices = [];
          if (!sellExists) desiredSellPrices.push(targets.sell);
          for (let i = 1; i < CONFIG.MIN_SELL_ORDERS_PER_ISIN; i++) {
            desiredSellPrices.push(roundToHalf(targets.sell + i * CONFIG.GRID_STEP));
          }

          for (const p of desiredSellPrices) {
            if (headroomExhausted) break;

            const existsAtPrice = sellOrders.some(o =>
              isSamePrice(o.price ?? -99999, p) && orderMeetsMinValue(o.price, o.qty)
            );
            const alreadyMissing = missing.some(m =>
              m.direction === 'Verkauf' && isSamePrice(m.price ?? -99999, p)
            );
            if (existsAtPrice || alreadyMissing) continue;

            const desiredQty = minQtyForPrice(p);
            const remainingHeadroom = headroomQty - committedSellQty;

            let qtyToUse = desiredQty;

            if (committedSellQty + desiredQty > headroomQty) {
              qtyToUse = remainingHeadroom;

              if (!orderMeetsMinValue(p, qtyToUse)) {
                issues.push({
                  type: 'reserve-limit',
                  text: `Verbleibender Spielraum (${qtyToUse > 0 ? qtyToUse : 0} Stk.) reicht bei ${formatEuro(p)} nicht für eine Order über ${formatEuro(CONFIG.MIN_ORDER_VALUE_EUR)} – Reserve von ${formatEuro(CONFIG.SELL_RESERVE_MIN_VALUE_EUR)} bleibt erhalten.`
                });
                headroomExhausted = true;
                continue;
              }
            }

            committedSellQty += qtyToUse;
            if (committedSellQty >= headroomQty) headroomExhausted = true;

            missing.push({
              source: exec,
              isin,
              direction: 'Verkauf',
              price: p,
              qty: qtyToUse,
              targetValue: orderValue(p, qtyToUse),
              rule: isSamePrice(p, targets.sell) ? targets.mode : 'grid',
              autoCreatable: true,
              url: buildOrderUrl({
                isin,
                direction: 'Verkauf',
                qty: qtyToUse,
                price: p
              })
            });
          }
        }
      }

      result[isin] = {
        isin,
        label: labelForIsin(isin),
        orders: all,
        buyOrders,
        sellOrders,
        exec,
        issues,
        missing
      };
    }

    return result;
  }

  /**********************************************************************
   * SINGLE BUY ORDER / AUTO CANCEL
   **********************************************************************/
  function findDesiredBuyOrder(data) {
    if (!data?.exec) return null;

    const targets = calcTargets(data.exec.price);

    return data.buyOrders.find(o =>
      isSamePrice(o.price, targets.buy) &&
      orderMeetsMinValue(o.price, o.qty)
    ) || null;
  }

  function getBuyOrderToKeep(data) {
    return findDesiredBuyOrder(data);
  }

  function getRedundantBuyOrders(data) {
    const keep = getBuyOrderToKeep(data);

    if (keep) {
      return data.buyOrders
        .filter(o => o !== keep)
        .sort((a, b) =>
          (a.price ?? Infinity) - (b.price ?? Infinity) ||
          (a.qty ?? 0) - (b.qty ?? 0)
        );
    }

    return [...data.buyOrders].sort((a, b) =>
      (a.price ?? Infinity) - (b.price ?? Infinity) ||
      (a.qty ?? 0) - (b.qty ?? 0)
    );
  }

  async function confirmCancellationIfNeeded() {
    await wait(250);

    const dialogRoots = [
      ...document.querySelectorAll('[role="dialog"], .cdk-overlay-container, .cdk-overlay-pane, mat-dialog-container')
    ];

    for (const root of dialogRoots) {
      const btn = findButtonByText(CONFIG.FORM.cancelConfirmTexts, root, { requireClickable: true });
      if (btn) {
        btn.click();
        await wait(CONFIG.CANCEL_WAIT_MS);
        return true;
      }
    }

    const fallbackBtn = findButtonByText(CONFIG.FORM.cancelConfirmTexts, document, { requireClickable: true });
    if (fallbackBtn) {
      fallbackBtn.click();
      await wait(CONFIG.CANCEL_WAIT_MS);
      return true;
    }

    return false;
  }

  async function deleteOneMatchingDuplicateOrder({ isin, direction, price, qty }) {
    if (CONFIG.DRY_RUN) {
      log('DRY_RUN: Dublette würde gelöscht werden', { isin, direction, price, qty });
      return false;
    }

    if (!isOpenOrdersTabActive()) {
      log('Dubletten-Löschung abgebrochen: Offen-Tab ist nicht aktiv');
      return false;
    }

    const candidates = STATE.orders.filter(o =>
      o.isin === isin &&
      o.direction === direction &&
      isSamePrice(o.price, price) &&
      (qty == null || o.qty === qty) &&
      o.deleteBtn
    );

    if (candidates.length < 2) {
      log('Keine löschbare Dublette gefunden:', { isin, direction, price, qty, found: candidates.length });
      return false;
    }

    const victim = candidates[0];
    const deleteKey = `${isin}|${direction}|${price}|${qty}|duplicate-click`;
    if (STATE.duplicateDeleteAttempts.has(deleteKey)) return false;

    try {
      STATE.duplicateDeleteAttempts.add(deleteKey);
      log('Lösche Dublette per Panel-Klick:', {
        isin,
        direction,
        price,
        qty,
        victim
      });

      victim.deleteBtn.click();
      await wait(300);
      await confirmCancellationIfNeeded();
      await wait(CONFIG.CANCEL_WAIT_MS);

      return true;
    } catch (err) {
      console.error('[FZ-GRID] Fehler beim Löschen einer Dublette', err);
      return false;
    }
  }

  async function enforceSingleBuyOrders(analysis) {
    if (!CONFIG.ENFORCE_SINGLE_BUY_ORDER) return false;
    if (CONFIG.DRY_RUN) return false;
    if (!isOpenOrdersTabActive()) return false;

    for (const isin of Object.keys(analysis)) {
      const d = analysis[isin];
      if (!d) continue;
      if (!d.buyOrders.length) continue;

      const redundantBuyOrders = getRedundantBuyOrders(d);
      if (!redundantBuyOrders.length) continue;

      const victim = redundantBuyOrders.find(o => o.deleteBtn);
      if (!victim) continue;

      const cancelKey = `${isin}|Kauf|${victim.price}|${victim.qty}`;
      if (STATE.cancelAttempts.has(cancelKey)) continue;

      try {
        STATE.cancelAttempts.add(cancelKey);
        log('Streiche veraltete/falsch bepreiste Kauforder automatisch:', cancelKey);

        victim.deleteBtn.click();
        await wait(300);
        await confirmCancellationIfNeeded();
        await wait(CONFIG.CANCEL_WAIT_MS);

        return true;
      } catch (err) {
        console.error('[FZ-GRID] Fehler beim Stornieren', err);
      }
    }

    return false;
  }

  /**********************************************************************
   * ROW MARKING
   **********************************************************************/
  function clearMarks() {
    document.querySelectorAll('.fz-grid-mark-duplicate, .fz-grid-mark-offgrid, .fz-grid-mark-minvalue')
      .forEach(el => el.classList.remove('fz-grid-mark-duplicate', 'fz-grid-mark-offgrid', 'fz-grid-mark-minvalue'));
  }

  function markRows(analysis) {
    clearMarks();
    if (!isOpenOrdersTabActive()) return;

    for (const isin of Object.keys(analysis)) {
      const data = analysis[isin];
      const dupMap = new Map();

      for (const o of data.orders) {
        const key = `${o.direction}|${o.price?.toFixed(2)}|${o.qty}`;
        dupMap.set(key, (dupMap.get(key) || 0) + 1);
      }

      for (const o of data.orders) {
        const key = `${o.direction}|${o.price?.toFixed(2)}|${o.qty}`;

        if ((dupMap.get(key) || 0) > 1) {
          o.row.classList.add('fz-grid-mark-duplicate');
        }
        if (!isHalfGrid(o.price)) {
          o.row.classList.add('fz-grid-mark-offgrid');
        }
        if (!orderMeetsMinValue(o.price, o.qty)) {
          o.row.classList.add('fz-grid-mark-minvalue');
        }
      }
    }
  }

  /**********************************************************************
   * PANEL
   **********************************************************************/
  function chipList(orders) {
    if (!orders.length) return `<div class="muted small">–</div>`;
    return `<div class="chips">${
      orders.map(o => `
        <span class="chip">
          <span>${escapeHtml(formatPrice(o.price))}</span>
          <span class="muted">x${escapeHtml(o.qty ?? '?')}</span>
          <span class="muted">≈ ${escapeHtml(formatPrice(orderValue(o.price, o.qty) ?? null))} €</span>
        </span>
      `).join('')
    }</div>`;
  }

  function holdingBlock(isin) {
    const holding = getHoldingForIsin(isin);
    if (!holding || !holding.hasData) {
      return `<div class="muted small">Depotbestand unbekannt – noch nicht gescannt.</div>`;
    }

    return `
      <div class="chips">
        <span class="chip">
          <span>Bestand</span>
          <span class="muted">x${escapeHtml(holding.qty ?? '?')}</span>
          <span class="muted">≈ ${escapeHtml(formatPrice(holding.value ?? null))} €</span>
        </span>
      </div>
    `;
  }

  function executionBlock(exec) {
    if (!exec) return `<div class="muted small">Keine aktuelle Ausführung für diese ISIN erkannt.</div>`;

    const when = [exec.date, exec.time].filter(Boolean).join(' ') || '–';

    return `
      <div class="chips">
        <span class="chip">
          <span>${escapeHtml(exec.source)}</span>
          <span>${escapeHtml(exec.direction)}</span>
          <span>${escapeHtml(formatPrice(exec.price))}</span>
          <span class="muted">x${escapeHtml(exec.qty ?? '?')}</span>
          <span class="muted">${escapeHtml(when)}</span>
        </span>
      </div>
    `;
  }

  function missingList(list) {
    if (!list.length) return `<div class="good small">Keine fehlenden Zielorders erkannt.</div>`;
    return `<div class="chips">${
      list.map(m => `
        <a
          class="chip ${m.direction === 'Kauf' ? 'chip-link-buy' : 'chip-link-sell'}"
          href="${escapeHtml(m.url)}"
          data-fz-same-tab="1"
          title="${escapeHtml(`${m.direction} ${formatPrice(m.price)} x${m.qty ?? '?'} öffnen`)}"
        >
          <span>${escapeHtml(m.direction)}</span>
          <span>${escapeHtml(formatPrice(m.price))}</span>
          <span class="muted">x${escapeHtml(m.qty ?? '?')}</span>
          <span class="muted">≈ ${escapeHtml(formatPrice(m.targetValue ?? null))} €</span>
          <span class="muted">← ${escapeHtml(m.source.direction)} ${escapeHtml(formatPrice(m.source.price))}</span>
        </a>
      `).join('')
    }</div>`;
  }

  function issuesList(list) {
    if (!list.length) return `<div class="good small">Keine Auffälligkeiten erkannt.</div>`;
    return `<ul>${
      list.map(i => {
        const cls =
          i.type === 'duplicate' || i.type === 'offgrid' || i.type === 'buy-paused-funds'
            ? 'bad'
            : 'warn-txt';

        if (i.action === 'delete-one-duplicate') {
          return `
            <li class="issue-action">
              <button
                type="button"
                class="chip chip-delete-dup"
                data-fz-delete-duplicate="1"
                data-isin="${escapeHtml(i.isin)}"
                data-direction="${escapeHtml(i.direction)}"
                data-price="${escapeHtml(i.price)}"
                data-qty="${escapeHtml(i.qty)}"
                title="Eine passende Dublette löschen"
              >
                <span class="${cls}">${escapeHtml(i.text)}</span>
                <span class="muted">↯ 1x löschen</span>
              </button>
            </li>
          `;
        }

        if (i.type === 'buy-paused-funds') {
          return `
            <li class="issue-action">
              <button
                type="button"
                class="chip chip-delete-dup"
                data-fz-clear-funds-pause="1"
                data-isin="${escapeHtml(i.isin)}"
                title="Kaufpause für diese ISIN sofort manuell aufheben"
              >
                <span class="${cls}">${escapeHtml(i.text)}</span>
                <span class="muted">↺ jetzt freigeben</span>
              </button>
            </li>
          `;
        }

        return `<li class="${cls}">${escapeHtml(i.text)}</li>`;
      }).join('')
    }</ul>`;
  }

  function updateAutoButtons(panel) {
    const buyBtn = panel.querySelector('#fz-grid-auto-buy');
    const sellBtn = panel.querySelector('#fz-grid-auto-sell');

    if (buyBtn) {
      buyBtn.textContent = `Auto Create Buy: ${CONFIG.AUTO_CREATE_BUY ? 'on' : 'off'}`;
      buyBtn.className = CONFIG.AUTO_CREATE_BUY ? 'warn' : 'secondary';
    }

    if (sellBtn) {
      sellBtn.textContent = `Auto Create Sell: ${CONFIG.AUTO_CREATE_SELL ? 'on' : 'off'}`;
      sellBtn.className = CONFIG.AUTO_CREATE_SELL ? 'warn' : 'secondary';
    }
  }

  function buyToggleButtonHtml(isin) {
    const enabled = isBuyEnabledForIsin(isin);
    return `
      <button
        type="button"
        class="tiny ${enabled ? 'buy-toggle-on' : 'buy-toggle-off'}"
        data-fz-toggle-buy="1"
        data-isin="${escapeHtml(isin)}"
        title="Kauf-Automatik für diese ISIN ${enabled ? 'deaktivieren' : 'aktivieren'}"
      >
        Kauf: ${enabled ? 'an' : 'aus'}
      </button>
    `;
  }

  function createPanel() {
    if (STATE.panel) return STATE.panel;

    const panel = document.createElement('div');
    panel.id = 'fz-grid-panel';
    panel.innerHTML = `
      <div class="hdr">
        <div class="hdr-top">
          <div>
            <div class="title">Grid Order Assistant</div>
            <div class="meta" id="fz-grid-meta">initialisiere…</div>
          </div>
          <div class="btnbar">
            <button id="fz-grid-refresh">Refresh</button>
            <button id="fz-grid-auto-buy" class="secondary">Auto Create Buy: off</button>
            <button id="fz-grid-auto-sell" class="secondary">Auto Create Sell: off</button>
            <button id="fz-grid-minimize" class="secondary" title="Panel einklappen/ausklappen">▁</button>
          </div>
        </div>
      </div>
      <div class="content" id="fz-grid-content"></div>
    `;

    document.body.appendChild(panel);

    panel.querySelector('#fz-grid-refresh').addEventListener('click', () => refresh(true));

    panel.querySelector('#fz-grid-auto-buy').addEventListener('click', () => {
      CONFIG.AUTO_CREATE_BUY = !CONFIG.AUTO_CREATE_BUY;
      saveSessionFlag(SESSION_KEYS.AUTO_CREATE_BUY, CONFIG.AUTO_CREATE_BUY);
      updateAutoButtons(panel);
      refresh(true);
    });

    panel.querySelector('#fz-grid-auto-sell').addEventListener('click', () => {
      CONFIG.AUTO_CREATE_SELL = !CONFIG.AUTO_CREATE_SELL;
      saveSessionFlag(SESSION_KEYS.AUTO_CREATE_SELL, CONFIG.AUTO_CREATE_SELL);
      updateAutoButtons(panel);
      refresh(true);
    });

    panel.querySelector('#fz-grid-minimize').addEventListener('click', () => {
      const minimized = panel.classList.toggle('minimized');
      saveSessionFlag(SESSION_KEYS.PANEL_MINIMIZED, minimized);
      panel.querySelector('#fz-grid-minimize').textContent = minimized ? '▢' : '▁';
    });

    const wasMinimized = loadSessionFlag(SESSION_KEYS.PANEL_MINIMIZED, false);
    if (wasMinimized) {
      panel.classList.add('minimized');
      panel.querySelector('#fz-grid-minimize').textContent = '▢';
    }

    panel.addEventListener('click', async (ev) => {
      const link = ev.target.closest('a[data-fz-same-tab="1"]');
      if (link) {
        ev.preventDefault();
        ev.stopPropagation();
        window.location.assign(link.href);
        return;
      }

      const toggleBuyBtn = ev.target.closest('button[data-fz-toggle-buy="1"]');
      if (toggleBuyBtn) {
        ev.preventDefault();
        ev.stopPropagation();

        const isin = toggleBuyBtn.dataset.isin;
        const newValue = !isBuyEnabledForIsin(isin);
        setBuyEnabledForIsin(isin, newValue);
        log(`Kauf-Automatik für ${isin} ${newValue ? 'aktiviert' : 'deaktiviert'}`);
        refresh(true);
        return;
      }

      const clearFundsPauseBtn = ev.target.closest('button[data-fz-clear-funds-pause="1"]');
      if (clearFundsPauseBtn) {
        ev.preventDefault();
        ev.stopPropagation();

        const isin = clearFundsPauseBtn.dataset.isin;
        STATE.insufficientFundsUntil.delete(isin);
        saveInsufficientFundsUntil(isin, null);
        log(`Kaufpause für ${isin} manuell aufgehoben`);
        refresh(true);
        return;
      }

      const dupBtn = ev.target.closest('button[data-fz-delete-duplicate="1"]');
      if (dupBtn) {
        ev.preventDefault();
        ev.stopPropagation();

        dupBtn.disabled = true;
        try {
          const deleted = await deleteOneMatchingDuplicateOrder({
            isin: dupBtn.dataset.isin,
            direction: dupBtn.dataset.direction,
            price: parseGermanNumber(dupBtn.dataset.price),
            qty: parseGermanNumber(dupBtn.dataset.qty)
          });

          if (deleted) {
            await refresh(true);
          }
        } finally {
          dupBtn.disabled = false;
        }
      }
    });

    updateAutoButtons(panel);

    STATE.panel = panel;
    return panel;
  }

  function renderPanel(analysis, executions) {
    const panel = createPanel();
    const meta = panel.querySelector('#fz-grid-meta');
    const content = panel.querySelector('#fz-grid-content');

    const activeTab =
      isOpenOrdersTabActive() ? 'Offen aktiv' :
      isExecutedOrdersTabActive() ? 'Ausgeführt aktiv' :
      'anderer Bereich';

    const snapshotState = STATE.hasOpenOrdersSnapshot
      ? 'Offen-Snapshot vorhanden'
      : 'kein Offen-Snapshot';

    const positionState = STATE.hasPositionSnapshot
      ? 'Depotbestand vorhanden'
      : 'kein Depotbestand-Snapshot';

    const pausedCount = STATE.insufficientFundsUntil.size;

    meta.textContent = [
      `${STATE.orders.length} offene Orders`,
      `${executions.length} aktuelle Ausführungen`,
      `Mindestwert ${formatEuro(CONFIG.MIN_ORDER_VALUE_EUR)}`,
      `Reserve ${formatEuro(CONFIG.SELL_RESERVE_MIN_VALUE_EUR)}`,
      activeTab,
      snapshotState,
      positionState,
      pausedCount > 0 ? `${pausedCount} ISIN(s) Kauf pausiert (Guthaben)` : 'keine Kaufpausen',
      new Date().toLocaleTimeString('de-DE')
    ].join(' · ');

    const html = enabledIsins().map(isin => {
      const d = analysis[isin];
      return `
        <section class="card">
          <h3>
            <div class="h3-left">
              <span>${escapeHtml(d.label)}</span>
              <span class="muted">${escapeHtml(isin)}</span>
            </div>
            ${buyToggleButtonHtml(isin)}
          </h3>

          <div class="section-label">Depotbestand</div>
          ${holdingBlock(isin)}

          <div class="section-label">Kauforders</div>
          ${chipList(d.buyOrders)}

          <div class="section-label">Verkaufsorders</div>
          ${chipList(d.sellOrders)}

          <div class="section-label">Berücksichtigte Ausführung</div>
          ${executionBlock(d.exec)}

          <div class="section-label">Fehlende Zielorders</div>
          ${missingList(d.missing)}

          <div class="section-label">Auffälligkeiten</div>
          ${issuesList(d.issues)}
        </section>
      `;
    }).join('');

    content.innerHTML = html || `<div class="card">Keine aktive ISIN konfiguriert.</div>`;
  }

  /**********************************************************************
   * AUTO CREATE über /meindepot/kaufenverkaufen
   **********************************************************************/
  async function createMissingOrders(analysis) {
    if (CONFIG.DRY_RUN) return;

    for (const isin of Object.keys(analysis)) {
      const d = analysis[isin];
      if (!d || !d.missing?.length) continue;

      for (const m of d.missing) {
        if (!m.autoCreatable) continue;
        if (!Number.isFinite(m.qty) || m.qty <= 0) continue;

        if (m.direction === 'Kauf') {
          if (!CONFIG.AUTO_CREATE_BUY) continue;
          if (!isBuyEnabledForIsin(isin)) {
            log('Kauforder-Erstellung übersprungen, Kauf-Automatik für ISIN deaktiviert:', isin);
            continue;
          }
          if (isBuyPausedForFunds(isin)) {
            log('Kauforder-Erstellung übersprungen, ISIN wegen Guthabenmangel pausiert:', isin);
            continue;
          }
          if (CONFIG.ENFORCE_SINGLE_BUY_ORDER && d.buyOrders.length > 0) {
            log('Kauforder-Erstellung übersprungen, solange noch Kauforders existieren:', isin);
            continue;
          }
        } else if (m.direction === 'Verkauf') {
          if (!CONFIG.AUTO_CREATE_SELL) continue;
        } else {
          continue;
        }

        const createKey = `${isin}|${m.direction}|${m.price}|${m.qty}`;
        if (STATE.createAttempts.has(createKey)) continue;
        STATE.createAttempts.add(createKey);

        log('Starte Auto Create via /meindepot/kaufenverkaufen:', {
          isin,
          direction: m.direction,
          price: m.price,
          qty: m.qty,
          url: m.url
        });

        try {
          window.location.assign(m.url);
        } catch (err) {
          console.error('[FZ-GRID] Fehler beim Auto-Create-Redirect', err);
        }

        return;
      }
    }
  }

  /**********************************************************************
   * ERFOLGSSEITE NACH ORDERAUFGABE -> AUTOMATISCH "ZUM DEPOT" KLICKEN
   **********************************************************************/
  function isOrderSuccessPageVisible() {
    const bodyText = normalizeText(document.body?.innerText || '').toLowerCase();
    if (!bodyText) return false;
    return CONFIG.FORM.successTexts.some(t => bodyText.includes(t));
  }

  async function autoClickZumDepotOnSuccess() {
    const successVisible = isOrderSuccessPageVisible();

    if (!successVisible) {
      STATE.zumDepotHandled = false;
      return;
    }

    if (STATE.zumDepotHandled) return;

    const zumDepotBtn = findButtonByText(CONFIG.FORM.zumDepotTexts, document, { requireClickable: true });
    if (!zumDepotBtn) {
      log('Erfolgsseite erkannt, aber "ZUM DEPOT"-Button nicht gefunden oder noch disabled');
      return;
    }

    STATE.zumDepotHandled = true;

    log('Erfolgsseite erkannt, klicke automatisch auf "ZUM DEPOT"');
    clickLikeHuman(zumDepotBtn);

    await sleep(CONFIG.afterZumDepotClickDelayMs);
  }

  /**********************************************************************
   * AUTO PREPARE CURRENT ORDER PAGE (ORDER PRÜFEN + KOSTENPFLICHTIG)
   * inkl. Kaufkraft-Prüfung vor dem eigentlichen Kauf
   **********************************************************************/
  async function autoPrepareCurrentOrderPage() {
    const params = getCurrentParams();
    if (!params.tmPrep) return;
    if (!location.pathname.includes('/meindepot/kaufenverkaufen')) return;
    if (params.direction !== 'sell' && params.direction !== 'buy') return;

    if (params.direction === 'buy' && params.isin) {
      const requiredValue = orderValue(params.limitPrice, params.quantity);
      const available = await getAvailableBuyingPower();

      if (Number.isFinite(available) && Number.isFinite(requiredValue) && available < requiredValue) {
        log('Zu wenig Guthaben für Kauf:', {
          isin: params.isin,
          requiredValue,
          available
        });

        pauseBuyForInsufficientFunds(params.isin);
        STATE.orderAbortHandled = true;

        log(`Kauf-Automatik für ${params.isin} pausiert (verfügbar ${formatEuro(available)} < benötigt ${formatEuro(requiredValue)}). Navigiere zurück zur Übersicht.`);

        await sleep(300);
        window.location.assign('/uebersicht');
        return;
      }
    }

    const targetDate = getTargetDateFromMode(params.tmValidity, params.tmSpecificDate);

    if (targetDate) {
      await sleep(CONFIG.afterDateSetDelayMs);
    }

    if (params.tmAutoReview) {
      log('Auto confirm gestartet');

      const firstMatchers = ['ORDER PRÜFEN'];
      const secondMatchers = ['ORDER KOSTENPFLICHTIG AUFGEBEN', 'KOSTENPFLICHTIG ORDERN'];

      const firstBtn = await waitForButton(firstMatchers);
      if (!firstBtn) {
        log('Button "ORDER PRÜFEN" nicht gefunden oder blieb dauerhaft disabled');
        return;
      }

      log('Klicke ersten Button:', normalizeText(firstBtn.innerText || firstBtn.textContent));
      clickLikeHuman(firstBtn);

      await sleep(CONFIG.afterFirstClickDelayMs);

      const secondBtn = await waitForButton(secondMatchers);
      if (!secondBtn) {
        log('Button "ORDER KOSTENPFLICHTIG AUFGEBEN" nicht gefunden oder blieb dauerhaft disabled');
        return;
      }

      log('Klicke zweiten Button:', normalizeText(secondBtn.innerText || secondBtn.textContent));
      clickLikeHuman(secondBtn);

      await sleep(CONFIG.afterSecondClickDelayMs);
      log('Auto confirm beendet');

      await autoClickZumDepotOnSuccess();
    }
  }

  /**********************************************************************
   * REFRESH
   **********************************************************************/
  async function refresh(force = false) {
    const now = Date.now();
    if (!force && now - STATE.lastRefreshTs < 300) return;
    if (STATE.refreshRunning) return;

    STATE.refreshRunning = true;
    STATE.lastRefreshTs = now;

    try {
      await autoClickZumDepotOnSuccess();
      if (STATE.zumDepotHandled) return;

      await autoSwitchTabsIfNeeded();

      scanSnackbars();
      scanExecutedTabLatestByIsin();
      scanPortfolioPositions();

      const openOrders = getOpenOrdersFromVisibleTab();
      if (openOrders !== null) {
        STATE.orders = openOrders;
        STATE.hasOpenOrdersSnapshot = true;
      }

      const executions = getEffectiveExecutions();
      const analysis = analyzeOrders(STATE.orders, executions);

      markRows(analysis);
      renderPanel(analysis, executions);

      const cancelledAnyBuyOrder = await enforceSingleBuyOrders(analysis);
      if (cancelledAnyBuyOrder) return;

      await createMissingOrders(analysis);
    } catch (err) {
      console.error('[FZ-GRID] Refresh-Fehler', err);
    } finally {
      STATE.refreshRunning = false;
    }
  }

  /**********************************************************************
   * BOOT
   **********************************************************************/
  function boot() {
    addStyle(STYLE);
    createPanel();

    refresh(true);

    STATE.observer = new MutationObserver(() => refresh(false));
    STATE.observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });

    setInterval(() => refresh(false), CONFIG.POLL_MS);

    autoPrepareCurrentOrderPage().catch(err => {
      console.error('[FZ-GRID] autoPrepareCurrentOrderPage Fehler', err);
    });

    log('Script gestartet, AUTO_CREATE_BUY:', CONFIG.AUTO_CREATE_BUY, 'AUTO_CREATE_SELL:', CONFIG.AUTO_CREATE_SELL);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
