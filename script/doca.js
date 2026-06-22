// ==UserScript==
// @name         InfraDesk Doca • Captura + Status Real + Firebase + Ordem Lojas
// @namespace    clncentral/infradesk-doca
// @version      1.3.0
// @description  Captura chamados da doca, valida reserva no Firebase, muda status real para Em liberação, registra dados limpos e organiza Aberto/Em liberação por lojas prioritárias.
// @author       CLN Central
// @match        https://asp.infradesk.app/backend/chamados*
// @match        https://asp.infradesk.app/backend/chamados/*
// @run-at       document-end
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @grant        unsafeWindow
// @connect      infra-doca-default-rtdb.firebaseio.com
// @connect      *.firebasedatabase.app
// @connect      firebasedatabase.app
// @connect      asp.infradesk.app
// @updateURL    https://clncentral.github.io/leitorxml/script/doca.js
// @downloadURL  https://clncentral.github.io/leitorxml/script/doca.js
// ==/UserScript==

(function () {
  'use strict';

  var InfraDeskDoca = {};

  InfraDeskDoca.__name = 'InfraDeskDoca';

  // Se sua URL do Realtime Database for diferente, troque aqui.
  InfraDeskDoca.FIREBASE_DB_URL = 'https://infra-doca-default-rtdb.firebaseio.com';

  InfraDeskDoca.FIREBASE_ROOT = 'doca_capturas';

  InfraDeskDoca.STATUS_ABERTO = '2';
  InfraDeskDoca.STATUS_EM_LIBERACAO = '3';
  InfraDeskDoca.STATUS_EM_LIBERACAO_NOME = 'Em liberação';

  // Ordem visual dos chamados dentro das colunas Aberto e Em liberação.
  // Não muda status, não salva nada no sistema; apenas reorganiza os cards carregados na tela.
  InfraDeskDoca.ORDEM_STATUS_IDS = ['2', '3'];
  InfraDeskDoca.ORDEM_EMPRESAS_PRIORIDADE = [
    'Loja 01 - ASP São Marcos',
    'Loja 03 - ASP Paraíso',
    'Loja 05 - ASP Vinhedo'
  ];

  InfraDeskDoca.state = {
    started: false,
    observer: null,
    eventSource: null,
    debounceTimer: null,
    orderTimer: null,
    orderRunning: false,
    firebaseCache: {},
    savingIds: {},
    movingIds: {},
    clickingIds: {},
    user: {
      nome: '',
      id: ''
    }
  };

  InfraDeskDoca.clean = function (value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  };

  InfraDeskDoca.cleanFieldValue = function (value) {
    value = InfraDeskDoca.clean(value);

    if (!value) {
      return '';
    }

    value = value.replace(/^[;,\.\-\s]+|[;,\.\-\s]+$/g, '').trim();

    if (!value || value === ';' || value === '-' || value === '.') {
      return '';
    }

    return value;
  };

  InfraDeskDoca.norm = function (value) {
    return InfraDeskDoca.clean(value)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  };

  InfraDeskDoca.onlyDigits = function (value) {
    return String(value == null ? '' : value).replace(/\D+/g, '');
  };

  InfraDeskDoca.keyUser = function (value) {
    return InfraDeskDoca.norm(value)
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'sem_usuario';
  };

  InfraDeskDoca.formatCnpj = function (cnpj) {
    cnpj = InfraDeskDoca.onlyDigits(cnpj);

    if (cnpj.length !== 14) {
      return cnpj;
    }

    return cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  };

  InfraDeskDoca.firebaseUrl = function (path) {
    var base = InfraDeskDoca.FIREBASE_DB_URL.replace(/\/+$/, '');
    var cleanPath = String(path || '').replace(/^\/+/, '');
    return base + '/' + cleanPath + '.json';
  };

  InfraDeskDoca.isOkResponse = function (res) {
    return res && res.status >= 200 && res.status < 300;
  };

  InfraDeskDoca.parseJson = function (text, fallback) {
    try {
      return JSON.parse(text || '');
    } catch (_) {
      return fallback;
    }
  };

  InfraDeskDoca.deleteEmptyDeep = function (value) {
    if (Array.isArray(value)) {
      var arr = [];

      for (var i = 0; i < value.length; i++) {
        var cleanedItem = InfraDeskDoca.deleteEmptyDeep(value[i]);

        if (cleanedItem !== undefined) {
          arr.push(cleanedItem);
        }
      }

      return arr.length ? arr : undefined;
    }

    if (value && typeof value === 'object') {
      var obj = {};

      Object.keys(value).forEach(function (key) {
        var cleanedValue = InfraDeskDoca.deleteEmptyDeep(value[key]);

        if (cleanedValue !== undefined) {
          obj[key] = cleanedValue;
        }
      });

      return Object.keys(obj).length ? obj : undefined;
    }

    if (typeof value === 'string') {
      var cleanedString = InfraDeskDoca.cleanFieldValue(value);

      if (!cleanedString) {
        return undefined;
      }

      return cleanedString;
    }

    if (value === null || value === undefined) {
      return undefined;
    }

    return value;
  };

  InfraDeskDoca.requestFirebase = function (opts) {
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

  InfraDeskDoca.sameOriginPost = function (url, data) {
    data = data || {};

    return new Promise(function (resolve, reject) {
      var root = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
      var jq = root.jQuery || root.$ || window.jQuery || window.$;

      if (jq && typeof jq.ajax === 'function') {
        jq.ajax({
          url: url,
          type: 'POST',
          data: data,
          dataType: 'json',
          success: function (response, textStatus, xhr) {
            resolve({
              ok: true,
              status: xhr ? xhr.status : 200,
              json: response,
              text: JSON.stringify(response || {})
            });
          },
          error: function (xhr) {
            resolve({
              ok: false,
              status: xhr ? xhr.status : 0,
              json: null,
              text: xhr ? xhr.responseText || '' : ''
            });
          }
        });

        return;
      }

      var body = Object.keys(data).map(function (key) {
        return encodeURIComponent(key) + '=' + encodeURIComponent(data[key]);
      }).join('&');

      fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest'
        },
        body: body,
        credentials: 'include',
        cache: 'no-store'
      }).then(function (res) {
        return res.text().then(function (text) {
          resolve({
            ok: res.ok,
            status: res.status,
            json: InfraDeskDoca.parseJson(text, null),
            text: text
          });
        });
      }).catch(reject);
    });
  };

  InfraDeskDoca.notify = function (type, message) {
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

  InfraDeskDoca.getTextWithoutChildren = function (el) {
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

    return InfraDeskDoca.clean(text || el.textContent || '');
  };

  InfraDeskDoca.detectLoggedUserName = function () {
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
        var txt = InfraDeskDoca.getTextWithoutChildren(el);
        txt = txt.replace(/\s*\bSair\b\s*$/i, '');
        txt = txt.replace(/\s*\bMeus dados\b\s*$/i, '');
        txt = InfraDeskDoca.clean(txt);

        if (txt && !/central|libera/i.test(txt) && txt.length >= 3) {
          return txt;
        }
      }
    }

    var strong = document.querySelector('.nav-header strong');

    if (strong) {
      return InfraDeskDoca.clean(strong.textContent || '');
    }

    return '';
  };

  InfraDeskDoca.detectLoggedUserId = function () {
    var html = document.documentElement ? document.documentElement.innerHTML : '';

    var patterns = [
      /avatar_usuario_(\d+)/i,
      /atendente_id=(\d+)/i,
      /\/avatar\/(\d+)\//i
    ];

    for (var i = 0; i < patterns.length; i++) {
      var match = html.match(patterns[i]);

      if (match && match[1]) {
        return InfraDeskDoca.clean(match[1]);
      }
    }

    return '';
  };

  InfraDeskDoca.refreshLoggedUser = function () {
    var nome = InfraDeskDoca.detectLoggedUserName();
    var id = InfraDeskDoca.detectLoggedUserId();

    if (nome) {
      InfraDeskDoca.state.user.nome = nome;
    }

    if (id) {
      InfraDeskDoca.state.user.id = id;
    }

    return InfraDeskDoca.state.user;
  };

  InfraDeskDoca.textOf = function (root, selector) {
    var el = root && root.querySelector ? root.querySelector(selector) : null;
    return el ? InfraDeskDoca.clean(el.innerText || el.textContent || '') : '';
  };

  InfraDeskDoca.attrOf = function (root, selector, attr) {
    var el = root && root.querySelector ? root.querySelector(selector) : null;
    return el ? InfraDeskDoca.clean(el.getAttribute(attr) || '') : '';
  };

  InfraDeskDoca.parseBrazilDateTime = function (value) {
    value = InfraDeskDoca.clean(value);

    var match = value.match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?/);

    if (!match) {
      return '';
    }

    return match[3] + '-' + match[2] + '-' + match[1] + 'T' + match[4] + ':' + match[5] + ':' + (match[6] || '00');
  };

  InfraDeskDoca.parseLoja = function (value) {
    value = InfraDeskDoca.clean(value);

    var out = {
      lojaTexto: value,
      lojaCodigo: '',
      lojaNome: ''
    };

    var match = value.match(/Loja\s+(\d+)\s*-\s*(.+)$/i);

    if (match) {
      out.lojaCodigo = match[1];
      out.lojaNome = InfraDeskDoca.clean(match[2]);
    }

    return out;
  };

  InfraDeskDoca.parseFornecedor = function (value, href) {
    value = InfraDeskDoca.clean(value).replace(/^#+/, '#');
    href = InfraDeskDoca.clean(href);

    var out = {
      fornecedorTexto: value,
      fornecedorId: '',
      fornecedorNome: ''
    };

    var hrefMatch = href.match(/\/fornecedores\/contato\/(\d+)/i);

    if (hrefMatch && hrefMatch[1]) {
      out.fornecedorId = hrefMatch[1];
    }

    var textMatch = value.match(/#?(\d+)\s+(.+)$/);

    if (textMatch) {
      if (!out.fornecedorId) {
        out.fornecedorId = textMatch[1];
      }

      out.fornecedorNome = InfraDeskDoca.clean(textMatch[2]);
    } else {
      out.fornecedorNome = value.replace(/^#\d+\s*/, '');
    }

    return out;
  };

  InfraDeskDoca.parseAccessKey = function (chave) {
    chave = InfraDeskDoca.onlyDigits(chave);

    if (chave.length !== 44) {
      return {};
    }

    var ano2 = chave.slice(2, 4);
    var mes = chave.slice(4, 6);
    var cnpj = chave.slice(6, 20);
    var numero = chave.slice(25, 34);

    return {
      chaveAcesso: chave,
      chaveValidaTamanho: true,
      ufCodigo: chave.slice(0, 2),
      anoMes: chave.slice(2, 6),
      ano: '20' + ano2,
      mes: mes,
      cnpjEmitente: cnpj,
      cnpjEmitenteFormatado: InfraDeskDoca.formatCnpj(cnpj),
      modelo: chave.slice(20, 22),
      serie: chave.slice(22, 25),
      numero: numero,
      numeroLimpo: String(Number(numero) || ''),
      tipoEmissao: chave.slice(34, 35),
      codigoNumerico: chave.slice(35, 43),
      dv: chave.slice(43, 44)
    };
  };

  InfraDeskDoca.tagKey = function (label) {
    return InfraDeskDoca.norm(label)
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
  };

  InfraDeskDoca.getCardId = function (card) {
    if (!card) {
      return '';
    }

    var dataId = InfraDeskDoca.clean(card.getAttribute('data-chamado-id'));

    if (dataId) {
      return dataId;
    }

    var link = card.querySelector('a[href*="/backend/chamados/detalhes/"]');

    if (link) {
      var match = String(link.getAttribute('href') || '').match(/\/backend\/chamados\/detalhes\/(\d+)/i);

      if (match && match[1]) {
        return InfraDeskDoca.clean(match[1]);
      }
    }

    var text = InfraDeskDoca.clean(card.innerText || card.textContent || '');
    var textMatch = text.match(/\b\d{4,}\b/);

    return textMatch ? textMatch[0] : '';
  };

  InfraDeskDoca.getCards = function () {
    return Array.prototype.slice.call(document.querySelectorAll('.chamado-item[data-chamado-id], li.chamado-item'));
  };

  InfraDeskDoca.findCardById = function (id) {
    id = InfraDeskDoca.clean(id);

    if (!id) {
      return null;
    }

    return document.querySelector('.chamado-item[data-chamado-id="' + id + '"]');
  };

  InfraDeskDoca.getStatusUl = function (statusId) {
    return document.querySelector('ul.list-status-chamados[data-status-id="' + statusId + '"]');
  };

  InfraDeskDoca.getCardStatusId = function (card) {
    var ul = card && card.closest ? card.closest('ul.list-status-chamados[data-status-id]') : null;
    return ul ? InfraDeskDoca.clean(ul.getAttribute('data-status-id')) : '';
  };

  InfraDeskDoca.getCardStatusName = function (card) {
    var ul = card && card.closest ? card.closest('ul.list-status-chamados[data-status-descricao]') : null;
    return ul ? InfraDeskDoca.clean(ul.getAttribute('data-status-descricao')) : '';
  };

  InfraDeskDoca.getOrderPriorityNorms = function () {
    if (!InfraDeskDoca._orderPriorityNorms) {
      InfraDeskDoca._orderPriorityNorms = InfraDeskDoca.ORDEM_EMPRESAS_PRIORIDADE.map(function (empresa) {
        return InfraDeskDoca.norm(empresa);
      });
    }

    return InfraDeskDoca._orderPriorityNorms;
  };

  InfraDeskDoca.isOrderTargetList = function (ul) {
    if (!ul) {
      return false;
    }

    var statusId = InfraDeskDoca.clean(ul.getAttribute('data-status-id') || '');

    if (InfraDeskDoca.ORDEM_STATUS_IDS.indexOf(statusId) >= 0) {
      return true;
    }

    var desc = InfraDeskDoca.norm(ul.getAttribute('data-status-descricao') || '');

    if (desc.indexOf('aberto') >= 0 || desc.indexOf('em liberacao') >= 0) {
      return true;
    }

    var wrap = ul.closest ? ul.closest('.wrap-status') : null;
    var h3 = wrap ? wrap.querySelector('h3[data-status-id], h3') : null;
    var title = InfraDeskDoca.norm(h3 ? h3.textContent || h3.innerText || '' : '');

    return title.indexOf('aberto') >= 0 || title.indexOf('em liberacao') >= 0;
  };

  InfraDeskDoca.getOrderTargetLists = function () {
    var lists = Array.prototype.slice.call(document.querySelectorAll('ul.list-status-chamados[data-status-id]'));

    return lists.filter(function (ul) {
      return InfraDeskDoca.isOrderTargetList(ul);
    });
  };

  InfraDeskDoca.getCardEmpresaTexto = function (card) {
    return InfraDeskDoca.textOf(card, '.item-data-empresa');
  };

  InfraDeskDoca.getCardEmpresaNorm = function (card) {
    return InfraDeskDoca.norm(InfraDeskDoca.getCardEmpresaTexto(card));
  };

  InfraDeskDoca.getCardOrderPriority = function (card) {
    var empresa = InfraDeskDoca.getCardEmpresaNorm(card);
    var prioridades = InfraDeskDoca.getOrderPriorityNorms();

    for (var i = 0; i < prioridades.length; i++) {
      if (empresa.indexOf(prioridades[i]) >= 0) {
        return i;
      }
    }

    return 999;
  };

  InfraDeskDoca.getCardLojaNumero = function (card) {
    var empresa = InfraDeskDoca.getCardEmpresaNorm(card);
    var match = empresa.match(/loja\s+0?(\d+)/i);

    return match && match[1] ? Number(match[1]) : 9999;
  };

  InfraDeskDoca.getCardAberturaMs = function (card) {
    var aberturaTexto = InfraDeskDoca.textOf(card, '.item-data-abertura');
    var match = aberturaTexto.match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?/);

    if (!match) {
      return 0;
    }

    return new Date(
      Number(match[3]),
      Number(match[2]) - 1,
      Number(match[1]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6] || 0)
    ).getTime();
  };

  InfraDeskDoca.compareCardsByStorePriority = function (a, b) {
    var priorityA = InfraDeskDoca.getCardOrderPriority(a);
    var priorityB = InfraDeskDoca.getCardOrderPriority(b);

    if (priorityA !== priorityB) {
      return priorityA - priorityB;
    }

    var lojaA = InfraDeskDoca.getCardLojaNumero(a);
    var lojaB = InfraDeskDoca.getCardLojaNumero(b);

    if (lojaA !== lojaB) {
      return lojaA - lojaB;
    }

    var empresaA = InfraDeskDoca.getCardEmpresaNorm(a);
    var empresaB = InfraDeskDoca.getCardEmpresaNorm(b);

    if (empresaA !== empresaB) {
      return empresaA.localeCompare(empresaB, 'pt-BR', {
        numeric: true
      });
    }

    // Dentro da mesma loja, deixa os chamados mais novos primeiro.
    return InfraDeskDoca.getCardAberturaMs(b) - InfraDeskDoca.getCardAberturaMs(a);
  };

  InfraDeskDoca.orderListByStorePriority = function (ul) {
    if (!ul) {
      return false;
    }

    var cards = Array.prototype.slice.call(ul.children).filter(function (el) {
      return el && el.matches && el.matches('li.chamado-item, .chamado-item[data-chamado-id]');
    });

    if (cards.length <= 1) {
      return false;
    }

    var oldOrder = cards.map(function (card) {
      return InfraDeskDoca.getCardId(card);
    }).join('|');

    var sorted = cards.slice().sort(InfraDeskDoca.compareCardsByStorePriority);

    var newOrder = sorted.map(function (card) {
      return InfraDeskDoca.getCardId(card);
    }).join('|');

    if (oldOrder === newOrder) {
      return false;
    }

    var frag = document.createDocumentFragment();

    sorted.forEach(function (card) {
      frag.appendChild(card);
    });

    ul.appendChild(frag);

    try {
      var root = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
      var jq = root.jQuery || root.$ || window.jQuery || window.$;

      if (jq && jq.fn && jq.fn.sortable) {
        jq(ul).sortable('refresh');
      }
    } catch (_) {}

    return true;
  };

  InfraDeskDoca.orderPriorityTabs = function () {
    if (InfraDeskDoca.state.orderRunning) {
      return;
    }

    InfraDeskDoca.state.orderRunning = true;

    try {
      var lists = InfraDeskDoca.getOrderTargetLists();
      var changed = false;

      lists.forEach(function (ul) {
        if (InfraDeskDoca.orderListByStorePriority(ul)) {
          changed = true;
        }
      });

      if (changed) {
        InfraDeskDoca.updateKanbanCounters();
      }
    } catch (err) {
      console.warn('[InfraDeskDoca] erro ao ordenar chamados por loja', err);
    } finally {
      setTimeout(function () {
        InfraDeskDoca.state.orderRunning = false;
      }, 100);
    }
  };

  InfraDeskDoca.scheduleOrderPriorityTabs = function (delay) {
    clearTimeout(InfraDeskDoca.state.orderTimer);

    InfraDeskDoca.state.orderTimer = setTimeout(function () {
      InfraDeskDoca.orderPriorityTabs();
    }, typeof delay === 'number' ? delay : 250);
  };

  InfraDeskDoca.extractTagsFromCard = function (card) {
    var tags = {};
    var tagsLista = [];

    if (!card) {
      return {
        tags: tags,
        tagsLista: tagsLista
      };
    }

    var items = Array.prototype.slice.call(card.querySelectorAll('.chamado-tag-item'));

    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var labelEl = item.querySelector('b');
      var valueEl = item.querySelector('span');

      var label = InfraDeskDoca.clean(labelEl ? labelEl.textContent || labelEl.innerText || '' : '');
      var value = InfraDeskDoca.cleanFieldValue(valueEl ? valueEl.textContent || valueEl.innerText || '' : '');

      label = label
        .replace(/^['"`]+/, '')
        .replace(/[:：]\s*$/, '')
        .trim();

      if (!label) {
        continue;
      }

      var key = InfraDeskDoca.tagKey(label);

      if (!key) {
        continue;
      }

      if (value) {
        tags[key] = value;

        tagsLista.push({
          label: label,
          key: key,
          valor: value
        });
      }
    }

    return {
      tags: tags,
      tagsLista: tagsLista
    };
  };

  InfraDeskDoca.extractNfFromCard = function (card, tagsInfo) {
    tagsInfo = tagsInfo || InfraDeskDoca.extractTagsFromCard(card);

    var textoCard = InfraDeskDoca.clean(card ? card.innerText || card.textContent || '' : '');
    var chave = '';

    var chaveTag = tagsInfo.tags.chave_da_nf || tagsInfo.tags.chave_nf || tagsInfo.tags.chave_nfe || '';

    if (chaveTag) {
      var chaveMatchTag = chaveTag.match(/\b(\d{44})\b/);

      if (chaveMatchTag) {
        chave = chaveMatchTag[1];
      }
    }

    if (!chave) {
      var chaveMatchCard = textoCard.match(/\b(\d{44})\b/);

      if (chaveMatchCard) {
        chave = chaveMatchCard[1];
      }
    }

    var numeroRaw = '';

    if (chaveTag) {
      var numeroAntesChave = chaveTag.match(/^\s*([\d.\-\/]+)\s*\(/);

      if (numeroAntesChave) {
        numeroRaw = numeroAntesChave[1];
      }
    }

    if (!numeroRaw) {
      var ultimaDescricaoEl = card ? card.querySelector('.item-ultima-descricao-copy') : null;
      var ultimaDescricao = ultimaDescricaoEl ? InfraDeskDoca.cleanFieldValue(ultimaDescricaoEl.textContent || ultimaDescricaoEl.innerText || '') : '';
      var nfMatch = ultimaDescricao.match(/\bNF\s+([\d.\-\/]+)/i);

      if (nfMatch) {
        numeroRaw = nfMatch[1];
      }
    }

    if (!numeroRaw) {
      var mensagem = InfraDeskDoca.textOf(card, '.message-collapsed');
      var msgMatch = mensagem.match(/\bNF\s+([\d.\-\/]+)/i);

      if (msgMatch) {
        numeroRaw = msgMatch[1];
      }
    }

    var parsed = InfraDeskDoca.parseAccessKey(chave);
    var numeroLimpo = InfraDeskDoca.onlyDigits(numeroRaw);

    if (!numeroLimpo && parsed.numeroLimpo) {
      numeroLimpo = parsed.numeroLimpo;
    }

    var out = {
      nfNumeroTexto: numeroRaw || parsed.numero || '',
      nfNumero: numeroLimpo,
      chaveAcesso: parsed.chaveAcesso || ''
    };

    if (parsed && Object.keys(parsed).length) {
      out.nfe = parsed;
      out.cnpjEmitente = parsed.cnpjEmitente || '';
      out.cnpjEmitenteFormatado = parsed.cnpjEmitenteFormatado || '';
      out.modeloNf = parsed.modelo || '';
      out.serieNf = parsed.serie || '';
      out.numeroNfChave = parsed.numero || '';
      out.numeroNfChaveLimpo = parsed.numeroLimpo || '';
      out.ufCodigoNf = parsed.ufCodigo || '';
      out.anoNf = parsed.ano || '';
      out.mesNf = parsed.mes || '';
    }

    return out;
  };

  InfraDeskDoca.extractSolicitanteFromCard = function (card) {
    var title = InfraDeskDoca.clean(card ? card.getAttribute('title') || '' : '');
    var tooltip = InfraDeskDoca.attrOf(card, '.avatar-user-card .img-circle', 'data-original-title');

    var out = {
      solicitanteTexto: title,
      solicitanteNome: '',
      solicitanteLojaTexto: '',
      solicitanteEmail: '',
      solicitanteAvatarId: ''
    };

    var emailMatch = (title + ' ' + tooltip).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);

    if (emailMatch) {
      out.solicitanteEmail = emailMatch[0];
    }

    var avatarMatch = String(card ? card.innerHTML || '' : '').match(/avatar_usuario_(\d+)/i);

    if (avatarMatch && avatarMatch[1]) {
      out.solicitanteAvatarId = avatarMatch[1];
    }

    var nomeMatch = tooltip.match(/<h6>(.*?)<\/h6>/i);

    if (nomeMatch && nomeMatch[1]) {
      out.solicitanteNome = InfraDeskDoca.clean(nomeMatch[1].replace(/<[^>]+>/g, ''));
    }

    var lojaTooltipMatch = tooltip.match(/<p>(.*?)<\/p>/i);

    if (lojaTooltipMatch && lojaTooltipMatch[1]) {
      out.solicitanteLojaTexto = InfraDeskDoca.clean(lojaTooltipMatch[1].replace(/<[^>]+>/g, ''));
    }

    return out;
  };

  InfraDeskDoca.extractCardInfo = function (card) {
    if (!card) {
      return {};
    }

    var chamadoId = InfraDeskDoca.getCardId(card);
    var tagsInfo = InfraDeskDoca.extractTagsFromCard(card);
    var nfInfo = InfraDeskDoca.extractNfFromCard(card, tagsInfo);

    var aberturaTexto = InfraDeskDoca.textOf(card, '.item-data-abertura');
    var lojaTexto = InfraDeskDoca.textOf(card, '.item-data-empresa');

    var fornecedorTexto = InfraDeskDoca.textOf(card, '.item-data-fornecedor');
    var fornecedorHref = InfraDeskDoca.attrOf(card, '.item-data-fornecedor', 'href');

    var categoria = InfraDeskDoca.textOf(card, 'a[href*="/backend/chamados/detalhes/"] .item-categoria');
    var subcategoria = InfraDeskDoca.textOf(card, '.item-subcategoria');

    var descricaoResumo = '';
    var ultimaDescricaoEl = card.querySelector('.item-ultima-descricao-copy');

    if (ultimaDescricaoEl) {
      descricaoResumo = InfraDeskDoca.cleanFieldValue(ultimaDescricaoEl.textContent || ultimaDescricaoEl.innerText || '');
    }

    if (!descricaoResumo) {
      descricaoResumo = InfraDeskDoca.cleanFieldValue(InfraDeskDoca.textOf(card, '.message-collapsed'));
    }

    var loja = InfraDeskDoca.parseLoja(lojaTexto);
    var fornecedor = InfraDeskDoca.parseFornecedor(fornecedorTexto, fornecedorHref);
    var solicitante = InfraDeskDoca.extractSolicitanteFromCard(card);

    var info = {};

    Object.assign(info, loja);
    Object.assign(info, fornecedor);
    Object.assign(info, solicitante);
    Object.assign(info, nfInfo);

    info.chamadoId = chamadoId;

    info.categoriaId = InfraDeskDoca.clean(card.getAttribute('data-categoria-id') || '');
    info.categoria = categoria;
    info.subcategoria = subcategoria;

    info.statusAntesId = InfraDeskDoca.getCardStatusId(card);
    info.statusAntesNome = InfraDeskDoca.getCardStatusName(card);

    info.origemAtendimento = InfraDeskDoca.clean(card.getAttribute('data-origem-atendimento') || '');
    info.transferenciaGrupoId = InfraDeskDoca.clean(card.getAttribute('data-transferencia-grupo-id') || '');
    info.fornecedorTags = InfraDeskDoca.clean(card.getAttribute('data-fornecedor-tags') || '');

    info.aberturaTexto = aberturaTexto;
    info.aberturaISO = InfraDeskDoca.parseBrazilDateTime(aberturaTexto);

    info.descricaoResumo = descricaoResumo;

    info.motorista = InfraDeskDoca.cleanFieldValue(tagsInfo.tags.motorista || '');
    info.documentoMotorista = InfraDeskDoca.cleanFieldValue(tagsInfo.tags.documento_rg_ou_cpf || tagsInfo.tags.documento || tagsInfo.tags.cpf || '');
    info.placa = InfraDeskDoca.cleanFieldValue(tagsInfo.tags.placa || '');
    info.temperatura = InfraDeskDoca.cleanFieldValue(tagsInfo.tags.temperatura || '');

    info.tags = tagsInfo.tags;
    info.tagsLista = tagsInfo.tagsLista;

    var cleaned = InfraDeskDoca.deleteEmptyDeep(info);
    return cleaned || {};
  };

  InfraDeskDoca.injectStyle = function () {
    if (document.getElementById('tm-infradesk-doca-style')) {
      return;
    }

    var style = document.createElement('style');
    style.id = 'tm-infradesk-doca-style';
    style.textContent = [
      '.tm-doca-user-badge {',
      '  display: inline-flex !important;',
      '  align-items: center !important;',
      '  gap: 3px !important;',
      '  margin-left: 5px !important;',
      '  padding: 1px 6px !important;',
      '  border-radius: 999px !important;',
      '  background: #eef6ff !important;',
      '  border: 1px solid #b6dcff !important;',
      '  color: #1a82cd !important;',
      '  font-size: 10px !important;',
      '  font-weight: 800 !important;',
      '  line-height: 16px !important;',
      '  vertical-align: middle !important;',
      '  max-width: 112px !important;',
      '  overflow: hidden !important;',
      '  white-space: nowrap !important;',
      '  text-overflow: ellipsis !important;',
      '}',
      '.tm-doca-user-badge i {',
      '  font-size: 9px !important;',
      '}',
      '.tm-doca-moving {',
      '  opacity: .72 !important;',
      '  transform: scale(.995) !important;',
      '}',
      '.tm-doca-capturado {',
      '  box-shadow: 1px 1px 6px #00000029, inset 4px 0 0 #1ab394 !important;',
      '}',
      '.tm-doca-hidden-reserved {',
      '  display: none !important;',
      '}'
    ].join('\n');

    document.head.appendChild(style);
  };

  InfraDeskDoca.shortName = function (name) {
    name = InfraDeskDoca.clean(name);

    if (!name) {
      return '';
    }

    var parts = name.split(' ').filter(Boolean);

    if (parts.length >= 2) {
      return parts[0] + ' ' + parts[1];
    }

    return name;
  };

  InfraDeskDoca.ensureBadgeOnCard = function (card, usuario) {
    if (!card || !usuario) {
      return;
    }

    var id = InfraDeskDoca.getCardId(card);

    if (!id) {
      return;
    }

    var headerLink = card.querySelector('a[href*="/backend/chamados/detalhes/"]');
    var numberEl = headerLink ? headerLink.querySelector('b') : null;

    if (!numberEl) {
      return;
    }

    var badge = card.querySelector('.tm-doca-user-badge');

    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'tm-doca-user-badge';
      numberEl.insertAdjacentElement('afterend', badge);
    }

    badge.innerHTML = '<i class="fa fa-user-check"></i> ' + InfraDeskDoca.shortName(usuario);
    badge.title = 'Capturado por ' + usuario;

    card.classList.add('tm-doca-capturado');
    card.dataset.tmDocaUsuario = usuario;
  };

  InfraDeskDoca.removeCaptureButton = function (card) {
    if (!card) {
      return;
    }

    var buttons = Array.prototype.slice.call(card.querySelectorAll('.capturar-btn, a[onclick*="capturarChamadoNew"], a[data-tm-doca-native-onclick*="capturarChamadoNew"]'));

    buttons.forEach(function (btn) {
      btn.remove();
    });
  };

  InfraDeskDoca.hideReservedOpenCard = function (card, item) {
    if (!card || !item) {
      return;
    }

    var statusId = InfraDeskDoca.getCardStatusId(card);
    var usuario = InfraDeskDoca.clean(item.usuario || item.operador || item.nome || 'outro usuário');

    InfraDeskDoca.ensureBadgeOnCard(card, usuario);
    InfraDeskDoca.removeCaptureButton(card);

    if (statusId === InfraDeskDoca.STATUS_ABERTO) {
      card.classList.add('tm-doca-hidden-reserved');
      card.dataset.tmDocaHiddenReason = 'reserved';
      InfraDeskDoca.updateKanbanCounters();
      InfraDeskDoca.scheduleOrderPriorityTabs(300);
    }
  };

  InfraDeskDoca.isDifferentReservation = function (reserva, usuarioAtual) {
    if (!reserva) {
      return false;
    }

    var currentKey = InfraDeskDoca.keyUser(usuarioAtual);
    var reservedKey = InfraDeskDoca.clean(reserva.usuarioNorm || '');

    if (!reservedKey && reserva.usuario) {
      reservedKey = InfraDeskDoca.keyUser(reserva.usuario);
    }

    return !!reservedKey && reservedKey !== currentKey;
  };

  InfraDeskDoca.applyFirebaseItem = function (id, item) {
    id = InfraDeskDoca.clean(id);

    if (!id || !item) {
      return;
    }

    InfraDeskDoca.state.firebaseCache[id] = item;

    var usuario = InfraDeskDoca.clean(item.usuario || item.operador || item.nome || '');
    var card = InfraDeskDoca.findCardById(id);

    if (!card) {
      return;
    }

    if (usuario) {
      InfraDeskDoca.ensureBadgeOnCard(card, usuario);
    }

    if (InfraDeskDoca.getCardStatusId(card) === InfraDeskDoca.STATUS_ABERTO) {
      InfraDeskDoca.hideReservedOpenCard(card, item);
    }
  };

  InfraDeskDoca.injectAllCards = function () {
    InfraDeskDoca.prepareCaptureButtons();

    var cards = InfraDeskDoca.getCards();

    for (var i = 0; i < cards.length; i++) {
      var id = InfraDeskDoca.getCardId(cards[i]);

      if (!id) {
        continue;
      }

      var item = InfraDeskDoca.state.firebaseCache[id];

      if (item) {
        InfraDeskDoca.applyFirebaseItem(id, item);
      }
    }

    InfraDeskDoca.scheduleOrderPriorityTabs(250);
  };

  InfraDeskDoca.loadFirebaseState = async function () {
    try {
      var res = await InfraDeskDoca.requestFirebase({
        method: 'GET',
        url: InfraDeskDoca.firebaseUrl(InfraDeskDoca.FIREBASE_ROOT + '/by_id') + '?_=' + Date.now()
      });

      if (!InfraDeskDoca.isOkResponse(res)) {
        return;
      }

      var data = InfraDeskDoca.parseJson(res.responseText || '{}', {}) || {};
      InfraDeskDoca.state.firebaseCache = data;

      Object.keys(data).forEach(function (id) {
        InfraDeskDoca.applyFirebaseItem(id, data[id]);
      });

      InfraDeskDoca.injectAllCards();
    } catch (err) {
      console.warn('[InfraDeskDoca] erro ao carregar Firebase', err);
    }
  };

  InfraDeskDoca.handleFirebaseEvent = function (raw) {
    var payload;

    try {
      payload = JSON.parse(raw || '{}');
    } catch (_) {
      return;
    }

    var path = String(payload.path || '/');
    var data = payload.data;

    if (path === '/' || path === '') {
      InfraDeskDoca.state.firebaseCache = data || {};
      Object.keys(InfraDeskDoca.state.firebaseCache).forEach(function (id) {
        InfraDeskDoca.applyFirebaseItem(id, InfraDeskDoca.state.firebaseCache[id]);
      });
      InfraDeskDoca.scheduleOrderPriorityTabs(300);
      return;
    }

    var cleanPath = path.replace(/^\/+/, '');
    var parts = cleanPath.split('/').filter(Boolean);
    var id = InfraDeskDoca.clean(parts[0]);

    if (!id) {
      return;
    }

    if (data === null) {
      delete InfraDeskDoca.state.firebaseCache[id];
      return;
    }

    if (parts.length === 1) {
      InfraDeskDoca.state.firebaseCache[id] = data;
      InfraDeskDoca.applyFirebaseItem(id, data);
      InfraDeskDoca.scheduleOrderPriorityTabs(300);
      return;
    }

    var current = InfraDeskDoca.state.firebaseCache[id] || {};
    current[parts[1]] = data;
    InfraDeskDoca.state.firebaseCache[id] = current;
    InfraDeskDoca.applyFirebaseItem(id, current);
    InfraDeskDoca.scheduleOrderPriorityTabs(300);
  };

  InfraDeskDoca.connectRealtime = function () {
    if (InfraDeskDoca.state.eventSource) {
      InfraDeskDoca.state.eventSource.close();
    }

    try {
      var es = new EventSource(InfraDeskDoca.firebaseUrl(InfraDeskDoca.FIREBASE_ROOT + '/by_id'));

      es.addEventListener('put', function (event) {
        InfraDeskDoca.handleFirebaseEvent(event.data);
      });

      es.addEventListener('patch', function (event) {
        InfraDeskDoca.handleFirebaseEvent(event.data);
      });

      es.onerror = function () {
        console.warn('[InfraDeskDoca] realtime Firebase reconectando...');
      };

      InfraDeskDoca.state.eventSource = es;
    } catch (err) {
      console.warn('[InfraDeskDoca] erro ao iniciar realtime', err);
    }
  };

  InfraDeskDoca.getRemoteCapture = async function (id) {
    id = InfraDeskDoca.clean(id);

    if (!id) {
      return null;
    }

    try {
      var res = await InfraDeskDoca.requestFirebase({
        method: 'GET',
        url: InfraDeskDoca.firebaseUrl(InfraDeskDoca.FIREBASE_ROOT + '/by_id/' + id) + '?_=' + Date.now()
      });

      if (!InfraDeskDoca.isOkResponse(res)) {
        return null;
      }

      return InfraDeskDoca.parseJson(res.responseText || 'null', null);
    } catch (err) {
      console.warn('[InfraDeskDoca] erro ao consultar reserva antes do clique', err);
      return null;
    }
  };

  InfraDeskDoca.saveCaptureToFirebase = async function (id, usuario, cardInfo) {
    id = InfraDeskDoca.clean(id);
    usuario = InfraDeskDoca.clean(usuario);
    cardInfo = cardInfo || {};

    if (!id || !usuario) {
      return false;
    }

    if (InfraDeskDoca.state.savingIds[id]) {
      return true;
    }

    InfraDeskDoca.state.savingIds[id] = true;

    var userKey = InfraDeskDoca.keyUser(usuario);
    var ts = Date.now();

    var payload = {
      chamadoId: id,
      usuario: usuario,
      usuarioNorm: userKey,
      usuarioId: InfraDeskDoca.clean(InfraDeskDoca.state.user.id),
      statusId: InfraDeskDoca.STATUS_EM_LIBERACAO,
      statusNome: InfraDeskDoca.STATUS_EM_LIBERACAO_NOME,
      capturadoEm: ts,
      atualizadoEm: ts,
      origem: 'tampermonkey-infradesk-doca'
    };

    Object.keys(cardInfo).forEach(function (key) {
      payload[key] = cardInfo[key];
    });

    payload.chamadoId = id;
    payload.usuario = usuario;
    payload.usuarioNorm = userKey;
    payload.usuarioId = InfraDeskDoca.clean(InfraDeskDoca.state.user.id);
    payload.statusId = InfraDeskDoca.STATUS_EM_LIBERACAO;
    payload.statusNome = InfraDeskDoca.STATUS_EM_LIBERACAO_NOME;
    payload.atualizadoEm = ts;

    payload = InfraDeskDoca.deleteEmptyDeep(payload) || {};

    var patch = {};
    patch['by_id/' + id] = payload;
    patch['by_usuario/' + userKey + '/' + id] = true;

    try {
      var res = await InfraDeskDoca.requestFirebase({
        method: 'PATCH',
        url: InfraDeskDoca.firebaseUrl(InfraDeskDoca.FIREBASE_ROOT),
        headers: {
          'Content-Type': 'application/json'
        },
        data: JSON.stringify(patch)
      });

      if (!InfraDeskDoca.isOkResponse(res)) {
        throw new Error('Firebase status ' + res.status + ' - ' + (res.responseText || ''));
      }

      InfraDeskDoca.state.firebaseCache[id] = payload;

      var card = InfraDeskDoca.findCardById(id);

      if (card) {
        InfraDeskDoca.ensureBadgeOnCard(card, usuario);
      }

      return true;
    } catch (err) {
      console.warn('[InfraDeskDoca] erro ao salvar captura no Firebase', err);
      InfraDeskDoca.notify('warning', 'Capturei na tela, mas não consegui registrar no Firebase.');
      return false;
    } finally {
      delete InfraDeskDoca.state.savingIds[id];
    }
  };

  InfraDeskDoca.updateKanbanCounters = function () {
    var lists = Array.prototype.slice.call(document.querySelectorAll('ul.list-status-chamados[data-status-id]'));

    for (var i = 0; i < lists.length; i++) {
      var ul = lists[i];
      var statusId = ul.getAttribute('data-status-id');
      var cards = Array.prototype.slice.call(ul.querySelectorAll('.chamado-item[data-chamado-id], li.chamado-item'));
      var count = cards.filter(function (card) {
        return !card.classList.contains('tm-doca-hidden-reserved');
      }).length;
      var h3 = document.querySelector('h3[data-status-id="' + statusId + '"] span');

      if (h3) {
        h3.textContent = String(count);
      }
    }
  };

  InfraDeskDoca.moveCardToLiberacaoLocal = function (id, usuario) {
    var card = InfraDeskDoca.findCardById(id);
    var targetUl = InfraDeskDoca.getStatusUl(InfraDeskDoca.STATUS_EM_LIBERACAO);

    if (!card || !targetUl) {
      return false;
    }

    InfraDeskDoca.ensureBadgeOnCard(card, usuario);

    card.classList.remove('tm-doca-hidden-reserved');
    card.classList.add('tm-doca-moving');
    card.dataset.isCapturado = '1';

    InfraDeskDoca.removeCaptureButton(card);
    targetUl.prepend(card);

    setTimeout(function () {
      card.classList.remove('tm-doca-moving');
    }, 450);

    InfraDeskDoca.updateKanbanCounters();
    InfraDeskDoca.scheduleOrderPriorityTabs(250);

    return true;
  };

  InfraDeskDoca.refreshCardFromSystem = function (id, usuario, forceStatusId) {
    var root = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

    if (root && typeof root.atualizarCard === 'function') {
      try {
        root.atualizarCard(id, {
          chamado: {
            id: id,
            status_chamado_id: forceStatusId || InfraDeskDoca.STATUS_EM_LIBERACAO
          }
        }, function () {
          var card = InfraDeskDoca.findCardById(id);

          if (card) {
            InfraDeskDoca.ensureBadgeOnCard(card, usuario);
          }

          InfraDeskDoca.updateKanbanCounters();
          InfraDeskDoca.scheduleOrderPriorityTabs(250);
        });

        return;
      } catch (err) {
        console.warn('[InfraDeskDoca] atualizarCard falhou, usando movimento local', err);
      }
    }

    InfraDeskDoca.moveCardToLiberacaoLocal(id, usuario);
  };

  InfraDeskDoca.persistStatusInInfradesk = async function (id) {
    id = InfraDeskDoca.clean(id);

    if (!id) {
      return false;
    }

    if (InfraDeskDoca.state.movingIds[id]) {
      return true;
    }

    InfraDeskDoca.state.movingIds[id] = true;

    var attempts = [
      {
        url: '/backend/chamados/editar/' + encodeURIComponent(id) + '.json',
        data: {
          status_chamado_id: InfraDeskDoca.STATUS_EM_LIBERACAO
        }
      },
      {
        url: '/backend/chamados/editar/' + encodeURIComponent(id) + '.json',
        data: {
          chamado_status_id: InfraDeskDoca.STATUS_EM_LIBERACAO
        }
      },
      {
        url: '/backend/chamados/editar/' + encodeURIComponent(id) + '.json',
        data: {
          status_id: InfraDeskDoca.STATUS_EM_LIBERACAO
        }
      },
      {
        url: '/backend/chamados/editar/' + encodeURIComponent(id) + '.json',
        data: {
          status_chamado_id: InfraDeskDoca.STATUS_EM_LIBERACAO,
          is_capturado: 1
        }
      }
    ];

    try {
      for (var i = 0; i < attempts.length; i++) {
        var attempt = attempts[i];

        var response = await InfraDeskDoca.sameOriginPost(attempt.url, attempt.data);

        if (response && response.ok) {
          var json = response.json || {};

          if (json && json.success === false) {
            continue;
          }

          return true;
        }
      }

      return false;
    } catch (err) {
      console.warn('[InfraDeskDoca] erro ao persistir status no Infradesk', err);
      return false;
    } finally {
      delete InfraDeskDoca.state.movingIds[id];
    }
  };

  InfraDeskDoca.getNativeOnclick = function (btn) {
    return InfraDeskDoca.clean(
      btn.getAttribute('data-tm-doca-native-onclick') ||
      btn.getAttribute('onclick') ||
      btn.getAttribute('_onclick') ||
      ''
    );
  };

  InfraDeskDoca.runNativeCapture = function (btn, id) {
    var root = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    var onclick = InfraDeskDoca.getNativeOnclick(btn);

    var match = onclick.match(/capturarChamadoNew\s*\(\s*(\d+)\s*,\s*([^,\)]+)/i);
    var grupoId = match && match[2] ? match[2].replace(/\D+/g, '') : '';

    if (root && typeof root.capturarChamadoNew === 'function') {
      root.capturarChamadoNew(Number(id), grupoId ? Number(grupoId) : undefined, btn, undefined);
      return true;
    }

    return false;
  };

  InfraDeskDoca.prepareCaptureButton = function (btn) {
    if (!btn || btn.dataset.tmDocaPrepared === '1') {
      return;
    }

    var nativeOnclick = InfraDeskDoca.getNativeOnclick(btn);

    if (nativeOnclick) {
      btn.setAttribute('data-tm-doca-native-onclick', nativeOnclick);
    }

    btn.removeAttribute('onclick');
    btn.onclick = null;
    btn.href = 'javascript:void(0);';
    btn.dataset.tmDocaPrepared = '1';

    btn.addEventListener('click', InfraDeskDoca.onSafeCaptureClick, true);
  };

  InfraDeskDoca.prepareCaptureButtons = function () {
    var buttons = Array.prototype.slice.call(document.querySelectorAll('.capturar-btn, a[onclick*="capturarChamadoNew"], a[data-tm-doca-native-onclick*="capturarChamadoNew"]'));

    buttons.forEach(function (btn) {
      InfraDeskDoca.prepareCaptureButton(btn);
    });
  };

  InfraDeskDoca.abortAlreadyReserved = function (card, reserva, usuarioAtual) {
    var nomeReserva = InfraDeskDoca.clean(reserva && (reserva.usuario || reserva.operador || reserva.nome) || 'outro usuário');

    if (InfraDeskDoca.isDifferentReservation(reserva, usuarioAtual)) {
      InfraDeskDoca.notify('warning', 'Este chamado já foi reservado por ' + nomeReserva + '.');
    } else {
      InfraDeskDoca.notify('info', 'Este chamado já está reservado por você.');
    }

    if (card) {
      InfraDeskDoca.hideReservedOpenCard(card, reserva || {
        usuario: nomeReserva
      });
    }
  };

  InfraDeskDoca.captureAllowed = async function (btn) {
    var card = btn && btn.closest ? btn.closest('.chamado-item[data-chamado-id], li.chamado-item') : null;

    if (!card) {
      return;
    }

    var id = InfraDeskDoca.getCardId(card);

    if (!id) {
      return;
    }

    if (InfraDeskDoca.state.clickingIds[id]) {
      return;
    }

    InfraDeskDoca.state.clickingIds[id] = true;

    try {
      InfraDeskDoca.refreshLoggedUser();

      var usuario = InfraDeskDoca.clean(InfraDeskDoca.state.user.nome);

      if (!usuario) {
        InfraDeskDoca.notify('error', 'Não consegui identificar o usuário logado.');
        return;
      }

      var reservaLocal = InfraDeskDoca.state.firebaseCache[id] || null;
      var reservaRemota = await InfraDeskDoca.getRemoteCapture(id);
      var reserva = reservaRemota || reservaLocal;

      if (reserva && (reserva.usuario || reserva.usuarioNorm || reserva.operador || reserva.nome)) {
        InfraDeskDoca.abortAlreadyReserved(card, reserva, usuario);
        return;
      }

      var cardInfo = InfraDeskDoca.extractCardInfo(card);
      cardInfo.statusAntes = InfraDeskDoca.getCardStatusId(card);

      var nativeOk = InfraDeskDoca.runNativeCapture(btn, id);

      if (!nativeOk) {
        InfraDeskDoca.notify('error', 'Não consegui executar a captura original do Infradesk.');
        return;
      }

      // Espera a captura original terminar. Só depois persiste status, grava Firebase e move visualmente.
      setTimeout(async function () {
        var segundaChecagem = await InfraDeskDoca.getRemoteCapture(id);

        if (segundaChecagem && (segundaChecagem.usuario || segundaChecagem.usuarioNorm) && InfraDeskDoca.isDifferentReservation(segundaChecagem, usuario)) {
          InfraDeskDoca.abortAlreadyReserved(card, segundaChecagem, usuario);
          return;
        }

        var persisted = await InfraDeskDoca.persistStatusInInfradesk(id);

        if (!persisted) {
          InfraDeskDoca.notify('warning', 'A captura não confirmou a mudança de status. Não movi o card.');
          return;
        }

        await InfraDeskDoca.saveCaptureToFirebase(id, usuario, cardInfo);
        InfraDeskDoca.moveCardToLiberacaoLocal(id, usuario);

        setTimeout(function () {
          InfraDeskDoca.refreshCardFromSystem(id, usuario, InfraDeskDoca.STATUS_EM_LIBERACAO);
        }, 450);
      }, 900);
    } finally {
      setTimeout(function () {
        delete InfraDeskDoca.state.clickingIds[id];
      }, 1800);
    }
  };

  InfraDeskDoca.onSafeCaptureClick = function (event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    var btn = event.currentTarget || (event.target && event.target.closest ? event.target.closest('.capturar-btn, a[data-tm-doca-native-onclick*="capturarChamadoNew"]') : null);

    if (!btn) {
      return;
    }

    InfraDeskDoca.captureAllowed(btn);
  };

  InfraDeskDoca.onDocumentClickCapture = function (event) {
    var target = event.target;

    if (!target || !target.closest) {
      return;
    }

    var btn = target.closest('.capturar-btn, a[onclick*="capturarChamadoNew"], a[data-tm-doca-native-onclick*="capturarChamadoNew"]');

    if (!btn) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    InfraDeskDoca.prepareCaptureButton(btn);
    InfraDeskDoca.captureAllowed(btn);
  };

  InfraDeskDoca.observeBody = function () {
    if (InfraDeskDoca.state.observer) {
      InfraDeskDoca.state.observer.disconnect();
    }

    InfraDeskDoca.state.observer = new MutationObserver(function () {
      if (InfraDeskDoca.state.orderRunning) {
        return;
      }

      clearTimeout(InfraDeskDoca.state.debounceTimer);

      InfraDeskDoca.state.debounceTimer = setTimeout(function () {
        if (InfraDeskDoca.state.orderRunning) {
          return;
        }

        InfraDeskDoca.refreshLoggedUser();
        InfraDeskDoca.injectAllCards();
      }, 300);
    });

    InfraDeskDoca.state.observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  };

  InfraDeskDoca.testPersistStatus = function (id) {
    return InfraDeskDoca.persistStatusInInfradesk(id);
  };

  InfraDeskDoca.testExtract = function (id) {
    var card = id ? InfraDeskDoca.findCardById(id) : document.querySelector('.chamado-item[data-chamado-id], li.chamado-item');
    return InfraDeskDoca.extractCardInfo(card);
  };

  InfraDeskDoca.testRemote = function (id) {
    return InfraDeskDoca.getRemoteCapture(id);
  };

  InfraDeskDoca.start = function () {
    if (InfraDeskDoca.state.started) {
      return;
    }

    InfraDeskDoca.state.started = true;

    InfraDeskDoca.injectStyle();
    InfraDeskDoca.refreshLoggedUser();

    document.removeEventListener('click', InfraDeskDoca.onDocumentClickCapture, true);
    document.addEventListener('click', InfraDeskDoca.onDocumentClickCapture, true);

    setTimeout(function () {
      InfraDeskDoca.prepareCaptureButtons();
      InfraDeskDoca.loadFirebaseState();
      InfraDeskDoca.connectRealtime();
      InfraDeskDoca.injectAllCards();
      setTimeout(function () {
        InfraDeskDoca.orderPriorityTabs();
      }, 800);
      setTimeout(function () {
        InfraDeskDoca.orderPriorityTabs();
      }, 1800);
      setTimeout(function () {
        InfraDeskDoca.orderPriorityTabs();
      }, 3500);
      InfraDeskDoca.observeBody();
    }, 600);

    window.addEventListener('beforeunload', function () {
      if (InfraDeskDoca.state.eventSource) {
        InfraDeskDoca.state.eventSource.close();
      }
    });
  };

  window.InfraDeskDoca = InfraDeskDoca;

  if (typeof unsafeWindow !== 'undefined') {
    unsafeWindow.InfraDeskDoca = InfraDeskDoca;
  }

  InfraDeskDoca.start();
})();
