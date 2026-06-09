// ==UserScript==
// @name         InfraDesk Despesas • Trava por usuário logado
// @namespace    clncentral/infradesk
// @version      4.0.5
// @description  Marca/libera despesa no Firebase com operador e ts, e bloqueia abertura/gravação para outro usuário.
// @author       CLN Central
// @match        https://asp.infradesk.app/backend/despesas*
// @match        https://asp.infradesk.app/backend/despesas/*
// @run-at       document-end
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @grant        unsafeWindow
// @connect      infradesk-operadores-default-rtdb.firebaseio.com
// @updateURL    https://clncentral.github.io/leitorxml/script/tamperMonkey.js
// @downloadURL  https://clncentral.github.io/leitorxml/script/tamperMonkey.js
// ==/UserScript==

(function () {
  'use strict';

  var InfraDeskDespesas = {};

  InfraDeskDespesas.__name = 'InfraDeskDespesas';

  try {
    Object.defineProperty(InfraDeskDespesas, 'constructor', {
      value: { name: 'InfraDeskDespesas' },
      enumerable: false,
      configurable: true
    });
  } catch (_) {}

  InfraDeskDespesas.FIREBASE_DB_URL = 'https://infradesk-operadores-default-rtdb.firebaseio.com';
  InfraDeskDespesas.FIREBASE_PATH = 'despesas_updates/by_id';

  InfraDeskDespesas.CORES_FIXAS_POR_USUARIO = {
    'Elias Araujo': '#0324ff',
    'Camily Assis': '#e6cff2',
    'Elia Maria': '#962bcc',
    'Patricia': '#ff8e03',
    'Marcia': '#6a0e9c',
    'Helena': '#8c1223'
  };

  InfraDeskDespesas.COR_SEM_USUARIO = '#ffffff';

  InfraDeskDespesas.state = {
    started: false,
    ownMutation: false,
    observer: null,
    bodyObserver: null,
    eventSource: null,
    firebaseCache: {},
    debounceTimer: null,
    startupTimer: null,
    startupCount: 0,
    currentModalDespesaId: '',
    lastFirebaseError: '',
    user: {
      nome: '',
      id: ''
    },
    savingIds: {},
    openingIds: {}
  };

  InfraDeskDespesas.clean = function (value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  };

  InfraDeskDespesas.norm = function (value) {
    return InfraDeskDespesas.clean(value)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  };

  InfraDeskDespesas.firebaseUrl = function (path) {
    var base = InfraDeskDespesas.FIREBASE_DB_URL.replace(/\/+$/, '');
    var cleanPath = String(path || '').replace(/^\/+/, '');
    return base + '/' + cleanPath + '.json';
  };

  InfraDeskDespesas.isOkResponse = function (res) {
    return res && res.status >= 200 && res.status < 300;
  };

  InfraDeskDespesas.parseJson = function (text, fallback) {
    try {
      return JSON.parse(text || '');
    } catch (_) {
      return fallback;
    }
  };

  InfraDeskDespesas.shortResponse = function (text) {
    text = InfraDeskDespesas.clean(text || '');

    if (text.length > 240) {
      return text.slice(0, 240) + '...';
    }

    return text;
  };

  InfraDeskDespesas.formatResponseError = function (res) {
    if (!res) {
      return 'sem resposta';
    }

    return 'status ' + res.status + (res.responseText ? ' - ' + InfraDeskDespesas.shortResponse(res.responseText) : '');
  };

  InfraDeskDespesas.request = function (opts) {
    opts = opts || {};

    return new Promise(function (resolve, reject) {
      var req = {
        method: opts.method || 'GET',
        url: opts.url,
        headers: opts.headers || {},
        data: opts.data == null ? null : opts.data,
        timeout: opts.timeout || 30000,
        onload: function (res) {
          resolve(res);
        },
        onerror: function (err) {
          reject(err || new Error('GM_xmlhttpRequest onerror'));
        },
        ontimeout: function () {
          reject(new Error('timeout'));
        }
      };

      try {
        if (typeof GM_xmlhttpRequest === 'function') {
          GM_xmlhttpRequest(req);
          return;
        }

        if (typeof GM !== 'undefined' && GM && typeof GM.xmlHttpRequest === 'function') {
          var result = GM.xmlHttpRequest(req);

          if (result && typeof result.then === 'function') {
            result.then(resolve).catch(reject);
          }

          return;
        }

        fetch(opts.url, {
          method: opts.method || 'GET',
          headers: opts.headers || {},
          body: opts.data == null ? undefined : opts.data,
          cache: 'no-store',
          credentials: 'omit'
        }).then(function (res) {
          return res.text().then(function (text) {
            resolve({
              status: res.status,
              responseText: text,
              finalUrl: res.url
            });
          });
        }).catch(reject);
      } catch (err) {
        reject(err);
      }
    });
  };

  InfraDeskDespesas.notify = function (type, message) {
    var root = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    var toastr = root.toastr || window.toastr;

    if (toastr && typeof toastr[type] === 'function') {
      toastr[type](message);
      return;
    }

    if (type === 'error' || type === 'warning') {
      window.alert(message);
    }
  };

  InfraDeskDespesas.getTextWithoutChildren = function (el) {
    if (!el) {
      return '';
    }

    var text = '';

    for (var i = 0; i < el.childNodes.length; i++) {
      var node = el.childNodes[i];

      if (node.nodeType === 3) {
        text += node.nodeValue || '';
      }
    }

    return InfraDeskDespesas.clean(text || el.textContent || '');
  };

  InfraDeskDespesas.detectLoggedUserName = function () {
    var selectors = [
      '.profile-element strong.font-bold',
      '.profile-element .font-bold',
      '.logo-element .dropdown-menu big',
      '.nav-header .font-bold',
      '.nav-header big'
    ];

    for (var i = 0; i < selectors.length; i++) {
      var el = document.querySelector(selectors[i]);

      if (el) {
        var txt = InfraDeskDespesas.getTextWithoutChildren(el);
        txt = txt.replace(/\s*\bSair\b\s*$/i, '');
        txt = txt.replace(/\s*\bMeus dados\b\s*$/i, '');
        txt = InfraDeskDespesas.clean(txt);

        if (txt && !/central|libera/i.test(txt) && txt.length >= 3) {
          return txt;
        }
      }
    }

    var strong = document.querySelector('.nav-header strong');

    if (strong) {
      return InfraDeskDespesas.clean(strong.textContent || '');
    }

    return '';
  };

  InfraDeskDespesas.detectLoggedUserId = function () {
    var html = document.documentElement ? document.documentElement.innerHTML : '';

    var patterns = [
      /avatar_usuario_(\d+)/i,
      /atendente_id=(\d+)/i,
      /\/avatar\/(\d+)\//i
    ];

    for (var i = 0; i < patterns.length; i++) {
      var match = html.match(patterns[i]);

      if (match && match[1]) {
        return InfraDeskDespesas.clean(match[1]);
      }
    }

    return '';
  };

  InfraDeskDespesas.refreshLoggedUser = function () {
    var nome = InfraDeskDespesas.detectLoggedUserName();
    var id = InfraDeskDespesas.detectLoggedUserId();

    if (nome) {
      InfraDeskDespesas.state.user.nome = nome;
    }

    if (id) {
      InfraDeskDespesas.state.user.id = id;
    }

    return InfraDeskDespesas.state.user;
  };

  InfraDeskDespesas.normalizeFirebaseItem = function (item) {
    if (item == null) {
      return null;
    }

    if (typeof item === 'string') {
      return {
        operador: InfraDeskDespesas.clean(item),
        ts: 0
      };
    }

    if (typeof item === 'object') {
      return {
        operador: InfraDeskDespesas.clean(item.operador || item.usuario || item.nome || item.user || ''),
        ts: Number(item.ts || 0) || 0
      };
    }

    return {
      operador: '',
      ts: 0
    };
  };

  InfraDeskDespesas.getOwnerFromItem = function (item) {
    item = InfraDeskDespesas.normalizeFirebaseItem(item);

    if (!item) {
      return '';
    }

    return InfraDeskDespesas.clean(item.operador);
  };

  InfraDeskDespesas.getCurrentOwner = function (id) {
    id = InfraDeskDespesas.clean(id);

    if (!id) {
      return '';
    }

    return InfraDeskDespesas.getOwnerFromItem(InfraDeskDespesas.state.firebaseCache[id]);
  };

  InfraDeskDespesas.isSameUser = function (a, b) {
    return !!InfraDeskDespesas.norm(a) && InfraDeskDespesas.norm(a) === InfraDeskDespesas.norm(b);
  };

  InfraDeskDespesas.isOwnedByOtherUser = function (id) {
    var owner = InfraDeskDespesas.getCurrentOwner(id);
    var user = InfraDeskDespesas.state.user.nome;

    if (!owner) {
      return false;
    }

    if (!user) {
      return true;
    }

    return !InfraDeskDespesas.isSameUser(owner, user);
  };

  InfraDeskDespesas.colorForUser = function (name) {
    name = InfraDeskDespesas.clean(name);

    if (!name) {
      return InfraDeskDespesas.COR_SEM_USUARIO;
    }

    if (InfraDeskDespesas.CORES_FIXAS_POR_USUARIO[name]) {
      return InfraDeskDespesas.CORES_FIXAS_POR_USUARIO[name];
    }

    var h = 0;
    var key = InfraDeskDespesas.norm(name);

    for (var i = 0; i < key.length; i++) {
      h = (h * 31 + key.charCodeAt(i)) | 0;
    }

    return 'hsl(' + (Math.abs(h) % 360) + ' 72% 46%)';
  };

  InfraDeskDespesas.textColorForUser = function (name) {
    name = InfraDeskDespesas.clean(name);

    if (!name) {
      return '#334155';
    }

    if (name === 'Camily') {
      return '#111827';
    }

    return '#ffffff';
  };

  InfraDeskDespesas.getExpenseIdFromAction = function (action) {
    action = String(action || '');

    var patterns = [
      /\/backend\/despesas\/financeiro\/(\d+)/i,
      /\/backend\/despesas\/revisar\/(\d+)/i,
      /\/backend\/despesas\/aprovar\/(\d+)/i,
      /\/backend\/despesas\/bloquear\/(\d+)/i,
      /despesa_id=(\d+)/i,
      /abrirSolicitacao\((\d+)\)/i
    ];

    for (var i = 0; i < patterns.length; i++) {
      var match = action.match(patterns[i]);

      if (match && match[1]) {
        return InfraDeskDespesas.clean(match[1]);
      }
    }

    return '';
  };

  InfraDeskDespesas.getMainCell = function (tr) {
    if (!tr || !tr.children || !tr.children.length) {
      return null;
    }

    return tr.children[0];
  };

  InfraDeskDespesas.getNumberElement = function (tr) {
    var cell = InfraDeskDespesas.getMainCell(tr);

    if (!cell) {
      return null;
    }

    return cell.querySelector('p');
  };

  InfraDeskDespesas.getRowId = function (tr) {
    if (!tr) {
      return '';
    }

    var dataId = InfraDeskDespesas.clean(tr.getAttribute('data-sigma-id'));

    if (dataId) {
      return dataId;
    }

    var onclickButton = tr.querySelector('[onclick*="/backend/despesas/financeiro/"], [onclick*="/backend/despesas/revisar/"], [onclick*="/backend/despesas/aprovar/"], [onclick*="/backend/despesas/bloquear/"]');

    if (onclickButton) {
      var idFromButton = InfraDeskDespesas.getExpenseIdFromAction(onclickButton.getAttribute('onclick') || '');

      if (idFromButton) {
        return idFromButton;
      }
    }

    var firstCell = tr.children && tr.children.length ? tr.children[0] : null;

    if (!firstCell) {
      return '';
    }

    var p = firstCell.querySelector('p');

    if (p) {
      var pText = InfraDeskDespesas.clean(p.innerText || p.textContent || '');
      var pMatch = pText.match(/^\d{3,}$/);

      if (pMatch) {
        return pMatch[0];
      }
    }

    var text = InfraDeskDespesas.clean(firstCell.innerText || firstCell.textContent || '');
    var match = text.match(/\b\d{4,}\b/);

    return match ? match[0] : '';
  };

  InfraDeskDespesas.isMainDespesaRow = function (tr) {
    if (!tr) {
      return false;
    }

    if (tr.querySelector('th')) {
      return false;
    }

    if (tr.classList.contains('expandir')) {
      return false;
    }

    if (String(tr.className || '').indexOf('expandir-') >= 0) {
      return false;
    }

    var cells = Array.prototype.slice.call(tr.children || []);

    if (cells.length < 6) {
      return false;
    }

    var id = InfraDeskDespesas.getRowId(tr);

    if (!id) {
      return false;
    }

    var hasButtons = !!tr.querySelector('.td-buttons, a.btn, button.btn');
    var hasValor = cells.some(function (td) {
      return /\bR\$\s*/.test(td.innerText || td.textContent || '');
    });

    return hasButtons || hasValor || tr.hasAttribute('data-sigma-id');
  };

  InfraDeskDespesas.getMainRows = function () {
    var table = document.querySelector('.ibox-content table') || document.querySelector('table');

    if (!table) {
      return [];
    }

    return Array.prototype.slice.call(table.querySelectorAll('tbody tr')).filter(function (tr) {
      return InfraDeskDespesas.isMainDespesaRow(tr);
    });
  };

  InfraDeskDespesas.findRowsById = function (id) {
    id = InfraDeskDespesas.clean(id);

    if (!id) {
      return [];
    }

    return InfraDeskDespesas.getMainRows().filter(function (tr) {
      return InfraDeskDespesas.getRowId(tr) === id;
    });
  };

  InfraDeskDespesas.injectStyle = function () {
    if (document.getElementById('tm-infradesk-lock-style')) {
      return;
    }

    var style = document.createElement('style');
    style.id = 'tm-infradesk-lock-style';
    style.textContent = `
      tr.tr-index > td:first-child p {
        display: inline-block !important;
        margin: 0 4px 0 4px !important;
        vertical-align: middle !important;
        line-height: 22px !important;
      }

      .tm-op-inline {
        display: inline-flex !important;
        align-items: center !important;
        gap: 3px !important;
        margin: 0 0 0 4px !important;
        vertical-align: middle !important;
      }

      .tm-op-select {
        display: inline-block !important;
        width: 112px !important;
        height: 22px !important;
        min-height: 22px !important;
        max-height: 22px !important;
        border: 1px solid #94a3b8 !important;
        border-radius: 7px !important;
        color: #334155 !important;
        font-size: 10px !important;
        font-weight: 900 !important;
        padding: 1px 4px !important;
        outline: none !important;
        cursor: pointer !important;
        line-height: 18px !important;
        box-shadow: 0 1px 3px rgba(15, 23, 42, .08) !important;
        vertical-align: middle !important;
      }

      .tm-op-select:hover {
        border-color: #2563eb !important;
      }

      .tm-op-select:focus {
        border-color: #2563eb !important;
        box-shadow: 0 0 0 3px rgba(37, 99, 235, .14) !important;
      }

      .tm-op-select.tm-op-saving {
        opacity: .6 !important;
        pointer-events: none !important;
      }

      .tm-op-select option {
        background: #ffffff !important;
        color: #111827 !important;
        font-weight: 800 !important;
      }

      .tm-op-status {
        display: inline-block !important;
        min-width: 11px !important;
        color: #64748b !important;
        font-size: 10px !important;
        font-weight: 900 !important;
        line-height: 1 !important;
      }

      .tm-finance-blocked,
      .tm-save-blocked {
        opacity: .36 !important;
        cursor: not-allowed !important;
        filter: grayscale(1) !important;
      }

      .tm-finance-free {
        opacity: 1 !important;
        cursor: pointer !important;
        filter: none !important;
      }
    `;

    document.head.appendChild(style);
  };

  InfraDeskDespesas.createSelect = function (tr, id) {
    var select = document.createElement('select');
    select.className = 'tm-op-select';
    select.dataset.sigmaId = id;

    select.addEventListener('click', function (event) {
      event.stopPropagation();
    });

    select.addEventListener('mousedown', function (event) {
      event.stopPropagation();
    });

    select.addEventListener('change', function () {
      InfraDeskDespesas.onSelectChange(select);
    });

    return select;
  };

  InfraDeskDespesas.setStatusById = function (id, text) {
    var rows = InfraDeskDespesas.findRowsById(id);

    for (var i = 0; i < rows.length; i++) {
      var status = rows[i].querySelector('.tm-op-status');

      if (status) {
        status.textContent = text || '';
      }
    }
  };

  InfraDeskDespesas.updateSelectOptions = function (select, owner) {
    owner = InfraDeskDespesas.clean(owner);
    InfraDeskDespesas.refreshLoggedUser();

    var currentUser = InfraDeskDespesas.clean(InfraDeskDespesas.state.user.nome);
    var canRelease = !owner || (currentUser && InfraDeskDespesas.isSameUser(owner, currentUser));

    while (select.firstChild) {
      select.removeChild(select.firstChild);
    }

    if (canRelease) {
      var emptyOption = document.createElement('option');
      emptyOption.value = '';
      emptyOption.textContent = 'Sem usuário';
      select.appendChild(emptyOption);
    }

    if (owner) {
      var ownerOption = document.createElement('option');
      ownerOption.value = owner;
      ownerOption.textContent = owner;
      select.appendChild(ownerOption);
    }

    if (currentUser && !InfraDeskDespesas.isSameUser(owner, currentUser)) {
      var assumeOption = document.createElement('option');
      assumeOption.value = currentUser;
      assumeOption.textContent = currentUser;
      select.appendChild(assumeOption);
    }

    if (!select.options.length) {
      var fallbackOption = document.createElement('option');
      fallbackOption.value = '';
      fallbackOption.textContent = 'Sem usuário';
      select.appendChild(fallbackOption);
    }

    select.value = owner || '';
    InfraDeskDespesas.styleSelect(select, owner);
  };

  InfraDeskDespesas.styleSelect = function (select, owner) {
    owner = InfraDeskDespesas.clean(owner);

    var color = InfraDeskDespesas.colorForUser(owner);
    var textColor = InfraDeskDespesas.textColorForUser(owner);

    select.style.setProperty('background', color, 'important');
    select.style.setProperty('background-color', color, 'important');
    select.style.setProperty('color', textColor, 'important');
    select.style.setProperty('border-color', owner ? color : '#94a3b8', 'important');

    if (owner) {
      select.style.setProperty('box-shadow', '0 0 0 2px ' + color + '33', 'important');
    } else {
      select.style.setProperty('box-shadow', '0 1px 3px rgba(15, 23, 42, .08)', 'important');
    }
  };

  InfraDeskDespesas.ensureInlineSelect = function (tr) {
    var id = InfraDeskDespesas.getRowId(tr);
    var cell = InfraDeskDespesas.getMainCell(tr);

    if (!id || !cell) {
      return null;
    }

    var inline = cell.querySelector('.tm-op-inline');

    if (!inline) {
      inline = document.createElement('span');
      inline.className = 'tm-op-inline';

      var select = InfraDeskDespesas.createSelect(tr, id);
      var status = document.createElement('span');
      status.className = 'tm-op-status';

      inline.appendChild(select);
      inline.appendChild(status);

      var numberEl = InfraDeskDespesas.getNumberElement(tr);

      if (numberEl) {
        numberEl.insertAdjacentElement('afterend', inline);
      } else {
        cell.insertBefore(inline, cell.firstChild);
      }
    }

    return inline;
  };

  InfraDeskDespesas.paintOwnerOnRow = function (tr, owner) {
    owner = InfraDeskDespesas.clean(owner);

    InfraDeskDespesas.ensureInlineSelect(tr);

    var select = tr.querySelector('.tm-op-select');

    if (select) {
      InfraDeskDespesas.updateSelectOptions(select, owner);
    }

    var color = InfraDeskDespesas.colorForUser(owner);
    var firstCell = InfraDeskDespesas.getMainCell(tr);

    if (!owner) {
      tr.style.boxShadow = '';

      if (firstCell) {
        firstCell.style.boxShadow = '';
      }

      return;
    }

    tr.style.boxShadow = 'inset 5px 0 0 ' + color;

    if (firstCell) {
      firstCell.style.boxShadow = color + ' 6px 0px 0px inset';
    }
  };

  InfraDeskDespesas.updateRowUI = function (id, owner) {
    var rows = InfraDeskDespesas.findRowsById(id);

    for (var i = 0; i < rows.length; i++) {
      InfraDeskDespesas.paintOwnerOnRow(rows[i], owner);
    }

    InfraDeskDespesas.updateFinanceButtons();
    InfraDeskDespesas.updateModalSaveButtons();
  };

  InfraDeskDespesas.applyFirebaseItem = function (id, item) {
    id = InfraDeskDespesas.clean(id);

    if (!id) {
      return;
    }

    var normalized = InfraDeskDespesas.normalizeFirebaseItem(item);

    if (!normalized || !normalized.operador) {
      delete InfraDeskDespesas.state.firebaseCache[id];
      InfraDeskDespesas.updateRowUI(id, '');
      return;
    }

    InfraDeskDespesas.state.firebaseCache[id] = normalized;
    InfraDeskDespesas.updateRowUI(id, normalized.operador);
  };

  InfraDeskDespesas.injectRow = function (tr) {
    var id = InfraDeskDespesas.getRowId(tr);

    if (!id) {
      return;
    }

    InfraDeskDespesas.ensureInlineSelect(tr);

    var owner = InfraDeskDespesas.getCurrentOwner(id);
    InfraDeskDespesas.paintOwnerOnRow(tr, owner);
  };

  InfraDeskDespesas.injectAllRows = function () {
    var rows = InfraDeskDespesas.getMainRows();

    InfraDeskDespesas.state.ownMutation = true;

    try {
      for (var i = 0; i < rows.length; i++) {
        InfraDeskDespesas.injectRow(rows[i]);
      }

      InfraDeskDespesas.updateFinanceButtons();
      InfraDeskDespesas.updateModalSaveButtons();
    } finally {
      setTimeout(function () {
        InfraDeskDespesas.state.ownMutation = false;
      }, 0);
    }
  };

  InfraDeskDespesas.runFirebaseAttempts = async function (attempts) {
    var lastError = null;

    for (var i = 0; i < attempts.length; i++) {
      try {
        var res = await InfraDeskDespesas.request({
          method: attempts[i].method,
          url: attempts[i].url,
          headers: {
            'Content-Type': 'application/json'
          },
          data: attempts[i].data
        });

        if (InfraDeskDespesas.isOkResponse(res)) {
          InfraDeskDespesas.state.lastFirebaseError = '';
          return res;
        }

        lastError = new Error(InfraDeskDespesas.formatResponseError(res));
      } catch (err) {
        lastError = err;
      }
    }

    InfraDeskDespesas.state.lastFirebaseError = lastError ? InfraDeskDespesas.clean(lastError.message || String(lastError)) : 'erro desconhecido';
    throw lastError || new Error('Firebase failed');
  };

  InfraDeskDespesas.writeOwnerToFirebase = async function (id, owner, ts) {
    id = InfraDeskDespesas.clean(id);
    owner = InfraDeskDespesas.clean(owner);
    ts = Number(ts || Date.now()) || Date.now();

    var itemUrl = InfraDeskDespesas.firebaseUrl(InfraDeskDespesas.FIREBASE_PATH + '/' + encodeURIComponent(id));

    return InfraDeskDespesas.runFirebaseAttempts([
      {
        method: 'PUT',
        url: itemUrl,
        data: JSON.stringify({
          operador: owner,
          ts: ts
        })
      },
      {
        method: 'PATCH',
        url: itemUrl,
        data: JSON.stringify({
          operador: owner,
          ts: ts
        })
      },
      {
        method: 'PUT',
        url: itemUrl,
        data: JSON.stringify({
          usuario: owner,
          operador: owner,
          ts: ts
        })
      },
      {
        method: 'PATCH',
        url: itemUrl,
        data: JSON.stringify({
          usuario: owner,
          operador: owner,
          ts: ts
        })
      },
      {
        method: 'PUT',
        url: itemUrl,
        data: JSON.stringify({
          operador: owner,
          usuario: null,
          ts: ts
        })
      }
    ]);
  };

  InfraDeskDespesas.deleteOwnerFromFirebase = async function (id) {
    id = InfraDeskDespesas.clean(id);

    var itemUrl = InfraDeskDespesas.firebaseUrl(InfraDeskDespesas.FIREBASE_PATH + '/' + encodeURIComponent(id));
    var parentUrl = InfraDeskDespesas.firebaseUrl(InfraDeskDespesas.FIREBASE_PATH);
    var patchPayload = {};
    patchPayload[id] = null;

    return InfraDeskDespesas.runFirebaseAttempts([
      {
        method: 'DELETE',
        url: itemUrl,
        data: null
      },
      {
        method: 'PUT',
        url: itemUrl,
        data: 'null'
      },
      {
        method: 'PATCH',
        url: parentUrl,
        data: JSON.stringify(patchPayload)
      }
    ]);
  };

  InfraDeskDespesas.saveOwner = async function (id, owner, silent) {
    id = InfraDeskDespesas.clean(id);
    owner = InfraDeskDespesas.clean(owner);

    if (!id || !owner) {
      return false;
    }

    var previous = InfraDeskDespesas.state.firebaseCache[id] || null;
    var ts = Date.now();
    var payload = {
      operador: owner,
      ts: ts
    };

    InfraDeskDespesas.state.savingIds[id] = true;
    InfraDeskDespesas.state.firebaseCache[id] = payload;
    InfraDeskDespesas.updateRowUI(id, owner);

    if (!silent) {
      InfraDeskDespesas.setStatusById(id, '...');
    }

    try {
      await InfraDeskDespesas.writeOwnerToFirebase(id, owner, ts);

      InfraDeskDespesas.applyFirebaseItem(id, payload);

      if (!silent) {
        InfraDeskDespesas.setStatusById(id, '✓');

        setTimeout(function () {
          InfraDeskDespesas.setStatusById(id, '');
        }, 1200);
      }

      return true;
    } catch (err) {
      if (previous) {
        InfraDeskDespesas.state.firebaseCache[id] = previous;
        InfraDeskDespesas.updateRowUI(id, InfraDeskDespesas.getOwnerFromItem(previous));
      } else {
        delete InfraDeskDespesas.state.firebaseCache[id];
        InfraDeskDespesas.updateRowUI(id, '');
      }

      if (!silent) {
        InfraDeskDespesas.setStatusById(id, '!');
      }

      console.warn('[InfraDeskDespesas] erro ao salvar no Firebase', err);
      InfraDeskDespesas.notify('error', 'Não consegui salvar no Firebase: ' + (InfraDeskDespesas.state.lastFirebaseError || 'erro desconhecido'));
      return false;
    } finally {
      delete InfraDeskDespesas.state.savingIds[id];

      var rows = InfraDeskDespesas.findRowsById(id);

      for (var i = 0; i < rows.length; i++) {
        var select = rows[i].querySelector('.tm-op-select');

        if (select) {
          select.classList.remove('tm-op-saving');
        }
      }
    }
  };

  InfraDeskDespesas.deleteOwner = async function (id, silent) {
    id = InfraDeskDespesas.clean(id);

    if (!id) {
      return false;
    }

    var previous = InfraDeskDespesas.state.firebaseCache[id] || null;

    InfraDeskDespesas.state.savingIds[id] = true;
    delete InfraDeskDespesas.state.firebaseCache[id];
    InfraDeskDespesas.updateRowUI(id, '');

    if (!silent) {
      InfraDeskDespesas.setStatusById(id, '...');
    }

    try {
      await InfraDeskDespesas.deleteOwnerFromFirebase(id);

      delete InfraDeskDespesas.state.firebaseCache[id];
      InfraDeskDespesas.updateRowUI(id, '');

      if (!silent) {
        InfraDeskDespesas.setStatusById(id, '✓');

        setTimeout(function () {
          InfraDeskDespesas.setStatusById(id, '');
        }, 1200);
      }

      return true;
    } catch (err) {
      if (previous) {
        InfraDeskDespesas.state.firebaseCache[id] = previous;
        InfraDeskDespesas.updateRowUI(id, InfraDeskDespesas.getOwnerFromItem(previous));
      }

      if (!silent) {
        InfraDeskDespesas.setStatusById(id, '!');
      }

      console.warn('[InfraDeskDespesas] erro ao liberar no Firebase', err);
      InfraDeskDespesas.notify('error', 'Não consegui liberar no Firebase: ' + (InfraDeskDespesas.state.lastFirebaseError || 'erro desconhecido'));
      return false;
    } finally {
      delete InfraDeskDespesas.state.savingIds[id];

      var rows = InfraDeskDespesas.findRowsById(id);

      for (var i = 0; i < rows.length; i++) {
        var select = rows[i].querySelector('.tm-op-select');

        if (select) {
          select.classList.remove('tm-op-saving');
        }
      }
    }
  };

  InfraDeskDespesas.onSelectChange = async function (select) {
    var id = InfraDeskDespesas.clean(select.dataset.sigmaId);
    var novoUsuario = InfraDeskDespesas.clean(select.value);

    InfraDeskDespesas.refreshLoggedUser();

    var usuarioLogado = InfraDeskDespesas.clean(InfraDeskDespesas.state.user.nome);

    if (!id) {
      return;
    }

    if (!usuarioLogado) {
      InfraDeskDespesas.notify('error', 'Não consegui identificar o usuário logado.');
      InfraDeskDespesas.updateSelectOptions(select, InfraDeskDespesas.getCurrentOwner(id));
      return;
    }

    var atual = InfraDeskDespesas.getCurrentOwner(id);

    if (!novoUsuario) {
      if (!atual) {
        InfraDeskDespesas.updateSelectOptions(select, '');
        return;
      }

      if (!InfraDeskDespesas.isSameUser(atual, usuarioLogado)) {
        InfraDeskDespesas.notify('warning', 'Esta despesa está com ' + atual + '.');
        InfraDeskDespesas.updateSelectOptions(select, atual);
        return;
      }

      var confirmarLiberar = window.confirm('Deseja liberar esta despesa?\n\nEla ficará como Sem usuário.');

      if (!confirmarLiberar) {
        InfraDeskDespesas.updateSelectOptions(select, atual);
        return;
      }

      select.classList.add('tm-op-saving');
      await InfraDeskDespesas.deleteOwner(id, false);
      return;
    }

    if (!InfraDeskDespesas.isSameUser(novoUsuario, usuarioLogado)) {
      InfraDeskDespesas.updateSelectOptions(select, atual);
      return;
    }

    if (atual && !InfraDeskDespesas.isSameUser(atual, usuarioLogado)) {
      var ok = window.confirm('Esta despesa está com ' + atual + '.\n\nDeseja assumir para ' + usuarioLogado + '?');

      if (!ok) {
        InfraDeskDespesas.updateSelectOptions(select, atual);
        return;
      }
    }

    select.classList.add('tm-op-saving');

    await InfraDeskDespesas.saveOwner(id, usuarioLogado, false);
  };

  InfraDeskDespesas.loadFirebaseState = async function () {
    try {
      var res = await InfraDeskDespesas.request({
        method: 'GET',
        url: InfraDeskDespesas.firebaseUrl(InfraDeskDespesas.FIREBASE_PATH) + '?_=' + Date.now()
      });

      var data = InfraDeskDespesas.parseJson(res.responseText || '{}', {}) || {};
      var normalized = {};

      Object.keys(data).forEach(function (id) {
        var item = InfraDeskDespesas.normalizeFirebaseItem(data[id]);

        if (item && item.operador) {
          normalized[id] = item;
        }
      });

      InfraDeskDespesas.state.firebaseCache = normalized;

      Object.keys(normalized).forEach(function (id) {
        InfraDeskDespesas.applyFirebaseItem(id, normalized[id]);
      });

      InfraDeskDespesas.injectAllRows();
    } catch (err) {
      console.warn('[InfraDeskDespesas] erro ao carregar Firebase', err);
    }
  };

  InfraDeskDespesas.refreshFirebaseItem = async function (id) {
    id = InfraDeskDespesas.clean(id);

    if (!id) {
      return null;
    }

    try {
      var res = await InfraDeskDespesas.request({
        method: 'GET',
        url: InfraDeskDespesas.firebaseUrl(InfraDeskDespesas.FIREBASE_PATH + '/' + encodeURIComponent(id)) + '?_=' + Date.now()
      });

      if (!InfraDeskDespesas.isOkResponse(res)) {
        throw new Error(InfraDeskDespesas.formatResponseError(res));
      }

      var data = InfraDeskDespesas.parseJson(res.responseText || 'null', null);

      InfraDeskDespesas.applyFirebaseItem(id, data);

      return InfraDeskDespesas.normalizeFirebaseItem(data);
    } catch (err) {
      console.warn('[InfraDeskDespesas] erro ao atualizar item Firebase', err);
      return InfraDeskDespesas.normalizeFirebaseItem(InfraDeskDespesas.state.firebaseCache[id]);
    }
  };

  InfraDeskDespesas.firebaseStreamUrl = function () {
    return InfraDeskDespesas.FIREBASE_DB_URL.replace(/\/+$/, '') + '/' + InfraDeskDespesas.FIREBASE_PATH + '.json';
  };

  InfraDeskDespesas.handleFirebaseEvent = function (raw) {
    var parsed;

    try {
      parsed = JSON.parse(raw || '{}');
    } catch (_) {
      return;
    }

    var path = String(parsed.path || '');
    var data = parsed.data;

    if (path === '/' || path === '') {
      if (data === null) {
        InfraDeskDespesas.state.firebaseCache = {};
        InfraDeskDespesas.injectAllRows();
        return;
      }

      if (data && typeof data === 'object') {
        var normalized = {};

        Object.keys(data).forEach(function (id) {
          var item = InfraDeskDespesas.normalizeFirebaseItem(data[id]);

          if (item && item.operador) {
            normalized[id] = item;
          }
        });

        InfraDeskDespesas.state.firebaseCache = normalized;
        InfraDeskDespesas.injectAllRows();
      }

      return;
    }

    var cleanPath = path.replace(/^\/+/, '');
    var parts = cleanPath.split('/').filter(Boolean);

    if (!parts.length) {
      return;
    }

    var id = InfraDeskDespesas.clean(parts[0]);

    if (!id) {
      return;
    }

    if (data === null) {
      delete InfraDeskDespesas.state.firebaseCache[id];
      InfraDeskDespesas.updateRowUI(id, '');
      return;
    }

    if (parts.length === 1) {
      InfraDeskDespesas.applyFirebaseItem(id, data);
      return;
    }

    var current = InfraDeskDespesas.state.firebaseCache[id] || {};
    current[parts[1]] = data;
    InfraDeskDespesas.applyFirebaseItem(id, current);
  };

  InfraDeskDespesas.connectRealtime = function (manual) {
    try {
      if (InfraDeskDespesas.state.eventSource) {
        InfraDeskDespesas.state.eventSource.close();
        InfraDeskDespesas.state.eventSource = null;
      }

      var es = new EventSource(InfraDeskDespesas.firebaseStreamUrl());

      es.addEventListener('put', function (event) {
        InfraDeskDespesas.handleFirebaseEvent(event.data);
      });

      es.addEventListener('patch', function (event) {
        InfraDeskDespesas.handleFirebaseEvent(event.data);
      });

      es.onerror = function () {};

      InfraDeskDespesas.state.eventSource = es;

      if (manual) {
        InfraDeskDespesas.loadFirebaseState();
      }
    } catch (err) {
      console.warn('[InfraDeskDespesas] erro EventSource Firebase', err);
    }
  };

  InfraDeskDespesas.getLoadUrlFromAction = function (action) {
    action = String(action || '');

    var match = action.match(/\.load\(['"]([^'"]+)['"]\)/i);

    if (match && match[1]) {
      return match[1].replace(/&amp;/g, '&');
    }

    match = action.match(/(\/backend\/despesas\/financeiro\/\d+[^'"]*)/i);

    if (match && match[1]) {
      return match[1].replace(/&amp;/g, '&');
    }

    return '';
  };

  InfraDeskDespesas.isFinanceButton = function (el) {
    if (!el) {
      return false;
    }

    var onclick = el.getAttribute && el.getAttribute('onclick');

    if (!onclick) {
      return false;
    }

    return /\/backend\/despesas\/financeiro\/\d+/i.test(onclick);
  };

  InfraDeskDespesas.getFinanceButtons = function () {
    return Array.prototype.slice.call(document.querySelectorAll('button[onclick*="/backend/despesas/financeiro/"], a[onclick*="/backend/despesas/financeiro/"]'));
  };

  InfraDeskDespesas.storeButtonOriginalState = function (el) {
    if (!el.dataset.tmOriginalDisabled) {
      el.dataset.tmOriginalDisabled = el.disabled ? '1' : '0';
    }

    if (!el.dataset.tmOriginalDisabledClass) {
      el.dataset.tmOriginalDisabledClass = el.classList.contains('disabled') ? '1' : '0';
    }

    if (!el.dataset.tmOriginalTitle) {
      el.dataset.tmOriginalTitle = el.getAttribute('title') || el.getAttribute('data-original-title') || '';
    }
  };

  InfraDeskDespesas.blockElement = function (el, message, saveButton) {
    InfraDeskDespesas.storeButtonOriginalState(el);

    if (el.tagName && el.tagName.toLowerCase() === 'button') {
      el.disabled = true;
    }

    el.classList.add(saveButton ? 'tm-save-blocked' : 'tm-finance-blocked');
    el.classList.add('disabled');
    el.classList.remove('tm-finance-free');
    el.setAttribute('aria-disabled', 'true');
    el.setAttribute('title', message);
    el.setAttribute('data-original-title', message);
    el.dataset.tmBlockedByUser = '1';
  };

  InfraDeskDespesas.unblockElement = function (el, saveButton) {
    InfraDeskDespesas.storeButtonOriginalState(el);

    if (el.dataset.tmOriginalDisabled === '0' && el.tagName && el.tagName.toLowerCase() === 'button') {
      el.disabled = false;
    }

    if (el.dataset.tmOriginalDisabledClass === '0') {
      el.classList.remove('disabled');
    }

    el.classList.remove(saveButton ? 'tm-save-blocked' : 'tm-finance-blocked');
    el.classList.add('tm-finance-free');
    el.removeAttribute('aria-disabled');
    el.dataset.tmBlockedByUser = '0';

    var originalTitle = el.dataset.tmOriginalTitle || '';

    if (originalTitle) {
      el.setAttribute('title', originalTitle);
      el.setAttribute('data-original-title', originalTitle);
    }
  };

  InfraDeskDespesas.updateFinanceButtons = function () {
    InfraDeskDespesas.refreshLoggedUser();

    var buttons = InfraDeskDespesas.getFinanceButtons();

    for (var i = 0; i < buttons.length; i++) {
      var btn = buttons[i];
      var id = InfraDeskDespesas.getExpenseIdFromAction(btn.getAttribute('onclick') || '');

      if (!id) {
        continue;
      }

      btn.dataset.sigmaId = id;

      var owner = InfraDeskDespesas.getCurrentOwner(id);

      if (owner && InfraDeskDespesas.isOwnedByOtherUser(id)) {
        InfraDeskDespesas.blockElement(btn, 'Bloqueado: ' + owner, false);
      } else {
        InfraDeskDespesas.unblockElement(btn, false);
      }
    }
  };

  InfraDeskDespesas.executeModalLoad = function (el) {
    var onclick = el.getAttribute('onclick') || '';
    var url = InfraDeskDespesas.getLoadUrlFromAction(onclick);

    if (url) {
      var root = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
      var jq = root.jQuery || root.$ || window.jQuery || window.$;

      if (jq) {
        jq('#ModalDespesas').modal('show').find('.modal-body').load(url, function () {
          setTimeout(function () {
            InfraDeskDespesas.updateModalSaveButtons();
          }, 300);
        });
        return;
      }
    }

    try {
      var page = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

      if (page && typeof page.eval === 'function') {
        page.eval(onclick);
      } else {
        new Function(onclick).call(el);
      }
    } catch (err) {
      console.warn('[InfraDeskDespesas] erro ao abrir modal', err);
    }
  };

  InfraDeskDespesas.openFinanceWhenAllowed = async function (el) {
    var id = InfraDeskDespesas.getExpenseIdFromAction(el.getAttribute('onclick') || '');

    if (!id) {
      return;
    }

    if (InfraDeskDespesas.state.openingIds[id]) {
      return;
    }

    InfraDeskDespesas.state.openingIds[id] = true;

    try {
      InfraDeskDespesas.refreshLoggedUser();

      if (!InfraDeskDespesas.state.user.nome) {
        InfraDeskDespesas.notify('error', 'Não consegui identificar o usuário logado.');
        return;
      }

      await InfraDeskDespesas.refreshFirebaseItem(id);

      var owner = InfraDeskDespesas.getCurrentOwner(id);

      if (owner && InfraDeskDespesas.isOwnedByOtherUser(id)) {
        InfraDeskDespesas.updateFinanceButtons();
        InfraDeskDespesas.notify('warning', 'Esta despesa está com ' + owner + '.');
        return;
      }

      if (!owner) {
        var saved = await InfraDeskDespesas.saveOwner(id, InfraDeskDespesas.state.user.nome, true);

        if (!saved) {
          return;
        }
      }

      InfraDeskDespesas.state.currentModalDespesaId = id;
      InfraDeskDespesas.executeModalLoad(el);
    } finally {
      delete InfraDeskDespesas.state.openingIds[id];
    }
  };

  InfraDeskDespesas.isSaveButton = function (el) {
    if (!el) {
      return false;
    }

    var tag = (el.tagName || '').toLowerCase();

    if (tag !== 'button' && tag !== 'input') {
      return false;
    }

    var type = InfraDeskDespesas.clean(el.getAttribute('type') || 'submit').toLowerCase();

    if (type !== 'submit') {
      return false;
    }

    var text = InfraDeskDespesas.clean(el.innerText || el.textContent || el.value || '');
    var html = String(el.innerHTML || '');

    return /gravar/i.test(text) || /fa-save/i.test(html);
  };

  InfraDeskDespesas.getExpenseIdFromContext = function (el) {
    var form = el && el.closest ? el.closest('form') : null;
    var modal = el && el.closest ? el.closest('#ModalDespesas') : null;

    if (!modal) {
      modal = document.querySelector('#ModalDespesas');
    }

    var places = [];

    if (form) {
      places.push(form.getAttribute('action') || '');
      places.push(form.getAttribute('data-url') || '');
      places.push(form.outerHTML || '');
    }

    if (modal) {
      places.push(modal.innerHTML || '');
    }

    places.push(String(InfraDeskDespesas.state.currentModalDespesaId || ''));

    for (var i = 0; i < places.length; i++) {
      var value = places[i];

      if (!value) {
        continue;
      }

      var id = InfraDeskDespesas.getExpenseIdFromAction(value);

      if (id) {
        return id;
      }

      var match = String(value).match(/\/backend\/despesas\/(?:financeiro|revisar|aprovar|bloquear)\/(\d+)/i);

      if (match && match[1]) {
        return InfraDeskDespesas.clean(match[1]);
      }

      match = String(value).match(/(?:name=["']despesa_id["'][^>]*value=["']|despesa_id["'\s:=]+)(\d+)/i);

      if (match && match[1]) {
        return InfraDeskDespesas.clean(match[1]);
      }

      match = String(value).match(/^\d{4,}$/);

      if (match) {
        return InfraDeskDespesas.clean(match[0]);
      }
    }

    return '';
  };

  InfraDeskDespesas.getModalSaveButtons = function () {
    var modal = document.querySelector('#ModalDespesas');

    if (!modal) {
      return [];
    }

    return Array.prototype.slice.call(modal.querySelectorAll('button[type="submit"], input[type="submit"]')).filter(function (btn) {
      return InfraDeskDespesas.isSaveButton(btn);
    });
  };

  InfraDeskDespesas.updateModalSaveButtons = function () {
    var buttons = InfraDeskDespesas.getModalSaveButtons();

    for (var i = 0; i < buttons.length; i++) {
      var btn = buttons[i];
      var id = InfraDeskDespesas.getExpenseIdFromContext(btn);

      if (!id) {
        id = InfraDeskDespesas.state.currentModalDespesaId;
      }

      if (!id) {
        continue;
      }

      var owner = InfraDeskDespesas.getCurrentOwner(id);

      if (owner && InfraDeskDespesas.isOwnedByOtherUser(id)) {
        InfraDeskDespesas.blockElement(btn, 'Bloqueado: ' + owner, true);
      } else {
        InfraDeskDespesas.unblockElement(btn, true);
      }
    }
  };

  InfraDeskDespesas.submitFormAfterLock = function (form, button) {
    if (!form) {
      return;
    }

    form.dataset.tmAllowSubmitOnce = '1';

    if (form.requestSubmit) {
      form.requestSubmit(button || undefined);
      return;
    }

    form.submit();
  };

  InfraDeskDespesas.handleSaveWhenAllowed = async function (button) {
    var id = InfraDeskDespesas.getExpenseIdFromContext(button);

    if (!id) {
      id = InfraDeskDespesas.state.currentModalDespesaId;
    }

    if (!id) {
      return false;
    }

    InfraDeskDespesas.refreshLoggedUser();

    if (!InfraDeskDespesas.state.user.nome) {
      InfraDeskDespesas.notify('error', 'Não consegui identificar o usuário logado.');
      return false;
    }

    await InfraDeskDespesas.refreshFirebaseItem(id);

    var owner = InfraDeskDespesas.getCurrentOwner(id);

    if (owner && InfraDeskDespesas.isOwnedByOtherUser(id)) {
      InfraDeskDespesas.updateModalSaveButtons();
      InfraDeskDespesas.notify('warning', 'Esta despesa está com ' + owner + '.');
      return false;
    }

    if (!owner) {
      var saved = await InfraDeskDespesas.saveOwner(id, InfraDeskDespesas.state.user.nome, true);

      if (!saved) {
        return false;
      }
    }

    return true;
  };

  InfraDeskDespesas.onDocumentClickCapture = function (event) {
    var target = event.target;

    if (!target || !target.closest) {
      return;
    }

    var actionEl = target.closest('button, a');

    if (!actionEl) {
      return;
    }

    if (InfraDeskDespesas.isFinanceButton(actionEl)) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      InfraDeskDespesas.openFinanceWhenAllowed(actionEl);
      return;
    }

    if (InfraDeskDespesas.isSaveButton(actionEl)) {
      if (actionEl.dataset.tmSaveHandling === '1') {
        return;
      }

      var id = InfraDeskDespesas.getExpenseIdFromContext(actionEl) || InfraDeskDespesas.state.currentModalDespesaId;

      if (!id) {
        return;
      }

      var owner = InfraDeskDespesas.getCurrentOwner(id);

      if (!owner || InfraDeskDespesas.isOwnedByOtherUser(id)) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();

        actionEl.dataset.tmSaveHandling = '1';

        InfraDeskDespesas.handleSaveWhenAllowed(actionEl).then(function (allowed) {
          actionEl.dataset.tmSaveHandling = '0';

          if (!allowed) {
            return;
          }

          var form = actionEl.form || actionEl.closest('form');
          InfraDeskDespesas.submitFormAfterLock(form, actionEl);
        }).catch(function (err) {
          actionEl.dataset.tmSaveHandling = '0';
          console.warn('[InfraDeskDespesas] erro no botão gravar', err);
        });
      }
    }
  };

  InfraDeskDespesas.onDocumentSubmitCapture = function (event) {
    var form = event.target;

    if (!form || !form.matches || !form.matches('form')) {
      return;
    }

    if (form.dataset.tmAllowSubmitOnce === '1') {
      form.dataset.tmAllowSubmitOnce = '0';
      return;
    }

    var saveButton = form.querySelector('button[type="submit"], input[type="submit"]');

    if (!saveButton || !InfraDeskDespesas.isSaveButton(saveButton)) {
      return;
    }

    var id = InfraDeskDespesas.getExpenseIdFromContext(form) || InfraDeskDespesas.state.currentModalDespesaId;

    if (!id) {
      return;
    }

    var owner = InfraDeskDespesas.getCurrentOwner(id);

    if (owner && InfraDeskDespesas.isOwnedByOtherUser(id)) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      InfraDeskDespesas.updateModalSaveButtons();
      InfraDeskDespesas.notify('warning', 'Esta despesa está com ' + owner + '.');
    }
  };

  InfraDeskDespesas.observeTable = function () {
    var tbody = document.querySelector('.ibox-content table tbody') || document.querySelector('table tbody');

    if (!tbody) {
      setTimeout(InfraDeskDespesas.observeTable, 700);
      return;
    }

    if (InfraDeskDespesas.state.observer) {
      InfraDeskDespesas.state.observer.disconnect();
    }

    InfraDeskDespesas.state.observer = new MutationObserver(function () {
      if (InfraDeskDespesas.state.ownMutation) {
        return;
      }

      clearTimeout(InfraDeskDespesas.state.debounceTimer);

      InfraDeskDespesas.state.debounceTimer = setTimeout(function () {
        InfraDeskDespesas.injectAllRows();
      }, 250);
    });

    InfraDeskDespesas.state.observer.observe(tbody, {
      childList: true,
      subtree: true
    });
  };

  InfraDeskDespesas.observeBody = function () {
    if (InfraDeskDespesas.state.bodyObserver) {
      InfraDeskDespesas.state.bodyObserver.disconnect();
    }

    InfraDeskDespesas.state.bodyObserver = new MutationObserver(function () {
      if (InfraDeskDespesas.state.ownMutation) {
        return;
      }

      clearTimeout(InfraDeskDespesas.state.debounceTimer);

      InfraDeskDespesas.state.debounceTimer = setTimeout(function () {
        InfraDeskDespesas.refreshLoggedUser();
        InfraDeskDespesas.injectAllRows();
        InfraDeskDespesas.updateFinanceButtons();
        InfraDeskDespesas.updateModalSaveButtons();
      }, 250);
    });

    InfraDeskDespesas.state.bodyObserver.observe(document.body, {
      childList: true,
      subtree: true
    });
  };

  InfraDeskDespesas.forceRefresh = function () {
    InfraDeskDespesas.refreshLoggedUser();
    InfraDeskDespesas.injectAllRows();
    InfraDeskDespesas.loadFirebaseState();
    InfraDeskDespesas.connectRealtime(true);
  };

  InfraDeskDespesas.startupLoop = function () {
    clearInterval(InfraDeskDespesas.state.startupTimer);

    InfraDeskDespesas.state.startupTimer = setInterval(function () {
      InfraDeskDespesas.state.startupCount++;
      InfraDeskDespesas.refreshLoggedUser();
      InfraDeskDespesas.injectAllRows();

      if (InfraDeskDespesas.state.startupCount >= 12) {
        clearInterval(InfraDeskDespesas.state.startupTimer);
      }
    }, 700);
  };

  InfraDeskDespesas.bindEvents = function () {
    document.removeEventListener('click', InfraDeskDespesas.onDocumentClickCapture, true);
    document.addEventListener('click', InfraDeskDespesas.onDocumentClickCapture, true);

    document.removeEventListener('submit', InfraDeskDespesas.onDocumentSubmitCapture, true);
    document.addEventListener('submit', InfraDeskDespesas.onDocumentSubmitCapture, true);
  };

  InfraDeskDespesas.start = function () {
    if (InfraDeskDespesas.state.started) {
      return;
    }

    InfraDeskDespesas.state.started = true;

    InfraDeskDespesas.injectStyle();
    InfraDeskDespesas.refreshLoggedUser();
    InfraDeskDespesas.bindEvents();

    setTimeout(function () {
      InfraDeskDespesas.injectAllRows();
      InfraDeskDespesas.loadFirebaseState();
      InfraDeskDespesas.connectRealtime(false);
      InfraDeskDespesas.observeTable();
      InfraDeskDespesas.observeBody();
      InfraDeskDespesas.startupLoop();
    }, 500);
  };

  window.Sahin = window.Sahin || {};

  if (typeof window.Sahin.injectFunctionsToPage !== 'function') {
    window.Sahin.injectFunctionsToPage = function (obj) {
      var objectName = obj && obj.__name ? obj.__name : ((obj && obj.constructor && obj.constructor.name) || 'Scriptname');

      window[objectName] = window[objectName] || obj;

      var root = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
      root[objectName] = obj;

      var scriptContent = ''
        + 'window.' + objectName + ' = window.' + objectName + ' || {};'
        + '\n';

      for (var key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key) && typeof obj[key] === 'function') {
          scriptContent += 'window.' + objectName + '[' + JSON.stringify(key) + '] = ' + obj[key].toString() + ';\n';
        }
      }

      var script = document.createElement('script');
      script.textContent = scriptContent;
      document.documentElement.appendChild(script);
      script.remove();
    };
  }

  var Sahin = window.Sahin;

  window.InfraDeskDespesas = InfraDeskDespesas;

  if (typeof unsafeWindow !== 'undefined') {
    unsafeWindow.InfraDeskDespesas = InfraDeskDespesas;
  }

  Sahin.injectFunctionsToPage(InfraDeskDespesas);

  InfraDeskDespesas.start();
})();
