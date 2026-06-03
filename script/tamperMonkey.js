// ==UserScript==
// @name         InfraDesk Despesas • Operador direto no Firebase
// @namespace    clncentral/infradesk
// @version      3.4.1
// @description  Injeta seletor pequeno de operador ao lado do número da despesa e grava direto no Firebase em tempo real.
// @author       CLN Central
// @match        https://asp.infradesk.app/backend/despesas*
// @match        https://asp.infradesk.app/backend/despesas/*
// @run-at       document-end
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      infradesk-operadores-default-rtdb.firebaseio.com
// @updateURL    https://clncentral.github.io/leitorxml/script/tamperMonkey.js
// @downloadURL  https://clncentral.github.io/leitorxml/script/tamperMonkey.js
// ==/UserScript==

(function () {
  'use strict';

  var InfraDeskDespesas = {};

  InfraDeskDespesas.FIREBASE_DB_URL = 'https://infradesk-operadores-default-rtdb.firebaseio.com';

  InfraDeskDespesas.OPERADORES = [
    '',
    'Elias Araujo',
    'Camily',
    'Elia Maria',
    'Patricia'
  ];

  InfraDeskDespesas.CORES_FIXAS_POR_OPERADOR = {
    "Elias Araujo": "#0324ff",
    "Camily": "#e6cff2",
    "Elia Maria": "#962bcc",
    "Patricia": "#ff8e03"
  };

  InfraDeskDespesas.COR_SEM_OPERADOR = '#ffffff';

  InfraDeskDespesas.state = {
    started: false,
    ownMutation: false,
    observer: null,
    eventSource: null,
    firebaseCache: {},
    debounceTimer: null,
    startupTimer: null,
    startupCount: 0
  };

  InfraDeskDespesas.clean = function (value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
  };

  InfraDeskDespesas.norm = function (value) {
    return InfraDeskDespesas.clean(value)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  };

  InfraDeskDespesas.firebaseUrl = function (path) {
    const base = InfraDeskDespesas.FIREBASE_DB_URL.replace(/\/+$/, '');
    const cleanPath = String(path || '').replace(/^\/+/, '');
    return base + '/' + cleanPath + '.json';
  };

  InfraDeskDespesas.request = function (opts) {
    return new Promise(function (resolve, reject) {
      GM_xmlhttpRequest({
        method: opts.method || 'GET',
        url: opts.url,
        headers: opts.headers || {},
        data: opts.data || null,
        timeout: opts.timeout || 30000,
        onload: function (res) {
          resolve(res);
        },
        onerror: function (err) {
          reject(err);
        },
        ontimeout: function () {
          reject(new Error('timeout'));
        }
      });
    });
  };

  InfraDeskDespesas.colorForOperator = function (name) {
    name = InfraDeskDespesas.clean(name);

    if (InfraDeskDespesas.CORES_FIXAS_POR_OPERADOR[name]) {
      return InfraDeskDespesas.CORES_FIXAS_POR_OPERADOR[name];
    }

    if (!name) {
      return InfraDeskDespesas.COR_SEM_OPERADOR;
    }

    let h = 0;
    const key = InfraDeskDespesas.norm(name);

    for (let i = 0; i < key.length; i++) {
      h = (h * 31 + key.charCodeAt(i)) | 0;
    }

    return 'hsl(' + (Math.abs(h) % 360) + ' 72% 46%)';
  };

  InfraDeskDespesas.textColorForOperator = function (name) {
    name = InfraDeskDespesas.clean(name);

    if (!name) {
      return '#334155';
    }

    if (name === 'Camily') {
      return '#111827';
    }

    return '#ffffff';
  };

  InfraDeskDespesas.getRowId = function (tr) {
    if (!tr) {
      return '';
    }

    const dataId = InfraDeskDespesas.clean(tr.getAttribute('data-sigma-id'));

    if (dataId) {
      return dataId;
    }

    const firstCell = tr.children && tr.children.length ? tr.children[0] : null;

    if (!firstCell) {
      return '';
    }

    const p = firstCell.querySelector('p');

    if (p) {
      const pText = InfraDeskDespesas.clean(p.innerText || p.textContent || '');
      const pMatch = pText.match(/^\d{3,}$/);

      if (pMatch) {
        return pMatch[0];
      }
    }

    const text = InfraDeskDespesas.clean(firstCell.innerText || firstCell.textContent || '');
    const match = text.match(/\b\d{4,}\b/);

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

    if (String(tr.className || '').includes('expandir-')) {
      return false;
    }

    const cells = Array.from(tr.children || []);

    if (cells.length < 6) {
      return false;
    }

    const id = InfraDeskDespesas.getRowId(tr);

    if (!id) {
      return false;
    }

    const hasButtons = !!tr.querySelector('.td-buttons, a.btn, button.btn');
    const hasValor = cells.some(function (td) {
      return /\bR\$\s*/.test(td.innerText || td.textContent || '');
    });

    return hasButtons || hasValor || tr.hasAttribute('data-sigma-id');
  };

  InfraDeskDespesas.getMainRows = function () {
    const table = document.querySelector('.ibox-content table') || document.querySelector('table');

    if (!table) {
      return [];
    }

    return Array.from(table.querySelectorAll('tbody tr')).filter(function (tr) {
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

  InfraDeskDespesas.getMainCell = function (tr) {
    if (!tr || !tr.children || !tr.children.length) {
      return null;
    }

    return tr.children[0];
  };

  InfraDeskDespesas.getNumberElement = function (tr) {
    const cell = InfraDeskDespesas.getMainCell(tr);

    if (!cell) {
      return null;
    }

    return cell.querySelector('p') || null;
  };

  InfraDeskDespesas.getRowInfo = function (tr) {
    const cells = Array.from(tr.children || []);

    const descricao = cells[1]
      ? InfraDeskDespesas.clean(cells[1].innerText || cells[1].textContent || '')
      : '';

    const documento = cells[2]
      ? InfraDeskDespesas.clean(cells[2].innerText || cells[2].textContent || '')
      : '';

    const fornecedor = cells[3]
      ? InfraDeskDespesas.clean(cells[3].innerText || cells[3].textContent || '')
      : '';

    let emissao = '';
    let vencimento = '';

    if (cells[4]) {
      const dateTexts = Array.from(cells[4].querySelectorAll('b'))
        .map(function (el) {
          return InfraDeskDespesas.clean(el.innerText || el.textContent || '');
        })
        .filter(Boolean);

      emissao = dateTexts[0] || '';
      vencimento = dateTexts[1] || '';
    }

    const valor = cells[5]
      ? InfraDeskDespesas.clean(cells[5].innerText || cells[5].textContent || '')
      : '';

    return {
      descricao,
      documento,
      fornecedor,
      emissao,
      vencimento,
      valor
    };
  };

  InfraDeskDespesas.injectStyle = function () {
    if (document.getElementById('tm-infradesk-operador-style')) {
      return;
    }

    const style = document.createElement('style');
    style.id = 'tm-infradesk-operador-style';
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
        width: 92px !important;
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

      .tm-firebase-panel {
        position: fixed !important;
        right: 14px !important;
        bottom: 14px !important;
        z-index: 999999 !important;
        background: #111827 !important;
        color: #fff !important;
        border-radius: 16px !important;
        padding: 9px 10px !important;
        display: flex !important;
        align-items: center !important;
        gap: 7px !important;
        box-shadow: 0 14px 34px rgba(0,0,0,.25) !important;
        font-family: Arial, sans-serif !important;
        font-size: 12px !important;
        font-weight: 800 !important;
      }

      .tm-firebase-dot {
        width: 9px !important;
        height: 9px !important;
        border-radius: 999px !important;
        background: #f59e0b !important;
      }

      .tm-firebase-dot.on {
        background: #22c55e !important;
        box-shadow: 0 0 0 4px rgba(34,197,94,.16) !important;
      }

      .tm-firebase-dot.off {
        background: #ef4444 !important;
        box-shadow: 0 0 0 4px rgba(239,68,68,.14) !important;
      }

      .tm-firebase-panel button {
        border: 0 !important;
        border-radius: 10px !important;
        padding: 6px 8px !important;
        font-size: 11px !important;
        font-weight: 800 !important;
        cursor: pointer !important;
        background: #2563eb !important;
        color: #fff !important;
      }

      .tm-debug-count {
        color: #cbd5e1 !important;
        font-size: 11px !important;
      }
    `;

    document.head.appendChild(style);
  };

  InfraDeskDespesas.setPanelStatus = function (online, text) {
    const dot = document.querySelector('.tm-firebase-dot');
    const label = document.querySelector('.tm-firebase-label');
    const count = document.querySelector('.tm-debug-count');

    if (dot) {
      dot.classList.remove('on', 'off');
      dot.classList.add(online ? 'on' : 'off');
    }

    if (label) {
      label.textContent = text;
    }

    if (count) {
      count.textContent = InfraDeskDespesas.getMainRows().length + ' linhas';
    }
  };

  InfraDeskDespesas.injectPanel = function () {
    if (document.getElementById('tm-firebase-panel')) {
      return;
    }

    const panel = document.createElement('div');
    panel.id = 'tm-firebase-panel';
    panel.className = 'tm-firebase-panel';

    const dot = document.createElement('span');
    dot.className = 'tm-firebase-dot';

    const label = document.createElement('span');
    label.className = 'tm-firebase-label';
    label.textContent = 'Firebase...';

    const count = document.createElement('span');
    count.className = 'tm-debug-count';
    count.textContent = '0 linhas';

    const reload = document.createElement('button');
    reload.type = 'button';
    reload.textContent = 'Recarregar';
    reload.addEventListener('click', function () {
      InfraDeskDespesas.forceRefresh();
    });

    panel.appendChild(dot);
    panel.appendChild(label);
    panel.appendChild(count);
    panel.appendChild(reload);

    document.body.appendChild(panel);
  };

  InfraDeskDespesas.createSelect = function (tr, id) {
    const select = document.createElement('select');
    select.className = 'tm-op-select';
    select.dataset.sigmaId = id;

    for (const op of InfraDeskDespesas.OPERADORES) {
      const option = document.createElement('option');
      option.value = op;
      option.textContent = op || 'Sem operador';
      select.appendChild(option);
    }

    select.addEventListener('click', function (event) {
      event.stopPropagation();
    });

    select.addEventListener('mousedown', function (event) {
      event.stopPropagation();
    });

    select.addEventListener('change', function () {
      const novoOperador = InfraDeskDespesas.clean(select.value);
      const atual = InfraDeskDespesas.getCurrentOperator(id);

      if (atual && novoOperador && atual !== novoOperador) {
        const ok = window.confirm('Esta despesa está com ' + atual + '.\n\nDeseja assumir para ' + novoOperador + '?');

        if (!ok) {
          InfraDeskDespesas.setSelectValue(tr, atual);
          return;
        }
      }

      if (atual && !novoOperador) {
        const ok = window.confirm('Esta despesa está com ' + atual + '.\n\nDeseja remover o operador?');

        if (!ok) {
          InfraDeskDespesas.setSelectValue(tr, atual);
          return;
        }
      }

      InfraDeskDespesas.saveOperatorFromRow(tr, id, novoOperador);
    });

    return select;
  };

  InfraDeskDespesas.getCurrentOperator = function (id) {
    id = InfraDeskDespesas.clean(id);

    const item = InfraDeskDespesas.state.firebaseCache[id];

    if (!item || typeof item !== 'object') {
      return '';
    }

    return InfraDeskDespesas.clean(item.operador);
  };

  InfraDeskDespesas.ensureInlineSelect = function (tr) {
    const id = InfraDeskDespesas.getRowId(tr);
    const cell = InfraDeskDespesas.getMainCell(tr);

    if (!id || !cell) {
      return null;
    }

    let inline = cell.querySelector('.tm-op-inline');

    if (!inline) {
      inline = document.createElement('span');
      inline.className = 'tm-op-inline';

      const select = InfraDeskDespesas.createSelect(tr, id);
      const status = document.createElement('span');
      status.className = 'tm-op-status';

      inline.appendChild(select);
      inline.appendChild(status);

      const numberEl = InfraDeskDespesas.getNumberElement(tr);

      if (numberEl) {
        numberEl.insertAdjacentElement('afterend', inline);
      } else {
        cell.insertBefore(inline, cell.firstChild);
      }
    }

    return inline;
  };

  InfraDeskDespesas.setStatus = function (tr, text) {
    const status = tr.querySelector('.tm-op-status');

    if (status) {
      status.textContent = text || '';
    }
  };

  InfraDeskDespesas.setSelectValue = function (tr, operador) {
    const select = tr.querySelector('.tm-op-select');

    if (!select) {
      return;
    }

    operador = InfraDeskDespesas.clean(operador);

    const exists = Array.from(select.options).some(function (option) {
      return option.value === operador;
    });

    if (!exists && operador) {
      const option = document.createElement('option');
      option.value = operador;
      option.textContent = operador;
      select.appendChild(option);
    }

    select.value = operador;
    InfraDeskDespesas.styleSelect(select, operador);
  };

  InfraDeskDespesas.styleSelect = function (select, operador) {
    operador = InfraDeskDespesas.clean(operador);

    const color = InfraDeskDespesas.colorForOperator(operador);
    const textColor = InfraDeskDespesas.textColorForOperator(operador);

    select.style.setProperty('background', color, 'important');
    select.style.setProperty('background-color', color, 'important');
    select.style.setProperty('color', textColor, 'important');
    select.style.setProperty('border-color', operador ? color : '#94a3b8', 'important');

    if (operador) {
      select.style.setProperty('box-shadow', '0 0 0 2px ' + color + '33', 'important');
    } else {
      select.style.setProperty('box-shadow', '0 1px 3px rgba(15, 23, 42, .08)', 'important');
    }
  };

  InfraDeskDespesas.paintOperatorOnRow = function (tr, operador) {
    operador = InfraDeskDespesas.clean(operador);

    InfraDeskDespesas.ensureInlineSelect(tr);
    InfraDeskDespesas.setSelectValue(tr, operador);

    const color = InfraDeskDespesas.colorForOperator(operador);
    const firstCell = InfraDeskDespesas.getMainCell(tr);

    if (!operador) {
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

  InfraDeskDespesas.updateRowUI = function (id, operador) {
    const rows = InfraDeskDespesas.findRowsById(id);

    for (const tr of rows) {
      InfraDeskDespesas.paintOperatorOnRow(tr, operador);
    }
  };

  InfraDeskDespesas.applyFirebaseItem = function (id, item) {
    id = InfraDeskDespesas.clean(id);

    if (!id) {
      return;
    }

    item = item && typeof item === 'object' ? item : {};

    const operador = InfraDeskDespesas.clean(item.operador);

    InfraDeskDespesas.state.firebaseCache[id] = item;
    InfraDeskDespesas.updateRowUI(id, operador);
  };

  InfraDeskDespesas.removeFirebaseItem = function (id) {
    id = InfraDeskDespesas.clean(id);

    if (!id) {
      return;
    }

    delete InfraDeskDespesas.state.firebaseCache[id];
    InfraDeskDespesas.updateRowUI(id, '');
  };

  InfraDeskDespesas.injectRow = function (tr) {
    const id = InfraDeskDespesas.getRowId(tr);

    if (!id) {
      return;
    }

    InfraDeskDespesas.ensureInlineSelect(tr);

    const cached = InfraDeskDespesas.state.firebaseCache[id];

    if (cached) {
      InfraDeskDespesas.paintOperatorOnRow(tr, InfraDeskDespesas.clean(cached.operador));
    } else {
      InfraDeskDespesas.paintOperatorOnRow(tr, '');
    }
  };

  InfraDeskDespesas.injectAllRows = function () {
    const rows = InfraDeskDespesas.getMainRows();

    InfraDeskDespesas.state.ownMutation = true;

    try {
      for (const tr of rows) {
        InfraDeskDespesas.injectRow(tr);
      }
    } finally {
      setTimeout(function () {
        InfraDeskDespesas.state.ownMutation = false;
        InfraDeskDespesas.setPanelStatus(true, 'Firebase conectado');
      }, 0);
    }
  };

  InfraDeskDespesas.saveOperatorFromRow = async function (tr, id, operador) {
    id = InfraDeskDespesas.clean(id);
    operador = InfraDeskDespesas.clean(operador);

    if (!id) {
      return;
    }

    const select = tr.querySelector('.tm-op-select');

    if (select) {
      select.classList.add('tm-op-saving');
    }

    InfraDeskDespesas.setStatus(tr, '...');

    const rowInfo = InfraDeskDespesas.getRowInfo(tr);

    const payload = {
      id: id,
      operador: operador,
      descricao: rowInfo.descricao,
      documento: rowInfo.documento,
      fornecedor: rowInfo.fornecedor,
      emissao: rowInfo.emissao,
      vencimento: rowInfo.vencimento,
      valor: rowInfo.valor,
      source: 'tampermonkey',
      ts: Date.now()
    };

    InfraDeskDespesas.state.firebaseCache[id] = payload;
    InfraDeskDespesas.updateRowUI(id, operador);

    try {
      await InfraDeskDespesas.request({
        method: 'PUT',
        url: InfraDeskDespesas.firebaseUrl('despesas_updates/by_id/' + encodeURIComponent(id)),
        headers: {
          'Content-Type': 'application/json'
        },
        data: JSON.stringify(payload)
      });

      InfraDeskDespesas.setStatus(tr, '✓');

      setTimeout(function () {
        InfraDeskDespesas.setStatus(tr, '');
      }, 1200);
    } catch (err) {
      InfraDeskDespesas.setStatus(tr, '!');
      console.warn('[InfraDeskDespesas] erro ao salvar no Firebase', err);
    } finally {
      if (select) {
        select.classList.remove('tm-op-saving');
      }
    }
  };

  InfraDeskDespesas.loadFirebaseState = async function () {
    try {
      const res = await InfraDeskDespesas.request({
        method: 'GET',
        url: InfraDeskDespesas.firebaseUrl('despesas_updates/by_id') + '?_=' + Date.now()
      });

      const data = JSON.parse(res.responseText || '{}') || {};

      InfraDeskDespesas.state.firebaseCache = data;

      for (const [id, item] of Object.entries(data)) {
        InfraDeskDespesas.applyFirebaseItem(id, item);
      }

      InfraDeskDespesas.injectAllRows();
      InfraDeskDespesas.setPanelStatus(true, 'Firebase conectado');
    } catch (err) {
      InfraDeskDespesas.setPanelStatus(false, 'Erro Firebase');
      console.warn('[InfraDeskDespesas] erro ao carregar Firebase', err);
    }
  };

  InfraDeskDespesas.firebaseStreamUrl = function () {
    return InfraDeskDespesas.FIREBASE_DB_URL.replace(/\/+$/, '') + '/despesas_updates/by_id.json';
  };

  InfraDeskDespesas.handleFirebaseEvent = function (raw) {
    let parsed;

    try {
      parsed = JSON.parse(raw || '{}');
    } catch (_) {
      return;
    }

    const path = String(parsed.path || '');
    const data = parsed.data;

    if (path === '/' || path === '') {
      if (data === null) {
        InfraDeskDespesas.state.firebaseCache = {};
        InfraDeskDespesas.injectAllRows();
        return;
      }

      if (data && typeof data === 'object') {
        InfraDeskDespesas.state.firebaseCache = data;

        for (const [id, item] of Object.entries(data)) {
          InfraDeskDespesas.applyFirebaseItem(id, item);
        }

        InfraDeskDespesas.injectAllRows();
      }

      return;
    }

    const cleanPath = path.replace(/^\/+/, '');
    const parts = cleanPath.split('/').filter(Boolean);

    if (!parts.length) {
      return;
    }

    const id = InfraDeskDespesas.clean(parts[0]);

    if (!id) {
      return;
    }

    if (data === null) {
      InfraDeskDespesas.removeFirebaseItem(id);
      return;
    }

    if (parts.length === 1) {
      InfraDeskDespesas.applyFirebaseItem(id, data);
      return;
    }

    const current = InfraDeskDespesas.state.firebaseCache[id] || {};
    current[parts[1]] = data;
    InfraDeskDespesas.applyFirebaseItem(id, current);
  };

  InfraDeskDespesas.connectRealtime = function (manual) {
    try {
      if (InfraDeskDespesas.state.eventSource) {
        InfraDeskDespesas.state.eventSource.close();
        InfraDeskDespesas.state.eventSource = null;
      }

      const es = new EventSource(InfraDeskDespesas.firebaseStreamUrl());

      es.addEventListener('open', function () {
        InfraDeskDespesas.setPanelStatus(true, 'Firebase conectado');
      });

      es.addEventListener('put', function (event) {
        InfraDeskDespesas.handleFirebaseEvent(event.data);
      });

      es.addEventListener('patch', function (event) {
        InfraDeskDespesas.handleFirebaseEvent(event.data);
      });

      es.onerror = function () {
        InfraDeskDespesas.setPanelStatus(false, 'Reconectando...');
      };

      InfraDeskDespesas.state.eventSource = es;

      if (manual) {
        InfraDeskDespesas.loadFirebaseState();
      }
    } catch (err) {
      InfraDeskDespesas.setPanelStatus(false, 'Erro realtime');
      console.warn('[InfraDeskDespesas] erro EventSource Firebase', err);
    }
  };

  InfraDeskDespesas.observe = function () {
    const tbody = document.querySelector('.ibox-content table tbody') || document.querySelector('table tbody');

    if (!tbody) {
      setTimeout(InfraDeskDespesas.observe, 700);
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
      subtree: false
    });
  };

  InfraDeskDespesas.forceRefresh = function () {
    InfraDeskDespesas.injectAllRows();
    InfraDeskDespesas.loadFirebaseState();
    InfraDeskDespesas.connectRealtime(true);
  };

  InfraDeskDespesas.startupLoop = function () {
    clearInterval(InfraDeskDespesas.state.startupTimer);

    InfraDeskDespesas.state.startupTimer = setInterval(function () {
      InfraDeskDespesas.state.startupCount++;
      InfraDeskDespesas.injectAllRows();
      InfraDeskDespesas.setPanelStatus(true, 'Firebase conectado');

      if (InfraDeskDespesas.state.startupCount >= 12) {
        clearInterval(InfraDeskDespesas.state.startupTimer);
      }
    }, 700);
  };

  InfraDeskDespesas.start = function () {
    if (InfraDeskDespesas.state.started) {
      return;
    }

    InfraDeskDespesas.state.started = true;

    InfraDeskDespesas.injectStyle();
    InfraDeskDespesas.injectPanel();

    setTimeout(function () {
      InfraDeskDespesas.injectAllRows();
      InfraDeskDespesas.loadFirebaseState();
      InfraDeskDespesas.connectRealtime(false);
      InfraDeskDespesas.observe();
      InfraDeskDespesas.startupLoop();
    }, 500);
  };

  if (window.Sahin && typeof window.Sahin.injectFunctionsToPage === 'function') {
    window.Sahin.injectFunctionsToPage(InfraDeskDespesas);
  } else if (typeof unsafeWindow !== 'undefined') {
    unsafeWindow.InfraDeskDespesas = InfraDeskDespesas;
  } else {
    window.InfraDeskDespesas = InfraDeskDespesas;
  }

  InfraDeskDespesas.start();
})();
