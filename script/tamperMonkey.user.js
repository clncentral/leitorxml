// ==UserScript==
// @name         InfraDesk Despesas • Trava por usuário logado
// @namespace    clncentral/infradesk
// @version      5.0.6
// @description  Reserva despesas em tempo real na tela original e oferece um painel financeiro rápido, unificado e integrado ao Firebase.
// @author       CLN Central
// @match        https://asp.infradesk.app/backend/despesas*
// @match        https://asp.infradesk.app/backend/despesas/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @grant        unsafeWindow
// @connect      infradesk-operadores-default-rtdb.firebaseio.com
// @updateURL    https://clncentral.github.io/leitorxml/script/tamperMonkey.user.js
// @downloadURL  https://clncentral.github.io/leitorxml/script/tamperMonkey.user.js
// @noframes
// ==/UserScript==

(function () {
  "use strict";

  // =========================================================
  // CONFIGURACAO_PRINCIPAL
  // Para localizar depois, use CTRL + F e procure por:
  // CONFIGURACAO_PRINCIPAL
  // =========================================================
  const CONFIG = {
    versao: "5.0.6",
    parametroPainel: "sigma_painel_financeiro_v5",
    urlPainel: "/backend/despesas?sigma_painel_financeiro_v5=1",
    statusFilaFixo: "P",

    // O InfraDesk pagina o resultado normal. Portanto podemos usar
    // um período amplo sem mandar o navegador desenhar 200 despesas.
    periodoInicial: "01/01/2020",
    periodoFinal: "31/12/2035",
    paginasSimultaneas: 3,

    firebaseBase: "https://infradesk-operadores-default-rtdb.firebaseio.com",
    firebaseReservas: "despesas_updates/by_id",
    firebaseEstadoPainel: "despesas_painel/estado/by_id",

    // Uma conclusão recente some imediatamente da tela dos outros usuários.
    // Em uma nova consulta, depois desse prazo, o InfraDesk volta a ser
    // a fonte principal da verdade caso a despesa retorne ao Financeiro.
    validadeEstadoFinalMs: 12 * 60 * 60 * 1000,

    coresUsuarios: {
      "Elias Araujo": "#0324ff",
      "Camily Assis": "#d8b4e8",
      "Elia Maria": "#962bcc",
      Patricia: "#ff8e03",
      Marcia: "#6a0e9c",
      Helena: "#8c1223",
    },
  };

  const PREFIXO = "[Painel Financeiro]";
  const urlAtual = new URL(window.location.href);
  const modoPainel = urlAtual.searchParams.get(CONFIG.parametroPainel) === "1";

  const normalState = {
    iniciado: false,
    usuario: { nome: "", id: "" },
    reservas: {},
    eventosReserva: null,
    recebeuPrimeiroEvento: false,
    observer: null,
    linhasPorId: new Map(),
    modalDespesaId: "",
    abrindoIds: new Set(),
    salvandoIds: new Set(),
  };

  if (!modoPainel) {
    iniciarPaginaPrincipalLeve();
    return;
  }

  // A versão anterior tentava interromper e reescrever o documento em
  // document-start. Em alguns navegadores isso também interrompia os
  // próprios arquivos do painel e resultava em uma aba completamente branca.
  // Agora escondemos a página original, esperamos o DOM ficar disponível e
  // então substituímos somente o conteúdo visual.
  ocultarPaginaOriginal();

  const state = {
    despesas: [],
    reservas: {},
    estados: {},
    usuario: { nome: "", setor: "", login: "", id: "" },
    itemModal: null,
    carregando: false,
    dependenciasPromise: null,
    eventosReserva: null,
    eventosEstado: null,
    renderTimer: null,
    modalObserver: null,
    restaurandoPreferencias: false,
    inicializando: true,
    filtrosProntos: false,
    renderPendente: false,
    destruindoSelect2: false,
    salvandoId: "",
    abrindoIds: new Set(),
    reservandoIds: new Set(),
    sincronizandoFirebase: false,
    firebaseRetryTimer: null,
  };

  prepararPainel().catch(function (falha) {
    console.error(PREFIXO, falha);
    revelarDocumento();
    mostrarErroFatal(falha);
  });

  // =========================================================
  // ABRIR_PAINEL_EM_OUTRA_ABA
  // Nas páginas normais do InfraDesk adiciona um pequeno atalho.
  // =========================================================
  function instalarBotaoAbrirPainel() {
    const instalar = function () {
      if (!document.body) return;

      let link = document.getElementById("sigma-abrir-painel-financeiro");
      if (!link) {
        link = document.createElement("a");
        link.id = "sigma-abrir-painel-financeiro";
        document.body.appendChild(link);
      }
      link.href = CONFIG.urlPainel;
      link.target = "_blank";
      link.rel = "noopener";
      link.innerHTML = '<i class="fa-solid fa-table-list"></i><span>Painel Financeiro</span>';
      link.title = "Abrir o novo Painel Financeiro em outra aba";
      link.style.cssText = [
        "position:fixed",
        "right:18px",
        "bottom:18px",
        "z-index:999999",
        "display:inline-flex",
        "align-items:center",
        "gap:8px",
        "height:42px",
        "padding:0 15px",
        "border-radius:12px",
        "background:#0f172a",
        "color:#fff",
        "font:800 13px Arial,sans-serif",
        "text-decoration:none",
        "box-shadow:0 10px 28px rgba(15,23,42,.32)",
      ].join(";");

    };

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", instalar, { once: true });
    } else {
      instalar();
    }
  }

  // =========================================================
  // PAGINA_PRINCIPAL_LEVE
  // Para localizar depois, use CTRL + F e procure por:
  // PAGINA_PRINCIPAL_LEVE
  //
  // Nesta tela não existe contador de competências, paginação extra,
  // cache de competências nem varredura das outras páginas.
  // O script cuida somente da reserva e do atalho para o painel.
  // =========================================================
  function iniciarPaginaPrincipalLeve() {
    if (window.top !== window.self) return;

    const iniciar = function () {
      if (normalState.iniciado || !document.body) return;
      normalState.iniciado = true;

      instalarBotaoAbrirPainel();
      injetarEstiloPaginaPrincipal();
      atualizarUsuarioPaginaPrincipal();
      processarLinhasPaginaPrincipal(document);
      atualizarTodosBotoesFinanceirosNormal();
      observarPaginaPrincipal();

      document.addEventListener("click", tratarCliquePaginaPrincipal, true);
      document.addEventListener("submit", tratarSubmitPaginaPrincipal, true);
      conectarRealtimePaginaPrincipal();

      // Algumas partes do InfraDesk chegam logo depois do DOMContentLoaded.
      // São poucas tentativas e somente as linhas ainda não preparadas entram.
      let tentativas = 0;
      const timer = setInterval(function () {
        tentativas++;
        atualizarUsuarioPaginaPrincipal();
        processarLinhasPaginaPrincipal(document);
        if (tentativas >= 8) clearInterval(timer);
      }, 600);
    };

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", iniciar, { once: true });
    } else {
      iniciar();
    }
  }

  function injetarEstiloPaginaPrincipal() {
    if (document.getElementById("sigma-reserva-principal-css")) return;

    const style = document.createElement("style");
    style.id = "sigma-reserva-principal-css";
    style.textContent = `
      tr.tr-index > td:first-child p {
        display: inline-block !important;
        margin: 0 4px !important;
        vertical-align: middle !important;
        line-height: 23px !important;
      }
      .sigma-reserva-inline {
        display: inline-flex !important;
        align-items: center !important;
        gap: 4px !important;
        margin-left: 5px !important;
        vertical-align: middle !important;
      }
      .sigma-reserva-inline > .select2-container,
      .sigma-reserva-inline .select2-container {
        display: none !important;
      }
      .sigma-reserva-select,
      .sigma-reserva-select.select2-hidden-accessible {
        position: static !important;
        display: inline-block !important;
        clip: auto !important;
        overflow: visible !important;
        width: 118px !important;
        height: 23px !important;
        min-height: 23px !important;
        max-height: 23px !important;
        margin: 0 !important;
        padding: 1px 5px !important;
        border: 1px solid #94a3b8 !important;
        border-radius: 9px !important;
        opacity: 1 !important;
        white-space: normal !important;
        color: #334155 !important;
        font-size: 10px !important;
        font-weight: 900 !important;
        line-height: 19px !important;
        outline: none !important;
        cursor: pointer !important;
        vertical-align: middle !important;
        box-shadow: 0 1px 3px rgba(15, 23, 42, .08) !important;
      }
      .sigma-reserva-select:focus {
        border-color: #2563eb !important;
        box-shadow: 0 0 0 3px rgba(37, 99, 235, .14) !important;
      }
      .sigma-reserva-select.sigma-salvando {
        opacity: .55 !important;
        pointer-events: none !important;
      }
      .sigma-reserva-select option {
        background: #fff !important;
        color: #111827 !important;
        font-weight: 800 !important;
      }
      .sigma-reserva-liberar {
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        width: 20px !important;
        min-width: 20px !important;
        height: 20px !important;
        padding: 0 !important;
        border: 0 !important;
        border-radius: 999px !important;
        color: #fff !important;
        font-size: 14px !important;
        font-weight: 900 !important;
        line-height: 20px !important;
        cursor: pointer !important;
        box-shadow: 0 2px 5px rgba(15, 23, 42, .22) !important;
      }
      .sigma-reserva-liberar:hover {
        filter: brightness(1.15) !important;
        transform: scale(1.05) !important;
      }
      .sigma-reserva-liberar[hidden] {
        display: none !important;
      }
      .sigma-reserva-status {
        min-width: 11px !important;
        color: #64748b !important;
        font-size: 10px !important;
        font-weight: 900 !important;
      }
      .sigma-reserva-bloqueado {
        opacity: .36 !important;
        cursor: not-allowed !important;
        filter: grayscale(1) !important;
      }
    `;
    document.head.appendChild(style);
  }

  function atualizarUsuarioPaginaPrincipal() {
    const globalUsuario = paginaWindow().__SIGMA_USUARIO_LOGADO__;
    if (globalUsuario && texto(globalUsuario.nome)) {
      normalState.usuario.nome = texto(globalUsuario.nome);
      normalState.usuario.id = texto(globalUsuario.id);
      return normalState.usuario;
    }

    const seletores = [
      ".profile-element strong.font-bold",
      ".profile-element .font-bold",
      ".nav-header strong.font-bold",
      ".nav-header .font-bold",
      ".nav-header big",
    ];

    for (const seletor of seletores) {
      const el = document.querySelector(seletor);
      if (!el) continue;
      const nome = texto(el.textContent || "")
        .replace(/\s*\bSair\b\s*$/i, "")
        .replace(/\s*\bMeus dados\b\s*$/i, "")
        .replace(/[▾▼]/g, "")
        .trim();
      if (nome && !/central|libera/i.test(nome) && nome.length >= 3) {
        normalState.usuario.nome = nome;
        break;
      }
    }

    const avatar = document.querySelector(
      '[id*="avatar_usuario_"], img[src*="/avatar/"], [style*="avatar_usuario_"]'
    );
    if (avatar) {
      const origem = [
        avatar.id || "",
        avatar.getAttribute("src") || "",
        avatar.getAttribute("style") || "",
      ].join(" ");
      const match = origem.match(/avatar_usuario_(\d+)|\/avatar\/(\d+)\//i);
      if (match) normalState.usuario.id = texto(match[1] || match[2]);
    }

    return normalState.usuario;
  }

  function idDespesaDeTexto(valor) {
    const match = String(valor || "").match(
      /\/backend\/despesas\/(?:financeiro|revisar|aprovar|bloquear)\/(\d+)|despesa_id=(\d+)/i
    );
    return match ? texto(match[1] || match[2]) : "";
  }

  function idLinhaPaginaPrincipal(tr) {
    if (!tr) return "";

    const salvo = texto(tr.dataset ? tr.dataset.sigmaId : "");
    if (salvo) return salvo;

    const botao = tr.querySelector(
      '[onclick*="/backend/despesas/financeiro/"],' +
      '[onclick*="/backend/despesas/revisar/"],' +
      '[onclick*="/backend/despesas/aprovar/"],' +
      '[onclick*="/backend/despesas/bloquear/"]'
    );
    const peloBotao = botao ? idDespesaDeTexto(botao.getAttribute("onclick") || "") : "";
    if (peloBotao) return peloBotao;

    const primeira = tr.children && tr.children.length ? tr.children[0] : null;
    const p = primeira ? primeira.querySelector("p") : null;
    const numero = texto(p ? p.textContent : "").match(/^\d{3,}$/);
    return numero ? numero[0] : "";
  }

  function ehLinhaDespesaPaginaPrincipal(tr) {
    if (!tr || !tr.matches || !tr.matches("tr")) return false;
    if (tr.querySelector("th") || tr.classList.contains("expandir")) return false;
    if (String(tr.className || "").includes("expandir-")) return false;
    if (!idLinhaPaginaPrincipal(tr)) return false;
    return tr.classList.contains("tr-index")
      || !!tr.querySelector(".td-buttons, a.btn, button.btn")
      || Array.from(tr.children || []).some(function (td) {
        return /\bR\$\s*/.test(td.textContent || "");
      });
  }

  function processarLinhasPaginaPrincipal(raiz) {
    if (!raiz || !raiz.querySelectorAll) return;

    const linhas = [];
    if (raiz.matches && raiz.matches("tr")) linhas.push(raiz);
    raiz.querySelectorAll("tbody tr").forEach(function (tr) { linhas.push(tr); });

    linhas.forEach(function (tr) {
      if (!ehLinhaDespesaPaginaPrincipal(tr)) return;
      prepararLinhaPaginaPrincipal(tr);
    });
  }

  function prepararLinhaPaginaPrincipal(tr) {
    const id = idLinhaPaginaPrincipal(tr);
    if (!id) return;

    tr.dataset.sigmaId = id;
    normalState.linhasPorId.set(id, tr);

    let inline = tr.querySelector(".sigma-reserva-inline");
    if (!inline) {
      inline = document.createElement("span");
      inline.className = "sigma-reserva-inline";

      const select = document.createElement("select");
      select.className = "sigma-reserva-select";
      select.dataset.sigmaId = id;
      select.title = "Responsável por esta despesa";
      select.addEventListener("mousedown", function (evento) { evento.stopPropagation(); });
      select.addEventListener("click", function (evento) { evento.stopPropagation(); });
      select.addEventListener("change", function () { void alterarReservaPaginaPrincipal(select); });

      const liberar = document.createElement("button");
      liberar.type = "button";
      liberar.className = "sigma-reserva-liberar";
      liberar.dataset.sigmaId = id;
      liberar.textContent = "×";
      liberar.hidden = true;
      liberar.addEventListener("mousedown", function (evento) { evento.stopPropagation(); });
      liberar.addEventListener("click", function (evento) {
        evento.preventDefault();
        evento.stopPropagation();
        void removerReservaPaginaPrincipal(id);
      });

      const status = document.createElement("span");
      status.className = "sigma-reserva-status";

      inline.appendChild(select);
      inline.appendChild(liberar);
      inline.appendChild(status);

      const primeira = tr.children && tr.children.length ? tr.children[0] : null;
      const numero = primeira ? primeira.querySelector("p") : null;
      if (numero) numero.insertAdjacentElement("afterend", inline);
      else if (primeira) primeira.insertBefore(inline, primeira.firstChild);
    }

    atualizarLinhaPaginaPrincipal(id);
  }

  function donoReservaNormal(id) {
    return donoReservaNoMapa(normalState.reservas, id);
  }

  function donoReservaNoMapa(mapa, id) {
    const item = mapa && mapa[id];
    if (!item) return "";
    if (typeof item === "string") return texto(item);
    return texto(item.operador || item.usuario || item.nome || item.user || "");
  }

  function donoItemReserva(item) {
    if (!item) return "";
    if (typeof item === "string") return texto(item);
    return texto(item.operador || item.usuario || item.nome || item.user || "");
  }

  function atualizarOpcoesReservaNormal(select, owner) {
    if (!select) return;
    atualizarUsuarioPaginaPrincipal();
    restaurarSelectReservaNativo(select);

    const usuario = texto(normalState.usuario.nome);
    const valorAnterior = owner || "";
    select.innerHTML = "";

    const semUsuario = document.createElement("option");
    semUsuario.value = "";
    semUsuario.textContent = "Sem usuário";
    select.appendChild(semUsuario);

    if (owner) {
      const atual = document.createElement("option");
      atual.value = owner;
      atual.textContent = owner;
      select.appendChild(atual);
    }

    if (usuario && !mesmaPessoa(owner, usuario)) {
      const assumir = document.createElement("option");
      assumir.value = usuario;
      assumir.textContent = usuario;
      select.appendChild(assumir);
    }

    select.value = valorAnterior;
    estilizarSelectReservaNormal(select, owner);
  }

  function estilizarSelectReservaNormal(select, owner) {
    const cor = corUsuario(owner);
    const corTexto = owner && cor.toLowerCase() !== "#d8b4e8" ? "#fff" : "#334155";
    select.style.setProperty("background", owner ? cor : "#fff", "important");
    select.style.setProperty("background-color", owner ? cor : "#fff", "important");
    select.style.setProperty("color", corTexto, "important");
    select.style.setProperty("border-color", owner ? cor : "#94a3b8", "important");
    select.style.setProperty(
      "box-shadow",
      owner ? `0 0 0 2px ${cor}33` : "0 1px 3px rgba(15, 23, 42, .08)",
      "important"
    );
  }

  function restaurarSelectReservaNativo(select) {
    if (!select) return;

    const root = paginaWindow();
    const $ = root.jQuery || root.$ || window.jQuery || window.$;
    if (
      $ && $.fn && typeof $.fn.select2 === "function"
      && select.classList.contains("select2-hidden-accessible")
    ) {
      try { $(select).select2("destroy"); } catch (_) {}
    }

    select.classList.remove("select2-hidden-accessible");
    select.removeAttribute("data-select2-id");
    select.removeAttribute("tabindex");
    select.removeAttribute("aria-hidden");
    select.style.removeProperty("position");
    select.style.removeProperty("clip");
    select.style.removeProperty("overflow");
    select.style.removeProperty("opacity");

    const inline = select.closest(".sigma-reserva-inline");
    if (inline) {
      inline.querySelectorAll(".select2-container").forEach(function (container) {
        container.remove();
      });
    }
  }

  function restaurarTodosSelectsReservaNativos() {
    document.querySelectorAll(".sigma-reserva-select").forEach(function (select) {
      restaurarSelectReservaNativo(select);
      estilizarSelectReservaNormal(select, donoReservaNormal(texto(select.dataset.sigmaId)));
    });
  }

  function obterLinhaNormal(id) {
    const conhecida = normalState.linhasPorId.get(id);
    if (conhecida && conhecida.isConnected) return conhecida;
    normalState.linhasPorId.delete(id);
    return null;
  }

  function atualizarLinhaPaginaPrincipal(id) {
    const tr = obterLinhaNormal(id);
    if (!tr) return;

    const owner = donoReservaNormal(id);
    const select = tr.querySelector(".sigma-reserva-select");
    atualizarOpcoesReservaNormal(select, owner);

    const cor = corUsuario(owner);
    const liberar = tr.querySelector(".sigma-reserva-liberar");
    if (liberar) {
      liberar.hidden = !owner;
      liberar.title = owner
        ? (mesmaPessoa(owner, normalState.usuario.nome)
          ? "Liberar esta despesa"
          : `Remover a reserva de ${owner}`)
        : "";
      liberar.style.setProperty("background", owner ? cor : "#64748b", "important");
      liberar.style.setProperty(
        "color",
        owner && cor.toLowerCase() === "#d8b4e8" ? "#334155" : "#fff",
        "important"
      );
    }
    tr.style.boxShadow = owner ? `inset 5px 0 0 ${cor}` : "";
    const primeira = tr.children && tr.children.length ? tr.children[0] : null;
    if (primeira) primeira.style.boxShadow = owner ? `${cor} 6px 0 0 inset` : "";

    atualizarBotoesFinanceirosDaLinhaNormal(tr, id, owner);
    if (normalState.modalDespesaId === id) atualizarBotoesModalNormal();
  }

  function guardarEstadoOriginalBotaoNormal(botao) {
    if (!botao.dataset.sigmaOriginalDisabled) {
      botao.dataset.sigmaOriginalDisabled = botao.disabled ? "1" : "0";
      botao.dataset.sigmaOriginalClasseDisabled = botao.classList.contains("disabled") ? "1" : "0";
      botao.dataset.sigmaOriginalTitle = botao.getAttribute("title") || "";
    }
  }

  function definirBloqueioBotaoNormal(botao, bloqueado, owner) {
    if (!botao) return;
    guardarEstadoOriginalBotaoNormal(botao);

    if (bloqueado) {
      if (botao.tagName.toLowerCase() === "button") botao.disabled = true;
      botao.classList.add("disabled", "sigma-reserva-bloqueado");
      botao.setAttribute("aria-disabled", "true");
      botao.setAttribute("title", "Bloqueado: " + owner);
      botao.dataset.sigmaBloqueadoReserva = "1";
      return;
    }

    if (botao.dataset.sigmaOriginalDisabled === "0" && botao.tagName.toLowerCase() === "button") {
      botao.disabled = false;
    }
    if (botao.dataset.sigmaOriginalClasseDisabled === "0") botao.classList.remove("disabled");
    botao.classList.remove("sigma-reserva-bloqueado");
    botao.removeAttribute("aria-disabled");
    botao.setAttribute("title", botao.dataset.sigmaOriginalTitle || "");
    botao.dataset.sigmaBloqueadoReserva = "0";
  }

  function atualizarBotoesFinanceirosDaLinhaNormal(tr, id, owner) {
    const bloqueado = !!owner && !mesmaPessoa(owner, normalState.usuario.nome);
    tr.querySelectorAll(
      '[onclick*="/backend/despesas/financeiro/"], [data-sigma-finance-url]'
    ).forEach(function (botao) {
      const idBotao = idDespesaDeTexto(botao.getAttribute("onclick") || "") || texto(botao.dataset.sigmaId);
      if (!idBotao || idBotao === id) definirBloqueioBotaoNormal(botao, bloqueado, owner);
    });
  }

  function atualizarTodosBotoesFinanceirosNormal() {
    document.querySelectorAll('[onclick*="/backend/despesas/financeiro/"]').forEach(function (botao) {
      const id = idDespesaDeTexto(botao.getAttribute("onclick") || "");
      if (!id) return;
      definirBloqueioBotaoNormal(
        botao,
        !!donoReservaNormal(id) && !mesmaPessoa(donoReservaNormal(id), normalState.usuario.nome),
        donoReservaNormal(id)
      );
    });
    atualizarBotoesModalNormal();
  }

  function atualizarBotoesModalNormal() {
    const modal = document.querySelector("#ModalDespesas");
    if (!modal || !normalState.modalDespesaId) return;
    const owner = donoReservaNormal(normalState.modalDespesaId);
    const bloqueado = !!owner && !mesmaPessoa(owner, normalState.usuario.nome);
    modal.querySelectorAll('button[type="submit"], input[type="submit"]').forEach(function (botao) {
      definirBloqueioBotaoNormal(botao, bloqueado, owner);
    });
  }

  function statusReservaNormal(id, valor) {
    const tr = obterLinhaNormal(id);
    const status = tr ? tr.querySelector(".sigma-reserva-status") : null;
    if (status) status.textContent = valor || "";
  }

  async function removerReservaPaginaPrincipal(id) {
    id = texto(id);
    const ownerAnterior = donoReservaNormal(id);
    const tr = obterLinhaNormal(id);
    const select = tr ? tr.querySelector(".sigma-reserva-select") : null;

    atualizarUsuarioPaginaPrincipal();
    if (!id || !ownerAnterior) {
      atualizarLinhaPaginaPrincipal(id);
      return false;
    }
    if (!normalState.usuario.nome) {
      notificarPaginaPrincipal("error", "Não consegui identificar o usuário logado.");
      atualizarLinhaPaginaPrincipal(id);
      return false;
    }

    const pergunta = mesmaPessoa(ownerAnterior, normalState.usuario.nome)
      ? `Liberar a despesa ${id}?`
      : `Remover a reserva de ${ownerAnterior} na despesa ${id}?`;
    if (!window.confirm(pergunta)) {
      atualizarLinhaPaginaPrincipal(id);
      return false;
    }

    if (select) select.classList.add("sigma-salvando");
    statusReservaNormal(id, "...");

    try {
      const resultado = await liberarReservaFirebaseSeguro(
        id,
        normalState.usuario,
        { permitirOutro: true, donoEsperado: ownerAnterior }
      );
      aplicarResultadoReservaNormal(id, resultado);
      if (!resultado.ok) throw new Error(mensagemFalhaReserva(resultado));

      statusReservaNormal(id, "✓");
      setTimeout(function () { statusReservaNormal(id, ""); }, 1100);
      return true;
    } catch (falha) {
      statusReservaNormal(id, "!");
      notificarPaginaPrincipal("error", texto(falha.message || falha));
      return false;
    } finally {
      if (select) select.classList.remove("sigma-salvando");
      atualizarLinhaPaginaPrincipal(id);
    }
  }

  async function alterarReservaPaginaPrincipal(select) {
    const id = texto(select.dataset.sigmaId);
    const ownerAnterior = donoReservaNormal(id);
    const escolhido = texto(select.value);
    atualizarUsuarioPaginaPrincipal();

    if (!id || !normalState.usuario.nome) {
      notificarPaginaPrincipal("error", "Não consegui identificar o usuário logado.");
      atualizarOpcoesReservaNormal(select, ownerAnterior);
      return;
    }

    if (escolhido && mesmaPessoa(escolhido, ownerAnterior)) return;

    if (!escolhido) {
      await removerReservaPaginaPrincipal(id);
      return;
    }

    select.classList.add("sigma-salvando");
    statusReservaNormal(id, "...");

    try {
      if (mesmaPessoa(escolhido, normalState.usuario.nome)) {
        const assumirOutro = !!ownerAnterior && !mesmaPessoa(ownerAnterior, normalState.usuario.nome);
        if (assumirOutro && !window.confirm(
          `Esta despesa está com ${ownerAnterior}.\n\nAssumir para ${normalState.usuario.nome}?`
        )) return;

        const resultado = await reservarDespesaFirebaseSeguro(
          id,
          normalState.usuario,
          { permitirAssumir: assumirOutro, donoEsperado: ownerAnterior }
        );
        aplicarResultadoReservaNormal(id, resultado);
        if (!resultado.ok) throw new Error(mensagemFalhaReserva(resultado));
      }

      statusReservaNormal(id, "✓");
      setTimeout(function () { statusReservaNormal(id, ""); }, 1100);
    } catch (falha) {
      statusReservaNormal(id, "!");
      notificarPaginaPrincipal("error", texto(falha.message || falha));
    } finally {
      select.classList.remove("sigma-salvando");
      atualizarLinhaPaginaPrincipal(id);
    }
  }

  function aplicarResultadoReservaNormal(id, resultado) {
    if (!resultado) return;
    if (donoItemReserva(resultado.item)) {
      normalState.reservas[id] = resultado.item;
    } else {
      delete normalState.reservas[id];
    }
    atualizarLinhaPaginaPrincipal(id);
  }

  function mensagemFalhaReserva(resultado) {
    if (resultado && resultado.codigo === "ocupada") {
      return "Esta despesa está com " + (resultado.owner || "outro usuário") + ".";
    }
    if (resultado && resultado.codigo === "alterada") {
      return "A reserva mudou enquanto você trabalhava. A linha foi atualizada.";
    }
    return texto(resultado && resultado.mensagem) || "Não consegui atualizar a reserva no Firebase.";
  }

  function aplicarEventoReservaPaginaPrincipal(raw) {
    try {
      const evento = JSON.parse(raw || "{}");
      const caminho = String(evento.path || "");
      const data = evento.data;

      if (caminho === "/" || caminho === "") {
        normalState.reservas = data && typeof data === "object" ? data : {};
        normalState.recebeuPrimeiroEvento = true;
        normalState.linhasPorId.forEach(function (tr, id) {
          if (tr && tr.isConnected) atualizarLinhaPaginaPrincipal(id);
          else normalState.linhasPorId.delete(id);
        });
        atualizarTodosBotoesFinanceirosNormal();
        return;
      }

      const partes = caminho.replace(/^\/+/, "").split("/").filter(Boolean);
      const id = texto(partes[0]);
      if (!id) return;

      if (partes.length === 1) {
        if (data == null) delete normalState.reservas[id];
        else normalState.reservas[id] = data;
      } else {
        if (!normalState.reservas[id] || typeof normalState.reservas[id] !== "object") {
          normalState.reservas[id] = {};
        }
        if (data == null) delete normalState.reservas[id][partes[1]];
        else normalState.reservas[id][partes[1]] = data;
      }
      atualizarLinhaPaginaPrincipal(id);
    } catch (_) {}
  }

  function conectarRealtimePaginaPrincipal() {
    try {
      if (normalState.eventosReserva) normalState.eventosReserva.close();
      const es = new EventSource(firebaseUrl(CONFIG.firebaseReservas));
      es.addEventListener("put", function (evento) {
        aplicarEventoReservaPaginaPrincipal(evento.data);
      });
      es.addEventListener("patch", function (evento) {
        aplicarEventoReservaPaginaPrincipal(evento.data);
      });
      es.onerror = function () {};
      normalState.eventosReserva = es;
    } catch (falha) {
      console.warn(PREFIXO, "Realtime da página principal", falha);
    }
  }

  function observarPaginaPrincipal() {
    if (normalState.observer) normalState.observer.disconnect();
    let pendentes = [];
    let agendado = false;

    normalState.observer = new MutationObserver(function (mutacoes) {
      mutacoes.forEach(function (mutacao) {
        mutacao.addedNodes.forEach(function (no) {
          if (no && no.nodeType === 1) pendentes.push(no);
        });
      });

      if (agendado || !pendentes.length) return;
      agendado = true;
      requestAnimationFrame(function () {
        agendado = false;
        const atuais = pendentes;
        pendentes = [];
        atuais.forEach(processarLinhasPaginaPrincipal);
        restaurarTodosSelectsReservaNativos();
        atualizarBotoesModalNormal();
      });
    });

    normalState.observer.observe(document.body, { childList: true, subtree: true });
  }

  function ehBotaoFinanceiroNormal(el) {
    return !!(el && el.getAttribute && /\/backend\/despesas\/financeiro\/\d+/i.test(
      el.getAttribute("onclick") || el.dataset.sigmaFinanceUrl || ""
    ));
  }

  function tratarCliquePaginaPrincipal(evento) {
    const alvo = evento.target && evento.target.closest
      ? evento.target.closest("button, a")
      : null;
    if (!ehBotaoFinanceiroNormal(alvo)) return;

    evento.preventDefault();
    evento.stopPropagation();
    evento.stopImmediatePropagation();
    void abrirFinanceiroPaginaPrincipal(alvo);
  }

  async function abrirFinanceiroPaginaPrincipal(botao) {
    const id = idDespesaDeTexto(
      botao.getAttribute("onclick") || botao.dataset.sigmaFinanceUrl || ""
    ) || texto(botao.dataset.sigmaId);
    if (!id || normalState.abrindoIds.has(id)) return;

    normalState.abrindoIds.add(id);
    try {
      atualizarUsuarioPaginaPrincipal();
      if (!normalState.usuario.nome) {
        notificarPaginaPrincipal("error", "Não consegui identificar o usuário logado.");
        return;
      }

      const resultado = await reservarDespesaFirebaseSeguro(
        id,
        normalState.usuario,
        { permitirAssumir: false }
      );
      aplicarResultadoReservaNormal(id, resultado);
      if (!resultado.ok) {
        notificarPaginaPrincipal("warning", mensagemFalhaReserva(resultado));
        return;
      }

      normalState.modalDespesaId = id;
      executarAberturaFinanceiroNormal(botao);
    } catch (falha) {
      notificarPaginaPrincipal("error", "Não consegui reservar: " + texto(falha.message || falha));
    } finally {
      normalState.abrindoIds.delete(id);
    }
  }

  function executarAberturaFinanceiroNormal(botao) {
    const onclick = botao.getAttribute("onclick") || "";
    const match = onclick.match(/\.load\(['"]([^'"]+)['"]\)/i);
    const url = match ? match[1].replace(/&amp;/g, "&") : "";
    const root = paginaWindow();
    const $ = root.jQuery || root.$ || window.jQuery || window.$;

    if (url && $ && document.getElementById("ModalDespesas")) {
      $("#ModalDespesas").modal("show").find(".modal-body").load(url, function () {
        atualizarBotoesModalNormal();
      });
      return;
    }

    try {
      if (root && typeof root.eval === "function") root.eval(onclick);
      else new Function(onclick).call(botao);
    } catch (falha) {
      console.warn(PREFIXO, "Abertura do financeiro", falha);
    }
  }

  function idFormularioFinanceiroNormal(form) {
    if (!form) return "";
    const idPelaAcao = idDespesaDeTexto(form.getAttribute("action") || "");
    if (idPelaAcao) return idPelaAcao;
    if (form.closest && form.closest("#ModalDespesas")) return normalState.modalDespesaId;
    return "";
  }

  function tratarSubmitPaginaPrincipal(evento) {
    const form = evento.target;
    if (!form || !form.matches || !form.matches("form")) return;
    const id = idFormularioFinanceiroNormal(form);
    if (!id) return;

    if (form.dataset.sigmaReservaPermitirEnvio === "1") {
      form.dataset.sigmaReservaPermitirEnvio = "0";
      return;
    }

    evento.preventDefault();
    evento.stopPropagation();
    evento.stopImmediatePropagation();
    if (normalState.salvandoIds.has(id)) return;
    normalState.salvandoIds.add(id);
    const submitter = evento.submitter || null;

    atualizarUsuarioPaginaPrincipal();
    reservarDespesaFirebaseSeguro(id, normalState.usuario, { permitirAssumir: false })
      .then(function (resultado) {
        aplicarResultadoReservaNormal(id, resultado);
        if (!resultado.ok) {
          notificarPaginaPrincipal("warning", mensagemFalhaReserva(resultado));
          return;
        }
        form.dataset.sigmaReservaPermitirEnvio = "1";
        if (typeof form.requestSubmit === "function") {
          if (submitter) form.requestSubmit(submitter);
          else form.requestSubmit();
        } else {
          HTMLFormElement.prototype.submit.call(form);
        }
      })
      .catch(function (falha) {
        notificarPaginaPrincipal("error", "Não consegui confirmar a reserva: " + texto(falha.message || falha));
      })
      .finally(function () {
        normalState.salvandoIds.delete(id);
      });
  }

  function notificarPaginaPrincipal(tipo, mensagem) {
    const root = paginaWindow();
    const toastr = root.toastr || window.toastr;
    if (toastr && typeof toastr[tipo] === "function") {
      toastr[tipo](mensagem);
      return;
    }
    if (tipo === "error" || tipo === "warning") window.alert(mensagem);
  }

  // =========================================================
  // PREPARAR_DOCUMENTO_SEM_TELA_BRANCA
  // Para localizar depois, use CTRL + F e procure por:
  // PREPARAR_DOCUMENTO_SEM_TELA_BRANCA
  // =========================================================
  function ocultarPaginaOriginal() {
    try {
      document.documentElement.style.setProperty("visibility", "hidden", "important");
      document.documentElement.style.setProperty("background", "#eef2f7", "important");
    } catch (_) {}
  }

  function revelarDocumento() {
    try {
      document.documentElement.style.removeProperty("visibility");
      document.documentElement.style.setProperty("background", "#eef2f7", "important");
    } catch (_) {}
  }

  function esperarDocumentoDisponivel() {
    if (document.body && document.readyState !== "loading") {
      return Promise.resolve();
    }

    return new Promise(function (resolve) {
      const concluir = function () {
        if (document.body) {
          resolve();
          return;
        }
        setTimeout(concluir, 20);
      };

      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", concluir, { once: true });
      } else {
        concluir();
      }
    });
  }

  async function prepararPainel() {
    await esperarDocumentoDisponivel();
    montarDocumentoIndependente();
    revelarDocumento();

    atualizarStatus("Preparando os componentes do painel...");

    await incluirScript(
      "sigma-jquery-base",
      "/js/jquery-2.1.1.js",
      function () {
        const w = paginaWindow();
        return !!(w.jQuery && w.jQuery.fn);
      }
    );

    await incluirScript(
      "sigma-bootstrap-base",
      "/js/bootstrap.min.js",
      function () {
        const w = paginaWindow();
        return !!(w.jQuery && w.jQuery.fn && typeof w.jQuery.fn.modal === "function");
      }
    );

    await iniciarPainel();
  }

  // =========================================================
  // DOCUMENTO_INDEPENDENTE
  // Esta é uma página criada pelo Tampermonkey. O InfraDesk fica
  // apenas como fonte dos dados e como responsável por gravá-los.
  // =========================================================
  function montarDocumentoIndependente() {
    const html = `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Painel Financeiro • InfraDesk</title>
  <link rel="icon" href="https://cdn.infradesk.app/favicon.ico">
  <link rel="stylesheet" href="/css/bootstrap.min.css">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/select2/4.0.13/css/select2.min.css">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css">
  <style id="sigma-painel-financeiro-css">
    :root {
      --sigma-bg: #eef2f7;
      --sigma-card: #ffffff;
      --sigma-dark: #111c32;
      --sigma-dark-2: #192641;
      --sigma-border: #d8e0ea;
      --sigma-text: #172033;
      --sigma-muted: #64748b;
      --sigma-green: #12865d;
      --sigma-blue: #2563eb;
      --sigma-red: #dc2626;
      --sigma-yellow: #d97706;
    }

    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; }
    body {
      overflow: hidden;
      background: var(--sigma-bg);
      color: var(--sigma-text);
      font-family: Arial, Helvetica, sans-serif;
    }

    button, input, select { font: inherit; }

    /* Oculta somente o atalho criado por uma versão antiga do painel. */
    #sigma-abrir-painel-financeiro { display: none !important; }

    #sigma-app {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100vh;
      padding: 8px;
      gap: 7px;
    }

    .sigma-topo {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      min-height: 52px;
      padding: 8px 12px;
      border-radius: 12px;
      background: var(--sigma-dark);
      color: #fff;
      box-shadow: 0 8px 24px rgba(15, 23, 42, .18);
    }

    .sigma-marca {
      display: flex;
      align-items: center;
      min-width: 0;
      gap: 10px;
    }

    .sigma-marca-icone {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 36px;
      height: 36px;
      flex: 0 0 auto;
      border-radius: 10px;
      background: rgba(34, 197, 94, .17);
      color: #86efac;
      font-size: 18px;
    }

    .sigma-marca strong { display: block; font-size: 14px; line-height: 18px; }
    .sigma-marca small {
      display: block;
      overflow: hidden;
      max-width: 620px;
      color: #b8c5d8;
      font-size: 11px;
      line-height: 15px;
      white-space: nowrap;
      text-overflow: ellipsis;
    }

    .sigma-topo-acoes {
      display: flex;
      align-items: center;
      gap: 7px;
      flex: 0 0 auto;
    }

    .sigma-usuario {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      min-height: 31px;
      padding: 0 10px;
      border-radius: 999px;
      background: rgba(255, 255, 255, .09);
      color: #e5edf8;
      font-size: 11px;
      font-weight: 800;
    }

    .sigma-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 7px;
      height: 32px;
      padding: 0 11px;
      border: 1px solid rgba(255, 255, 255, .14);
      border-radius: 8px;
      background: rgba(255, 255, 255, .09);
      color: #fff;
      font-size: 11px;
      font-weight: 900;
      cursor: pointer;
    }

    .sigma-btn:hover { background: rgba(255, 255, 255, .16); }
    .sigma-btn:disabled { opacity: .48; cursor: wait; }

    .sigma-filtros {
      padding: 8px 10px;
      border: 1px solid var(--sigma-border);
      border-radius: 11px;
      background: var(--sigma-card);
      box-shadow: 0 5px 18px rgba(15, 23, 42, .06);
    }

    .sigma-filtros-linha {
      display: grid;
      grid-template-columns: minmax(240px, 2fr) repeat(5, minmax(130px, 1fr));
      gap: 7px;
      align-items: end;
    }

    .sigma-campo label {
      display: block;
      margin: 0 0 3px;
      color: #475569;
      font-size: 10px;
      font-weight: 900;
    }

    /* Os filtros do painel são propositalmente nativos.
       O InfraDesk tenta transformar qualquer SELECT em Select2; isso criava
       atraso, texto visual diferente do valor real e filtros aparentemente
       incorretos. No painel, Select2 fica reservado somente para o modal. */
    #sigma-app .sigma-filtros .select2-container {
      display: none !important;
    }
    #sigma-app .sigma-filtros select,
    #sigma-app .sigma-filtros select.select2-hidden-accessible {
      position: static !important;
      display: block !important;
      clip: auto !important;
      width: 100% !important;
      height: 32px !important;
      margin: 0 !important;
      overflow: visible !important;
      white-space: normal !important;
      opacity: 1 !important;
    }

    .sigma-campo input,
    .sigma-campo select {
      width: 100%;
      height: 32px;
      padding: 0 9px;
      border: 1px solid #cbd5e1;
      border-radius: 7px;
      background: #fff;
      color: #1e293b;
      outline: none;
      font-size: 11px;
    }

    .sigma-campo input:focus,
    .sigma-campo select:focus {
      border-color: #3b82f6;
      box-shadow: 0 0 0 3px rgba(59, 130, 246, .12);
    }

    .sigma-resumo {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      min-height: 36px;
      padding: 4px 8px;
      border: 1px solid var(--sigma-border);
      border-radius: 10px;
      background: #fff;
    }

    .sigma-chips { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .sigma-chip {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      min-height: 26px;
      padding: 0 9px;
      border: 1px solid #dbe3ec;
      border-radius: 999px;
      background: #f8fafc;
      color: #475569;
      font-size: 10px;
      font-weight: 900;
      cursor: pointer;
    }
    .sigma-chip:hover, .sigma-chip.ativo { border-color: #2563eb; background: #eff6ff; color: #1d4ed8; }
    .sigma-chip b { color: #0f172a; }

    #sigma-status-carregamento {
      color: #64748b;
      font-size: 10px;
      font-weight: 800;
      white-space: nowrap;
    }

    .sigma-grade-wrap {
      flex: 1 1 auto;
      min-height: 0;
      overflow: auto;
      border: 1px solid var(--sigma-border);
      border-radius: 11px;
      background: #fff;
      box-shadow: 0 7px 22px rgba(15, 23, 42, .07);
    }

    .sigma-grade {
      width: 100%;
      min-width: 1160px;
      border-collapse: separate;
      border-spacing: 0;
    }

    .sigma-grade thead th {
      position: sticky;
      top: 0;
      z-index: 20;
      padding: 9px 8px;
      border: 0;
      background: var(--sigma-dark);
      color: #fff;
      font-size: 10px;
      text-align: left;
      white-space: nowrap;
    }

    .sigma-grade tbody td {
      padding: 8px;
      border-top: 1px solid #e7edf4;
      color: #475569;
      font-size: 11px;
      vertical-align: middle;
    }

    .sigma-grade tbody tr.sigma-despesa:hover td { background: #f3f8ff; }
    .sigma-grade tbody tr.sigma-grupo td {
      position: sticky;
      top: 33px;
      z-index: 10;
      padding: 7px 10px;
      border-top: 1px solid #cbd5e1;
      background: #e9eff7;
      color: #172033;
      font-size: 11px;
      font-weight: 900;
    }

    .sigma-id p { display: inline; margin: 0; color: #172033; font-weight: 900; }
    .sigma-id small { display: block; margin-top: 2px; color: #7c8ba1; font-size: 9px; }
    .sigma-desc { max-width: 280px; color: #243247; font-weight: 700; }
    .sigma-fornecedor { max-width: 250px; }
    .sigma-tipo { white-space: nowrap; }
    .sigma-tipo-conteudo {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      min-width: 0;
    }
    .sigma-tipo-img {
      width: 25px;
      max-height: 25px;
      object-fit: contain;
      flex: 0 0 auto;
    }
    .sigma-tipo-texto {
      overflow: hidden;
      max-width: 150px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .sigma-tipo-extra {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      color: #7c3aed;
      font-size: 17px;
      flex: 0 0 auto;
    }
    .sigma-status-mini {
      display: inline-block;
      max-width: 112px;
      margin-top: 3px;
      padding: 2px 6px;
      overflow: hidden;
      border-radius: 999px;
      background: #e0f2fe;
      color: #075985;
      font-size: 8px;
      font-weight: 900;
      text-overflow: ellipsis;
      white-space: nowrap;
      vertical-align: middle;
    }
    .sigma-data { white-space: nowrap; font-weight: 800; }
    .sigma-data.vencida { color: #dc2626; }
    .sigma-data.hoje { color: #b45309; }
    .sigma-valor { white-space: nowrap; color: #172033; font-family: Georgia, serif; font-weight: 900; }

    .sigma-competencia {
      display: inline-flex;
      align-items: center;
      min-height: 23px;
      padding: 0 8px;
      border-radius: 999px;
      background: #e0e7ff;
      color: #3730a3;
      font-size: 10px;
      font-weight: 900;
      white-space: nowrap;
    }

    .sigma-owner {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      max-width: 150px;
      min-height: 24px;
      padding: 0 7px;
      border: 1px solid #cbd5e1;
      border-radius: 999px;
      background: #fff;
      color: #475569;
      font-size: 9px;
      font-weight: 900;
      white-space: nowrap;
    }

    .sigma-owner button {
      width: 17px;
      height: 17px;
      padding: 0;
      border: 0;
      border-radius: 50%;
      background: rgba(255,255,255,.28);
      color: inherit;
      line-height: 17px;
      cursor: pointer;
    }

    .sigma-owner button.sigma-owner-reservar {
      width: 19px;
      height: 19px;
      background: #2563eb;
      color: #fff;
      font-size: 15px;
      line-height: 18px;
      box-shadow: 0 2px 6px rgba(37,99,235,.28);
    }

    .sigma-owner button:hover:not(:disabled) {
      filter: brightness(1.08);
      transform: translateY(-1px);
    }

    .sigma-owner button:disabled {
      cursor: wait;
      opacity: .62;
    }

    .sigma-financeiro {
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
      width: 35px !important;
      min-width: 35px !important;
      height: 31px !important;
      padding: 0 !important;
      border: 0 !important;
      border-radius: 8px !important;
      background: var(--sigma-green) !important;
      color: #fff !important;
      font-size: 14px !important;
      cursor: pointer !important;
      box-shadow: 0 3px 9px rgba(18, 134, 93, .22) !important;
    }

    .sigma-financeiro:hover { background: #0b6b49 !important; }
    .sigma-financeiro:disabled,
    .sigma-financeiro.tm-finance-blocked {
      opacity: .35 !important;
      cursor: not-allowed !important;
      filter: grayscale(1) !important;
    }

    .sigma-observacoes td { padding: 3px 8px 7px 16px !important; background: #fff; }
    .sigma-observacao {
      display: inline-block;
      max-width: 100%;
      margin: 0 5px 3px 0;
      padding: 5px 8px;
      border-left: 4px solid #8b5cf6;
      border-radius: 6px;
      background: #f3e8ff;
      color: #6b21a8;
      font-size: 9px;
      line-height: 1.35;
    }

    .sigma-vazio,
    .sigma-loading {
      padding: 60px 20px !important;
      color: #64748b !important;
      text-align: center !important;
      font-size: 13px !important;
    }

    .sigma-loading i { margin-right: 8px; color: #12865d; }

    /* Proteção visual caso uma versão antiga ainda esteja ativa. */
    #sigma-app .tm-op-inline { display: none !important; }

    #ModalDespesas { z-index: 999990 !important; }
    body > .modal-backdrop { z-index: 999980 !important; }
    #ModalDespesas .modal-dialog {
      width: calc(100vw - 42px) !important;
      max-width: 1500px !important;
      margin: 16px auto !important;
    }
    #ModalDespesas .modal-content {
      position: relative !important;
      border: 0 !important;
      border-radius: 13px !important;
      overflow: hidden !important;
    }
    #ModalDespesas .modal-header {
      position: relative;
      display: flex;
      align-items: stretch;
      min-height: 54px;
      padding: 8px 58px 8px 10px;
      border: 0;
      border-bottom: 1px solid #d8c4f4;
      background: #f3e8ff;
      color: #5b21b6;
    }
    #ModalDespesas .sigma-modal-observacao {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      width: 100%;
      min-width: 0;
      padding: 8px 10px;
      border-left: 5px solid #8b5cf6;
      border-radius: 8px;
      background: #ead8ff;
      color: #5b21b6;
      font-size: 12px;
      font-weight: 800;
      line-height: 1.4;
      overflow-wrap: anywhere;
    }
    #ModalDespesas .sigma-modal-observacao i {
      flex: 0 0 auto;
      margin-top: 2px;
      color: #7c3aed;
      font-size: 14px;
    }
    #ModalDespesas .sigma-modal-observacao-texto { min-width: 0; }
    #ModalDespesas .sigma-modal-observacao-texto strong {
      display: inline;
      margin-right: 4px;
      color: #4c1d95;
    }
    #ModalDespesas .modal-header .close {
      position: absolute;
      top: 50%;
      right: 12px;
      display: inline-flex !important;
      align-items: center;
      justify-content: center;
      width: 36px;
      height: 36px;
      margin: 0 !important;
      padding: 0 !important;
      transform: translateY(-50%);
      border: 0;
      border-radius: 10px;
      background: #7c3aed;
      color: #fff;
      opacity: 1;
      text-shadow: none;
      font-size: 22px;
      line-height: 1;
    }
    #ModalDespesas .modal-header .close:hover { background: #5b21b6; }
    #ModalDespesas .modal-body {
      max-height: calc(100vh - 96px);
      overflow: auto;
      padding: 13px;
      background: #f7f9fc;
    }
    #ModalDespesas .btn-default { display: inline-block !important; }
    #ModalDespesas #btns-voltar { display: inline-flex !important; align-items: center; }
    #ModalDespesas .dropdown-menu { z-index: 1000100 !important; }
    #ModalDespesas .select2-container, #ModalDespesas .select2-dropdown { z-index: 1000200 !important; }
    #ModalDespesas #financeiro-observacao {
      border: 2px solid #8b5cf6 !important;
      background: #faf7ff !important;
      font-weight: 700 !important;
    }

    #sigma-modal-salvando {
      position: absolute;
      inset: 0;
      z-index: 1000300;
      display: none;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: rgba(15, 23, 42, .72);
      backdrop-filter: blur(2px);
    }
    #sigma-modal-salvando.ativo { display: flex; }
    #sigma-modal-salvando .sigma-salvando-card {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10px;
      min-width: 300px;
      max-width: 520px;
      padding: 22px 26px;
      border: 1px solid rgba(255,255,255,.18);
      border-radius: 14px;
      background: #ffffff;
      color: #172033;
      text-align: center;
      box-shadow: 0 24px 70px rgba(0,0,0,.34);
    }
    #sigma-modal-salvando .sigma-salvando-icone {
      color: #12865d;
      font-size: 34px;
    }
    #sigma-modal-salvando strong { font-size: 15px; }
    #sigma-modal-salvando small {
      color: #64748b;
      font-size: 11px;
      line-height: 1.45;
    }

    #sigma-toast {
      position: fixed;
      right: 18px;
      bottom: 18px;
      z-index: 2000000;
      display: none;
      max-width: 430px;
      padding: 11px 14px;
      border-radius: 10px;
      background: #0f172a;
      color: #fff;
      box-shadow: 0 14px 35px rgba(0,0,0,.27);
      font-size: 11px;
      font-weight: 800;
    }
    #sigma-toast.erro { background: #991b1b; }
    #sigma-toast.sucesso { background: #166534; }

    @media (max-width: 1450px) {
      .sigma-filtros-linha { grid-template-columns: minmax(230px, 2fr) repeat(3, minmax(130px, 1fr)); }
    }
  </style>
</head>
<body>
  <div id="sigma-app">
    <header class="sigma-topo">
      <div class="sigma-marca">
        <span class="sigma-marca-icone"><i class="fa-solid fa-money-check-dollar"></i></span>
        <span>
          <strong>Painel Financeiro Unificado</strong>
          <small>Fila leve carregada das páginas paginadas do InfraDesk • Competência pela emissão • v${CONFIG.versao}</small>
        </span>
      </div>
      <div class="sigma-topo-acoes">
        <span class="sigma-usuario" id="sigma-usuario"><i class="fa-solid fa-user"></i> Identificando usuário...</span>
        <button class="sigma-btn" id="sigma-atualizar" type="button"><i class="fa-solid fa-rotate"></i> Atualizar InfraDesk</button>
        <a class="sigma-btn" href="/backend/despesas" target="_blank" rel="noopener"><i class="fa-solid fa-arrow-up-right-from-square"></i> Tela original</a>
      </div>
    </header>

    <section class="sigma-filtros">
      <div class="sigma-filtros-linha">
        <div class="sigma-campo">
          <label>Buscar ID, documento, descrição ou fornecedor</label>
          <input id="sigma-busca" type="search" placeholder="Digite para filtrar instantaneamente...">
        </div>
        <div class="sigma-campo">
          <label>Competência</label>
          <select id="sigma-filtro-competencia"><option value="">Todas</option></select>
        </div>
        <div class="sigma-campo">
          <label>Fornecedor</label>
          <select id="sigma-filtro-fornecedor"><option value="">Todos</option></select>
        </div>
        <div class="sigma-campo">
          <label>Tipo de documento</label>
          <select id="sigma-filtro-tipo"><option value="">Todos</option></select>
        </div>
        <div class="sigma-campo">
          <label>Responsável</label>
          <select id="sigma-filtro-owner"><option value="">Todos</option></select>
        </div>
        <div class="sigma-campo">
          <label>Organizar por</label>
          <select id="sigma-organizacao">
            <option value="competencia">Competência → vencimento</option>
            <option value="fornecedor">Fornecedor → competência</option>
            <option value="tipo">Tipo → competência</option>
            <option value="responsavel">Responsável → competência</option>
            <option value="vencimento">Vencimento direto</option>
          </select>
        </div>
      </div>
    </section>

    <section class="sigma-resumo">
      <div class="sigma-chips">
        <button class="sigma-chip ativo" type="button" data-situacao="todas">Todas <b id="sigma-total">0</b></button>
        <button class="sigma-chip" type="button" data-situacao="livres">Livres + minhas <b id="sigma-livres">0</b></button>
        <button class="sigma-chip" type="button" data-situacao="minhas">Minhas <b id="sigma-minhas">0</b></button>
        <button class="sigma-chip" type="button" data-situacao="reservadas">Reservadas <b id="sigma-reservadas">0</b></button>
        <button class="sigma-chip" type="button" data-situacao="vencidas">Vencidas <b id="sigma-vencidas">0</b></button>
      </div>
      <span id="sigma-status-carregamento">Preparando painel...</span>
    </section>

    <main class="sigma-grade-wrap">
      <table class="sigma-grade" id="sigma-tabela">
        <thead>
          <tr>
            <th style="width:95px">Nº / Documento</th>
            <th>Descrição</th>
            <th>Fornecedor</th>
            <th style="width:145px">Tipo</th>
            <th style="width:105px">Competência</th>
            <th style="width:95px">Vencimento</th>
            <th style="width:105px">Valor</th>
            <th style="width:145px">Responsável</th>
            <th style="width:58px;text-align:center">Abrir</th>
          </tr>
        </thead>
        <tbody id="sigma-corpo-tabela">
          <tr><td colspan="9" class="sigma-loading"><i class="fa-solid fa-spinner fa-spin"></i> Carregando fila financeira...</td></tr>
        </tbody>
      </table>
    </main>
  </div>

  <div id="ModalDespesas" class="modal fade" tabindex="-1" role="dialog" aria-hidden="true">
    <div class="modal-dialog modal-xl" role="document">
      <div class="modal-content">
        <div class="modal-header">
          <div class="sigma-modal-observacao" id="sigma-modal-observacao">
            <i class="fa-solid fa-comment-dots"></i>
            <span class="sigma-modal-observacao-texto"><strong>Observação:</strong> Carregando...</span>
          </div>
          <button type="button" class="close" data-dismiss="modal" aria-label="Fechar" title="Fechar">&times;</button>
        </div>
        <div class="modal-body"><div class="sigma-loading"><i class="fa-solid fa-spinner fa-spin"></i> Aguardando despesa...</div></div>
        <div id="sigma-modal-salvando" aria-live="polite" aria-hidden="true">
          <div class="sigma-salvando-card">
            <i class="fa-solid fa-circle-notch fa-spin sigma-salvando-icone"></i>
            <strong id="sigma-salvando-titulo">Gravando no InfraDesk...</strong>
            <small id="sigma-salvando-detalhe">Aguarde a confirmação antes de fechar esta janela.</small>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div id="sigma-toast"></div>

  <script src="/js/jquery-2.1.1.js"></script>
  <script src="/js/bootstrap.min.js"></script>
</body>
</html>`;

    const novoDocumento = new DOMParser().parseFromString(html, "text/html");

    // Scripts inseridos com innerHTML não executam. Eles são carregados
    // explicitamente em prepararPainel(), com tratamento de erro.
    novoDocumento.querySelectorAll("script").forEach(function (script) {
      script.remove();
    });

    document.documentElement.lang = "pt-BR";
    document.title = "Painel Financeiro • InfraDesk";
    document.head.innerHTML = novoDocumento.head.innerHTML;
    document.body.className = "";
    document.body.removeAttribute("style");
    document.body.innerHTML = novoDocumento.body.innerHTML;
  }

  // =========================================================
  // UTILITARIOS
  // =========================================================
  function log(...args) {
    console.log(PREFIXO, ...args);
  }

  function texto(valor) {
    return String(valor == null ? "" : valor).replace(/\s+/g, " ").trim();
  }

  function normalizar(valor) {
    return texto(valor)
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
  }

  function escaparHtml(valor) {
    return String(valor == null ? "" : valor)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function escaparCss(valor) {
    if (window.CSS && typeof window.CSS.escape === "function") {
      return window.CSS.escape(String(valor == null ? "" : valor));
    }
    return String(valor == null ? "" : valor).replace(/["\\]/g, "\\$&");
  }

  function paginaWindow() {
    return typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
  }

  function esperar(condicao, limiteMs = 20000, intervalo = 60) {
    return new Promise(function (resolve, reject) {
      const inicio = Date.now();
      const verificar = function () {
        try {
          const valor = condicao();
          if (valor) {
            resolve(valor);
            return;
          }
        } catch (_) {}

        if (Date.now() - inicio > limiteMs) {
          reject(new Error("Tempo esgotado ao preparar a tela."));
          return;
        }
        setTimeout(verificar, intervalo);
      };
      verificar();
    });
  }

  function toast(mensagem, tipo = "") {
    const el = document.getElementById("sigma-toast");
    if (!el) return;
    el.textContent = mensagem;
    el.className = tipo;
    el.style.display = "block";
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () {
      el.style.display = "none";
    }, 4200);
  }

  function parseDataBr(valor) {
    const match = texto(valor).match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\b/);
    if (!match) return null;
    let ano = Number(match[3]);
    if (ano < 100) ano += 2000;
    const data = new Date(ano, Number(match[2]) - 1, Number(match[1]));
    if (Number.isNaN(data.getTime())) return null;
    return data;
  }

  function chaveCompetencia(data) {
    if (!data) return "Sem competência";
    return String(data.getMonth() + 1).padStart(2, "0") + "/" + data.getFullYear();
  }

  function chaveData(data) {
    return data ? data.getTime() : Number.MAX_SAFE_INTEGER;
  }

  function inicioHoje() {
    const agora = new Date();
    return new Date(agora.getFullYear(), agora.getMonth(), agora.getDate());
  }

  function diasPara(data) {
    if (!data) return null;
    const alvo = new Date(data.getFullYear(), data.getMonth(), data.getDate());
    return Math.round((alvo.getTime() - inicioHoje().getTime()) / 86400000);
  }

  function corUsuario(nome) {
    nome = texto(nome);
    if (!nome) return "#ffffff";
    if (CONFIG.coresUsuarios[nome]) return CONFIG.coresUsuarios[nome];
    let hash = 0;
    const key = normalizar(nome);
    for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
    return `hsl(${Math.abs(hash) % 360} 68% 44%)`;
  }

  function mesmaPessoa(a, b) {
    return normalizar(a) && normalizar(a) === normalizar(b);
  }

  // =========================================================
  // INICIALIZACAO
  // =========================================================
  async function iniciarPainel() {
    await esperar(function () {
      return document.body && paginaWindow().jQuery && paginaWindow().jQuery.fn;
    });

    configurarEventosDaTela();
    forcarFiltrosNativos();
    criarObservadorDoModal();

    // Antes da consulta restauramos somente o que já possui opções fixas:
    // organização, busca e situação. Os filtros dependentes dos dados
    // serão restaurados uma única vez após todas as páginas terminarem.
    restaurarPreferenciasPainel(true);

    // Cada conexão em tempo real já entrega o estado inicial completo.
    // Assim evitamos fazer um GET e baixar o mesmo conteúdo novamente
    // ao abrir o EventSource logo em seguida.
    await Promise.all([
      conectarRealtimeReservas(),
      conectarRealtimeEstados(),
      carregarTodasDespesas(),
    ]);

    // Estados finais servem apenas para retirar rapidamente da fila uma
    // gravação já confirmada. Registros antigos são limpos em um único PATCH
    // para o histórico temporário não crescer indefinidamente.
    void limparEstadosFirebaseExpirados();
    setTimeout(function () { void limparEstadosFirebaseExpirados(); }, 5000);

    reconstruirOpcoesFiltros();
    restaurarPreferenciasPainel(false);
    state.filtrosProntos = true;
    state.inicializando = false;

    // Reenvia em segundo plano qualquer conclusão que o InfraDesk confirmou,
    // mas cuja atualização do Firebase ficou pendente por falha de rede.
    agendarSincronizacaoFirebase(0);

    renderizar();
    state.renderPendente = false;
  }

  function forcarFiltrosNativos() {
    const filtros = document.querySelector("#sigma-app .sigma-filtros");
    if (!filtros) return;

    let agendado = false;
    const limparSelect2 = function () {
      if (state.destruindoSelect2) return;
      state.destruindoSelect2 = true;

      try {
        const root = paginaWindow();
        const $ = root.jQuery || root.$ || window.jQuery || window.$;

        filtros.querySelectorAll("select").forEach(function (select) {
          if ($ && $.fn && typeof $.fn.select2 === "function" && select.classList.contains("select2-hidden-accessible")) {
            try { $(select).select2("destroy"); } catch (_) {}
          }

          select.classList.remove("select2-hidden-accessible");
          select.removeAttribute("data-select2-id");
          select.removeAttribute("tabindex");
          select.removeAttribute("aria-hidden");
          select.style.removeProperty("position");
          select.style.removeProperty("width");

          const proximo = select.nextElementSibling;
          if (proximo && proximo.classList && proximo.classList.contains("select2")) {
            proximo.remove();
          }
        });

        filtros.querySelectorAll(".select2-container").forEach(function (container) {
          container.remove();
        });
      } finally {
        state.destruindoSelect2 = false;
      }
    };

    const agendarLimpeza = function () {
      if (agendado) return;
      agendado = true;
      requestAnimationFrame(function () {
        agendado = false;
        limparSelect2();
      });
    };

    limparSelect2();
    const observer = new MutationObserver(agendarLimpeza);
    observer.observe(filtros, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
  }

  function configurarEventosDaTela() {
    const ids = [
      "sigma-busca",
      "sigma-filtro-competencia",
      "sigma-filtro-fornecedor",
      "sigma-filtro-tipo",
      "sigma-filtro-owner",
      "sigma-organizacao",
    ];

    ids.forEach(function (id) {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener(id === "sigma-busca" ? "input" : "change", function () {
        if (!state.restaurandoPreferencias) salvarPreferenciasPainel();
        if (!state.filtrosProntos || state.carregando) return;
        if (id === "sigma-busca") {
          agendarRender(140);
        } else {
          agendarRender(0);
        }
      });
    });

    document.querySelectorAll("[data-situacao]").forEach(function (botao) {
      botao.addEventListener("click", function () {
        document.querySelectorAll("[data-situacao]").forEach(function (outro) {
          outro.classList.remove("ativo");
        });
        botao.classList.add("ativo");
        salvarPreferenciasPainel();
        renderizar();
      });
    });

    document.getElementById("sigma-atualizar").addEventListener("click", async function () {
      if (state.carregando) return;
      await carregarTodasDespesas();
      reconstruirOpcoesFiltros();
      restaurarPreferenciasPainel(false);
      renderizar();
    });

    document.addEventListener("click", function (evento) {
      const reservar = evento.target.closest("[data-reservar-id]");
      if (reservar) {
        evento.preventDefault();
        evento.stopPropagation();
        evento.stopImmediatePropagation();
        void reservarDiretoPainel(reservar);
        return;
      }

      const liberar = evento.target.closest("[data-liberar-id]");
      if (liberar) {
        evento.preventDefault();
        evento.stopPropagation();
        evento.stopImmediatePropagation();
        void liberarReserva(liberar.dataset.liberarId, liberar);
        return;
      }

      const financeiro = evento.target.closest(".sigma-financeiro");
      if (financeiro) {
        evento.preventDefault();
        evento.stopPropagation();
        evento.stopImmediatePropagation();
        const id = texto(financeiro.dataset.sigmaId);
        state.itemModal = state.despesas.find(function (item) { return item.id === id; }) || null;
        atualizarCabecalhoModal(state.itemModal);
        void abrirFinanceiroPainel(financeiro);
      }
    }, true);
  }

  // =========================================================
  // CARREGAR_FILA_PAGINADA
  // Usa a página normal /backend/despesas, que pagina em blocos.
  // Nenhuma dessas páginas é desenhada na tela.
  // =========================================================
  function montarUrlFonte(pagina) {
    const url = new URL("/backend/despesas", window.location.origin);
    const params = {
      setor_id: "",
      status: CONFIG.statusFilaFixo,
      tipo_data: "V",
      data_intervalo: `${CONFIG.periodoInicial} - ${CONFIG.periodoFinal}`,
      nfe_id: "",
      tipo_doc: "",
      descricao: "",
      departamento_setor_id: "",
      tipo: "",
      plano_conta_id: "",
      natureza_operacao_id: "",
      parcela: "",
      tipo_entrada: "",
      "show-descricao": "0",
      sort: "data_vencimento",
      direction: "asc",
    };
    Object.keys(params).forEach(function (chave) { url.searchParams.set(chave, params[chave]); });
    if (pagina > 1) url.searchParams.set("page", String(pagina));
    return url.toString();
  }

  async function carregarTodasDespesas() {
    state.carregando = true;
    const botao = document.getElementById("sigma-atualizar");
    botao.disabled = true;
    atualizarStatus("Carregando fila 6 • A Agendar Pgto...");
    document.getElementById("sigma-corpo-tabela").innerHTML =
      '<tr><td colspan="9" class="sigma-loading"><i class="fa-solid fa-spinner fa-spin"></i> Consultando o InfraDesk sem renderizar as páginas...</td></tr>';

    try {
      const primeira = await buscarPagina(1);
      instalarContextoUsuario(primeira.doc);

      const totalPaginas = obterTotalPaginas(primeira.doc);
      const mapa = new Map();
      primeira.itens.forEach(function (item) { mapa.set(item.id, item); });
      atualizarStatus(`Página 1 de ${totalPaginas} • ${mapa.size} despesas`);

      let proxima = 2;
      let concluidas = 1;
      const workers = [];
      const quantidadeWorkers = Math.min(CONFIG.paginasSimultaneas, Math.max(0, totalPaginas - 1));

      for (let w = 0; w < quantidadeWorkers; w++) {
        workers.push((async function () {
          while (true) {
            const pagina = proxima++;
            if (pagina > totalPaginas) return;
            const resultado = await buscarPagina(pagina);
            resultado.itens.forEach(function (item) { mapa.set(item.id, item); });
            concluidas++;
            atualizarStatus(`Carregando ${concluidas} de ${totalPaginas} páginas • ${mapa.size} despesas`);
          }
        })());
      }

      await Promise.all(workers);
      state.despesas = Array.from(mapa.values());
      atualizarStatus(`${state.despesas.length} despesas carregadas • ${totalPaginas} página(s) consultada(s)`);
      log("Fila carregada", state.despesas.length);
    } catch (falha) {
      console.error(PREFIXO, falha);
      atualizarStatus("Erro ao carregar a fila");
      toast("Não consegui carregar a fila do InfraDesk: " + texto(falha.message || falha), "erro");
    } finally {
      state.carregando = false;
      botao.disabled = false;
    }
  }

  async function buscarPagina(pagina) {
    const resposta = await fetch(montarUrlFonte(pagina), {
      credentials: "same-origin",
      cache: "no-store",
      headers: { "X-Requested-With": "SigmaPainelFinanceiro" },
    });
    if (!resposta.ok) throw new Error(`InfraDesk retornou HTTP ${resposta.status} na página ${pagina}.`);
    const html = await resposta.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    return { doc: doc, itens: extrairDespesas(doc) };
  }

  function localizarTabelaFinanceira(doc) {
    const linha = doc.querySelector("table tbody tr.tr-index:not(.expandir)");
    if (linha) return linha.closest("table");

    const botao = doc.querySelector('button[onclick*="/backend/despesas/financeiro/"]');
    return botao ? botao.closest("table") : null;
  }

  function obterTotalPaginas(doc) {
    const tabela = localizarTabelaFinanceira(doc);
    const textoPagina = texto(tabela && tabela.querySelector(".paginator") ? tabela.querySelector(".paginator").textContent : "");
    const match = textoPagina.match(/P[aá]gina\s+\d+\s+de\s+(\d+)/i);
    if (match) return Math.max(1, Number(match[1]) || 1);

    let maior = 1;
    (tabela ? tabela.querySelectorAll('.pagination a[href*="page="]') : []).forEach(function (a) {
      try {
        const pagina = Number(new URL(a.href, window.location.origin).searchParams.get("page") || 0);
        if (pagina > maior) maior = pagina;
      } catch (_) {}
    });
    return maior;
  }

  function extrairDespesas(doc) {
    const tabela = localizarTabelaFinanceira(doc);
    if (!tabela || !tabela.tBodies.length) return [];

    const itens = [];
    let observacoesPendentes = [];

    Array.from(tabela.tBodies[0].children).forEach(function (tr) {
      const alerta = tr.querySelector(".alert");
      const botao = tr.querySelector('button[onclick*="/backend/despesas/financeiro/"]');
      const principal = tr.classList.contains("tr-index") && !tr.classList.contains("expandir");

      if (!principal) {
        if (alerta) {
          const obs = texto(alerta.textContent);
          if (obs) observacoesPendentes.push(obs);
        }
        return;
      }

      const celulas = tr.children;
      if (celulas.length < 6) return;

      const id = texto(celulas[0].querySelector("p") ? celulas[0].querySelector("p").textContent : "");
      if (!/^\d+$/.test(id)) return;

      const descricao = texto(celulas[1].textContent);
      const tipo = texto(celulas[2].textContent);
      const imagemTipo = celulas[2].querySelector("img.icone-tipo-documento");
      const imagemTipoSrc = imagemTipo ? texto(imagemTipo.getAttribute("src")) : "";
      const marcadoresTipo = Array.from(celulas[2].querySelectorAll("i")).map(function (icone) {
        return {
          classes: classesIconeSeguras(icone.getAttribute("class") || ""),
          titulo: texto(icone.getAttribute("data-original-title") || icone.getAttribute("title") || ""),
        };
      }).filter(function (marcador) {
        return marcador.classes || marcador.titulo;
      });
      const fornecedorEl = celulas[3].querySelector("[data-original-title]");
      const fornecedor = texto((fornecedorEl && fornecedorEl.getAttribute("data-original-title")) || celulas[3].textContent);
      const datas = texto(celulas[4].textContent).match(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g) || [];
      const emissao = parseDataBr(datas[0] || "");
      const vencimento = parseDataBr(datas[1] || datas[0] || "");
      const valor = texto(celulas[5].textContent);
      const statusEl = celulas[0].querySelector(".badge");
      const statusTexto = texto(statusEl ? statusEl.textContent : "");
      const onclick = botao ? (botao.getAttribute("onclick") || "") : "";
      const urlMatch = onclick.match(/\.load\(['"]([^'"]+)['"]\)/i);
      const financeUrl = urlMatch ? urlMatch[1].replace(/&amp;/g, "&") : "";
      const linkChamado = tr.querySelector('a[href*="/backend/chamados/criar?despesa_id="]');
      const numeroDocumento = extrairNumeroDocumento(linkChamado ? linkChamado.getAttribute("href") : "");

      const item = {
        id: id,
        numeroDocumento: numeroDocumento,
        descricao: descricao,
        tipo: tipo,
        imagemTipoSrc: imagemTipoSrc,
        marcadoresTipo: marcadoresTipo,
        statusTexto: statusTexto,
        fornecedor: fornecedor,
        emissao: emissao,
        emissaoTexto: datas[0] || "",
        vencimento: vencimento,
        vencimentoTexto: datas[1] || datas[0] || "",
        competencia: chaveCompetencia(emissao),
        valor: valor,
        observacoes: observacoesPendentes.slice(),
        financeUrl: financeUrl,
      };
      item.busca = normalizar([
        item.id,
        item.numeroDocumento,
        item.descricao,
        item.tipo,
        item.statusTexto,
        item.fornecedor,
        item.valor,
        (item.marcadoresTipo || []).map(function (m) { return m.titulo; }).join(" "),
      ].join(" "));
      itens.push(item);
      observacoesPendentes = [];
    });

    return itens;
  }

  function classesIconeSeguras(valor) {
    return String(valor || "")
      .split(/\s+/)
      .filter(function (classe) {
        return /^(?:fa|fas|far|fal|fab|fa-solid|fa-regular|fa-brands|fa-[a-z0-9-]+)$/i.test(classe);
      })
      .join(" ");
  }

  function extrairNumeroDocumento(href) {
    if (!href) return "";
    try {
      const detalhes = new URL(href, window.location.origin).searchParams.get("detalhes") || "";
      const textoDetalhes = detalhes.replace(/<[^>]+>/g, " ").replace(/\|/g, " | ");
      const match = textoDetalhes.match(/Doc\s*N[º°o]?\s*:\s*([^|]+)/i);
      return texto(match ? match[1] : "");
    } catch (_) {
      return "";
    }
  }

  // =========================================================
  // CONTEXTO_DO_USUARIO
  // Identifica o usuário pela página real consultada no InfraDesk.
  // =========================================================
  function instalarContextoUsuario(doc) {
    const nomeEl = doc.querySelector(".profile-element strong.font-bold, .nav-header strong.font-bold");
    const setorEl = doc.querySelector(".profile-element small, .nav-header .text-muted small");
    let nome = texto(nomeEl ? nomeEl.textContent : "").replace(/[▾▼]/g, "").trim();
    const setor = texto(setorEl ? setorEl.textContent : "");
    const html = doc.documentElement ? doc.documentElement.innerHTML : "";
    const idMatch = html.match(/avatar_usuario_(\d+)|\/avatar\/(\d+)\//i);

    if (nome) state.usuario.nome = nome;
    state.usuario.setor = setor;
    state.usuario.id = idMatch ? texto(idMatch[1] || idMatch[2]) : "";

    try {
      if (state.usuario.nome) {
        localStorage.setItem("sigma-painel-financeiro-ultimo-usuario", state.usuario.nome);
      }
    } catch (_) {}

    document.documentElement.dataset.sigmaUsuarioLogado = state.usuario.nome;
    paginaWindow().__SIGMA_USUARIO_LOGADO__ = Object.assign({}, state.usuario);
    document.getElementById("sigma-usuario").innerHTML =
      `<i class="fa-solid fa-user"></i> ${escaparHtml(state.usuario.nome || "Usuário não identificado")}`;

    restaurarPreferenciasPainel(true);
  }

  // =========================================================
  // FIREBASE
  // Reserva: responsável atual por cada despesa.
  // Estado: registra conclusão ou retorno após o InfraDesk confirmar.
  // =========================================================
  function firebaseUrl(caminho) {
    return CONFIG.firebaseBase.replace(/\/+$/, "") + "/" + String(caminho).replace(/^\/+/, "") + ".json";
  }

  function gmRequest(opcoes) {
    return new Promise(function (resolve, reject) {
      const req = {
        method: opcoes.method || "GET",
        url: opcoes.url,
        headers: opcoes.headers || {},
        data: opcoes.data == null ? null : opcoes.data,
        timeout: opcoes.timeout || 30000,
        onload: resolve,
        onerror: function (erro) { reject(erro || new Error("Erro de rede")); },
        ontimeout: function () { reject(new Error("Tempo esgotado no Firebase")); },
      };

      if (typeof GM_xmlhttpRequest === "function") {
        GM_xmlhttpRequest(req);
        return;
      }
      if (typeof GM !== "undefined" && GM && typeof GM.xmlHttpRequest === "function") {
        const retorno = GM.xmlHttpRequest(req);
        if (retorno && typeof retorno.then === "function") retorno.then(resolve).catch(reject);
        return;
      }
      reject(new Error("GM_xmlhttpRequest não está disponível."));
    });
  }

  function donoReserva(id) {
    return donoReservaNoMapa(state.reservas, id);
  }

  // =========================================================
  // RESERVA_FIREBASE_SEGURA
  // Para localizar depois, use CTRL + F e procure por:
  // RESERVA_FIREBASE_SEGURA
  //
  // O ETag funciona como uma senha de versão do registro. Se duas pessoas
  // tentarem reservar ao mesmo tempo, somente a primeira grava. A segunda
  // recebe o responsável atualizado em vez de sobrescrevê-lo.
  // =========================================================
  function obterCabecalhoResposta(resposta, nome) {
    const procurado = String(nome || "").toLowerCase();
    const linhas = String(resposta && resposta.responseHeaders || "").split(/\r?\n/);
    for (const linha of linhas) {
      const posicao = linha.indexOf(":");
      if (posicao < 0) continue;
      if (linha.slice(0, posicao).trim().toLowerCase() === procurado) {
        return linha.slice(posicao + 1).trim();
      }
    }
    return "";
  }

  function parseJsonSeguro(valor, padrao) {
    try {
      return JSON.parse(valor || "");
    } catch (_) {
      return padrao;
    }
  }

  async function lerReservaComVersao(id) {
    const resposta = await gmRequest({
      method: "GET",
      url: firebaseUrl(CONFIG.firebaseReservas + "/" + encodeURIComponent(id)),
      headers: {
        "Accept": "application/json",
        "X-Firebase-ETag": "true",
      },
      timeout: 12000,
    });

    if (!resposta || resposta.status < 200 || resposta.status >= 300) {
      throw new Error("Firebase não confirmou a leitura da reserva.");
    }

    return {
      item: parseJsonSeguro(resposta.responseText || "null", null),
      etag: obterCabecalhoResposta(resposta, "etag"),
    };
  }

  function payloadReserva(usuario) {
    const payload = {
      operador: texto(usuario && usuario.nome),
      ts: Date.now(),
    };
    const usuarioId = texto(usuario && usuario.id);
    if (usuarioId) payload.usuarioId = usuarioId;
    return payload;
  }

  async function reservarDespesaFirebaseSeguro(id, usuario, opcoes) {
    id = texto(id);
    opcoes = opcoes || {};
    const nome = texto(usuario && usuario.nome);
    if (!id || !nome) {
      return { ok: false, codigo: "usuario", mensagem: "Não consegui identificar o usuário logado." };
    }

    for (let tentativa = 0; tentativa < 3; tentativa++) {
      const leitura = await lerReservaComVersao(id);
      const owner = donoItemReserva(leitura.item);

      if (opcoes.donoEsperado != null && normalizar(owner) !== normalizar(opcoes.donoEsperado)) {
        return { ok: false, codigo: "alterada", owner: owner, item: leitura.item };
      }

      if (owner && mesmaPessoa(owner, nome)) {
        // Já é minha: nenhuma nova escrita, nenhum timestamp desnecessário.
        return { ok: true, codigo: "ja_minha", owner: owner, item: leitura.item };
      }

      if (owner && !opcoes.permitirAssumir) {
        return { ok: false, codigo: "ocupada", owner: owner, item: leitura.item };
      }

      const payload = payloadReserva(usuario);
      const headers = { "Content-Type": "application/json" };
      if (leitura.etag) headers["If-Match"] = leitura.etag;

      const resposta = await gmRequest({
        method: "PUT",
        url: firebaseUrl(CONFIG.firebaseReservas + "/" + encodeURIComponent(id)),
        headers: headers,
        data: JSON.stringify(payload),
        timeout: 12000,
      });

      if (resposta && resposta.status === 412) continue;
      if (!resposta || resposta.status < 200 || resposta.status >= 300) {
        throw new Error("Firebase não confirmou a reserva.");
      }
      return { ok: true, codigo: owner ? "assumida" : "reservada", owner: nome, item: payload };
    }

    const atual = await lerReservaComVersao(id);
    const ownerAtual = donoItemReserva(atual.item);
    return { ok: false, codigo: "alterada", owner: ownerAtual, item: atual.item };
  }

  async function liberarReservaFirebaseSeguro(id, usuario, opcoes) {
    id = texto(id);
    opcoes = opcoes || {};
    if (!id) return { ok: false, codigo: "id", mensagem: "Despesa inválida." };

    for (let tentativa = 0; tentativa < 3; tentativa++) {
      const leitura = await lerReservaComVersao(id);
      const owner = donoItemReserva(leitura.item);

      if (!owner) return { ok: true, codigo: "ja_livre", owner: "", item: null };
      if (opcoes.donoEsperado != null && normalizar(owner) !== normalizar(opcoes.donoEsperado)) {
        return { ok: false, codigo: "alterada", owner: owner, item: leitura.item };
      }

      const nomeAtual = texto(usuario && usuario.nome);
      if (!opcoes.permitirOutro && (!nomeAtual || !mesmaPessoa(owner, nomeAtual))) {
        return { ok: false, codigo: "ocupada", owner: owner, item: leitura.item };
      }

      const headers = {};
      if (leitura.etag) headers["If-Match"] = leitura.etag;
      const resposta = await gmRequest({
        method: "DELETE",
        url: firebaseUrl(CONFIG.firebaseReservas + "/" + encodeURIComponent(id)),
        headers: headers,
        timeout: 12000,
      });

      if (resposta && resposta.status === 412) continue;
      if (!resposta || resposta.status < 200 || resposta.status >= 300) {
        throw new Error("Firebase não confirmou a liberação.");
      }
      return { ok: true, codigo: "liberada", owner: "", item: null };
    }

    const atual = await lerReservaComVersao(id);
    const ownerAtual = donoItemReserva(atual.item);
    return { ok: false, codigo: "alterada", owner: ownerAtual, item: atual.item };
  }

  function aplicarResultadoReservaPainel(id, resultado) {
    if (!resultado) return;
    if (donoItemReserva(resultado.item)) {
      state.reservas[id] = resultado.item;
    } else {
      delete state.reservas[id];
    }
    state.reservandoIds.delete(id);
    renderizar();
  }

  async function reservarDiretoPainel(botao) {
    const id = texto(botao && botao.dataset.reservarId);
    if (!id || state.reservandoIds.has(id)) return;

    state.reservandoIds.add(id);
    botao.disabled = true;

    try {
      if (!state.usuario.nome) {
        throw new Error("Não consegui identificar o usuário logado.");
      }

      const resultado = await reservarDespesaFirebaseSeguro(
        id,
        state.usuario,
        { permitirAssumir: false }
      );
      aplicarResultadoReservaPainel(id, resultado);

      if (!resultado.ok) {
        toast(mensagemFalhaReserva(resultado), "erro");
        return;
      }

      toast(`Despesa ${id} reservada para ${state.usuario.nome}.`, "sucesso");
    } catch (falha) {
      toast("Não consegui reservar: " + texto(falha.message || falha), "erro");
    } finally {
      state.reservandoIds.delete(id);
      if (botao.isConnected) botao.disabled = false;
    }
  }

  async function liberarReserva(id, botao) {
    if (!id || state.reservandoIds.has(id)) return;
    const dono = donoReserva(id);
    if (!dono) return;
    const mensagem = mesmaPessoa(dono, state.usuario.nome)
      ? `Liberar a despesa ${id}?`
      : `Remover a reserva de ${dono} na despesa ${id}?`;
    if (!window.confirm(mensagem)) return;

    state.reservandoIds.add(id);
    if (botao) botao.disabled = true;

    try {
      const resultado = await liberarReservaFirebaseSeguro(
        id,
        state.usuario,
        { permitirOutro: true, donoEsperado: dono }
      );
      aplicarResultadoReservaPainel(id, resultado);
      if (!resultado.ok) throw new Error(mensagemFalhaReserva(resultado));
      toast(`Despesa ${id} liberada.`, "sucesso");
    } catch (falha) {
      toast("Não consegui liberar: " + texto(falha.message || falha), "erro");
    } finally {
      state.reservandoIds.delete(id);
      if (botao && botao.isConnected) botao.disabled = false;
    }
  }

  async function abrirFinanceiroPainel(botao) {
    const id = texto(botao && botao.dataset.sigmaId);
    if (!id || state.abrindoIds.has(id)) return;

    state.abrindoIds.add(id);
    botao.disabled = true;

    try {
      if (!state.usuario.nome) {
        throw new Error("Não consegui identificar o usuário logado.");
      }

      const resultado = await reservarDespesaFirebaseSeguro(
        id,
        state.usuario,
        { permitirAssumir: false }
      );

      aplicarResultadoReservaPainel(id, resultado);

      if (!resultado.ok) {
        toast(mensagemFalhaReserva(resultado), "erro");
        return;
      }

      const item = state.despesas.find(function (despesa) { return despesa.id === id; })
        || state.itemModal;
      if (!item || !item.financeUrl) {
        throw new Error("O InfraDesk não informou o endereço do formulário financeiro.");
      }

      state.itemModal = item;
      atualizarCabecalhoModal(item);
      agendarRender(0);

      garantirDependenciasModal().catch(function (falha) {
        console.warn(PREFIXO, "Dependência do modal", falha);
      });

      const $ = paginaWindow().jQuery;
      const modal = $("#ModalDespesas");
      modal.modal("show");
      modal.find(".modal-body")
        .html('<div class="sigma-loading"><i class="fa-solid fa-spinner fa-spin"></i> Carregando formulário financeiro...</div>')
        .load(item.financeUrl, function () {
          void processarFormularioModal();
        });
    } catch (falha) {
      toast("Não consegui abrir o financeiro: " + texto(falha.message || falha), "erro");
    } finally {
      state.abrindoIds.delete(id);
      if (botao.isConnected) {
        const owner = donoReserva(id);
        botao.disabled = !!owner && !mesmaPessoa(owner, state.usuario.nome);
      }
    }
  }

  // =========================================================
  // SINCRONIZACAO_FINAL_COM_FIREBASE
  // O InfraDesk é a fonte principal da verdade. Depois que ele confirma,
  // a despesa sai da tela imediatamente. O Firebase é sincronizado em
  // segundo plano e nunca transforma uma gravação já concluída em erro.
  // =========================================================
  const CHAVE_PENDENCIAS_FIREBASE = "sigma-painel-financeiro-pendencias-firebase-v1";

  function carregarPendenciasFirebase() {
    try {
      const valor = JSON.parse(localStorage.getItem(CHAVE_PENDENCIAS_FIREBASE) || "{}");
      return valor && typeof valor === "object" ? valor : {};
    } catch (_) {
      return {};
    }
  }

  function salvarPendenciasFirebase(pendencias) {
    try {
      localStorage.setItem(CHAVE_PENDENCIAS_FIREBASE, JSON.stringify(pendencias || {}));
    } catch (_) {}
  }

  function criarPayloadEstadoFinal(item, resetar) {
    return {
      status: resetar ? "retornada" : "concluida",
      etapa: resetar || "",
      usuario: state.usuario.nome || "",
      login: state.usuario.login || "",
      ts: Date.now(),
      competencia: item ? item.competencia : "",
      fornecedor: item ? item.fornecedor : "",
      tipo_documento: item ? item.tipo : "",
      valor: item ? item.valor : "",
    };
  }

  function guardarPendenciaFirebase(id, payload) {
    const pendencias = carregarPendenciasFirebase();
    pendencias[id] = {
      payload: payload,
      tentativas: Number(pendencias[id] && pendencias[id].tentativas || 0),
      atualizadoEm: Date.now(),
    };
    salvarPendenciasFirebase(pendencias);
  }

  function removerPendenciaFirebase(id) {
    const pendencias = carregarPendenciasFirebase();
    if (!Object.prototype.hasOwnProperty.call(pendencias, id)) return;
    delete pendencias[id];
    salvarPendenciasFirebase(pendencias);
  }

  async function sincronizarUmaPendenciaFirebase(id, registro) {
    const payload = registro && registro.payload ? registro.payload : registro;
    if (!id || !payload) return false;

    // Primeiro registra o estado final. Enquanto isso não acontecer,
    // mantemos a reserva no Firebase para ninguém abrir uma linha antiga.
    const respostaEstado = await gmRequest({
      method: "PUT",
      url: firebaseUrl(CONFIG.firebaseEstadoPainel + "/" + encodeURIComponent(id)),
      headers: { "Content-Type": "application/json" },
      data: JSON.stringify(payload),
      timeout: 12000,
    });

    if (!respostaEstado || respostaEstado.status < 200 || respostaEstado.status >= 300) {
      throw new Error("Firebase não confirmou o estado final.");
    }

    const resultadoReserva = await liberarReservaFirebaseSeguro(
      id,
      state.usuario,
      { permitirOutro: false }
    );

    // Se outra pessoa assumiu depois da conclusão, nunca apagamos a reserva
    // dela. O estado final já foi salvo e continuará ocultando a linha antiga.
    if (!resultadoReserva.ok && resultadoReserva.codigo !== "ocupada") {
      throw new Error(mensagemFalhaReserva(resultadoReserva));
    }

    state.estados[id] = payload;
    if (donoItemReserva(resultadoReserva.item)) {
      state.reservas[id] = resultadoReserva.item;
    } else {
      delete state.reservas[id];
    }
    removerPendenciaFirebase(id);
    return true;
  }

  function agendarSincronizacaoFirebase(atraso) {
    if (state.firebaseRetryTimer) clearTimeout(state.firebaseRetryTimer);
    state.firebaseRetryTimer = setTimeout(function () {
      state.firebaseRetryTimer = null;
      void sincronizarPendenciasFirebase();
    }, Math.max(0, Number(atraso || 0)));
  }

  async function sincronizarPendenciasFirebase() {
    if (state.sincronizandoFirebase) return;

    const pendencias = carregarPendenciasFirebase();
    const ids = Object.keys(pendencias);
    if (!ids.length) return;

    state.sincronizandoFirebase = true;
    try {
      for (const id of ids) {
        try {
          await sincronizarUmaPendenciaFirebase(id, pendencias[id]);
        } catch (falha) {
          const atuais = carregarPendenciasFirebase();
          if (atuais[id]) {
            atuais[id].tentativas = Number(atuais[id].tentativas || 0) + 1;
            atuais[id].atualizadoEm = Date.now();
            salvarPendenciasFirebase(atuais);
          }
          console.warn(PREFIXO, `Sincronização Firebase pendente para a despesa ${id}.`, falha);
        }
      }
    } finally {
      state.sincronizandoFirebase = false;

      const restantes = carregarPendenciasFirebase();
      const registros = Object.values(restantes);
      if (registros.length) {
        const maiorTentativa = registros.reduce(function (maior, registro) {
          return Math.max(maior, Number(registro && registro.tentativas || 0));
        }, 0);
        const proximoAtraso = Math.min(
          5 * 60 * 1000,
          15000 * Math.pow(2, Math.min(maiorTentativa, 4))
        );
        agendarSincronizacaoFirebase(proximoAtraso);
      }
    }
  }

  function gravarEstadoFinal(item, resetar) {
    if (!item || !item.id) return null;

    const payload = criarPayloadEstadoFinal(item, resetar);

    // Atualiza a tela imediatamente após a confirmação do InfraDesk.
    // A sincronização remota é idempotente e será repetida até funcionar.
    state.estados[item.id] = payload;
    delete state.reservas[item.id];
    guardarPendenciaFirebase(item.id, payload);
    agendarSincronizacaoFirebase(0);

    return payload;
  }

  function conectarRealtimeReservas() {
    return conectarRealtimePainel(
      CONFIG.firebaseReservas,
      state.reservas,
      "eventosReserva",
      "reservas"
    );
  }

  function conectarRealtimeEstados() {
    return conectarRealtimePainel(
      CONFIG.firebaseEstadoPainel,
      state.estados,
      "eventosEstado",
      "estados"
    );
  }

  function conectarRealtimePainel(caminho, alvo, propriedade, rotulo) {
    return new Promise(function (resolve) {
      let resolvido = false;
      const concluir = function () {
        if (resolvido) return;
        resolvido = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(concluir, 4000);

      try {
        if (state[propriedade]) state[propriedade].close();
        const es = new EventSource(firebaseUrl(caminho));
        const receber = function (evento) {
          aplicarEventoFirebase(evento.data, alvo);
          concluir();
        };
        es.addEventListener("put", receber);
        es.addEventListener("patch", receber);
        es.onerror = function () {};
        state[propriedade] = es;
      } catch (falha) {
        console.warn(PREFIXO, "Realtime " + rotulo, falha);
        concluir();
      }
    });
  }

  function aplicarEventoFirebase(raw, alvo) {
    try {
      const evento = JSON.parse(raw || "{}");
      const caminho = String(evento.path || "");
      const data = evento.data;
      if (caminho === "/" || caminho === "") {
        Object.keys(alvo).forEach(function (k) { delete alvo[k]; });
        if (data && typeof data === "object") Object.assign(alvo, data);
      } else {
        const partes = caminho.replace(/^\/+/, "").split("/").filter(Boolean);
        const id = partes[0];
        if (!id) return;
        if (partes.length === 1) {
          if (data == null) delete alvo[id]; else alvo[id] = data;
        } else {
          if (!alvo[id] || typeof alvo[id] !== "object") alvo[id] = {};
          if (data == null) delete alvo[id][partes[1]]; else alvo[id][partes[1]] = data;
        }
      }
      if (!state.inicializando && state.filtrosProntos) {
        atualizarOpcoesResponsavel();
        agendarRender(60);
      } else {
        state.renderPendente = true;
      }
    } catch (_) {}
  }

  function estaFinalizadaRecentemente(id) {
    const registro = state.estados[id];
    if (!registro || typeof registro !== "object") return false;
    const ts = Number(registro.ts || 0);
    if (!ts || Date.now() - ts > CONFIG.validadeEstadoFinalMs) return false;
    return registro.status === "concluida" || registro.status === "retornada";
  }

  async function limparEstadosFirebaseExpirados() {
    const chaveUltimaLimpeza = "sigma-painel-financeiro-limpeza-estados-v1";
    const agora = Date.now();

    try {
      const ultima = Number(localStorage.getItem(chaveUltimaLimpeza) || 0);
      if (ultima && agora - ultima < 6 * 60 * 60 * 1000) return;
    } catch (_) {}

    // Mantém uma margem adicional além das 12 horas usadas pela interface.
    const limite = agora - Math.max(CONFIG.validadeEstadoFinalMs * 2, 24 * 60 * 60 * 1000);
    const patch = {};

    Object.keys(state.estados).forEach(function (id) {
      const registro = state.estados[id];
      const ts = Number(registro && registro.ts || 0);
      if (ts && ts < limite) patch[id] = null;
    });

    const ids = Object.keys(patch);
    if (!ids.length) {
      if (Object.keys(state.estados).length) {
        try { localStorage.setItem(chaveUltimaLimpeza, String(agora)); } catch (_) {}
      }
      return;
    }

    try {
      const resposta = await gmRequest({
        method: "PATCH",
        url: firebaseUrl(CONFIG.firebaseEstadoPainel),
        headers: { "Content-Type": "application/json" },
        data: JSON.stringify(patch),
        timeout: 15000,
      });
      if (!resposta || resposta.status < 200 || resposta.status >= 300) return;

      ids.forEach(function (id) { delete state.estados[id]; });
      try { localStorage.setItem(chaveUltimaLimpeza, String(agora)); } catch (_) {}
    } catch (falha) {
      console.warn(PREFIXO, "Limpeza dos estados temporários", falha);
    }
  }

  // =========================================================
  // FILTROS_E_ORGANIZACAO
  // =========================================================
  function valorFiltro(id) {
    const el = document.getElementById(id);
    return el ? texto(el.value) : "";
  }

  function situacaoAtual() {
    const ativo = document.querySelector("[data-situacao].ativo");
    return ativo ? ativo.dataset.situacao : "todas";
  }

  function despesasVisiveis() {
    const busca = normalizar(valorFiltro("sigma-busca"));
    const competencia = valorFiltro("sigma-filtro-competencia");
    const fornecedor = valorFiltro("sigma-filtro-fornecedor");
    const tipo = valorFiltro("sigma-filtro-tipo");
    const ownerFiltro = valorFiltro("sigma-filtro-owner");
    const situacao = situacaoAtual();

    return state.despesas.filter(function (item) {
      if (estaFinalizadaRecentemente(item.id)) return false;
      const owner = donoReserva(item.id);
      const dias = diasPara(item.vencimento);

      if (busca && !item.busca.includes(busca)) return false;
      if (competencia && item.competencia !== competencia) return false;
      if (fornecedor && item.fornecedor !== fornecedor) return false;
      if (tipo && item.tipo !== tipo) return false;
      if (ownerFiltro === "__livre__" && owner) return false;
      if (ownerFiltro && ownerFiltro !== "__livre__" && owner !== ownerFiltro) return false;

      // Para o usuário que está trabalhando, "Livres" significa:
      // despesas sem responsável + despesas já assumidas por ele próprio.
      if (situacao === "livres" && owner && !mesmaPessoa(owner, state.usuario.nome)) return false;
      if (situacao === "minhas" && !mesmaPessoa(owner, state.usuario.nome)) return false;
      if (situacao === "reservadas" && !owner) return false;
      if (situacao === "vencidas" && !(dias != null && dias < 0)) return false;
      return true;
    });
  }

  function reconstruirOpcoesFiltros() {
    preencherSelect("sigma-filtro-competencia", state.despesas.map(function (i) { return i.competencia; }), "Todas", ordenarCompetencias);
    preencherSelectFornecedorComContagem();
    preencherSelect("sigma-filtro-tipo", state.despesas.map(function (i) { return i.tipo; }), "Todos");
    atualizarOpcoesResponsavel();
  }

  // =========================================================
  // CONTAGEM_NO_FILTRO_FORNECEDOR
  // Mostra FORNECEDOR (10), mas mantém o VALUE somente com o nome.
  // A contagem respeita os demais filtros ativos e ignora apenas a
  // seleção atual de fornecedor.
  // =========================================================
  function despesasParaContagemFornecedor() {
    const busca = normalizar(valorFiltro("sigma-busca"));
    const competencia = valorFiltro("sigma-filtro-competencia");
    const tipo = valorFiltro("sigma-filtro-tipo");
    const ownerFiltro = valorFiltro("sigma-filtro-owner");
    const situacao = situacaoAtual();

    return state.despesas.filter(function (item) {
      if (estaFinalizadaRecentemente(item.id)) return false;
      const owner = donoReserva(item.id);
      const dias = diasPara(item.vencimento);

      if (busca && !item.busca.includes(busca)) return false;
      if (competencia && item.competencia !== competencia) return false;
      if (tipo && item.tipo !== tipo) return false;
      if (ownerFiltro === "__livre__" && owner) return false;
      if (ownerFiltro && ownerFiltro !== "__livre__" && owner !== ownerFiltro) return false;
      if (situacao === "livres" && owner && !mesmaPessoa(owner, state.usuario.nome)) return false;
      if (situacao === "minhas" && !mesmaPessoa(owner, state.usuario.nome)) return false;
      if (situacao === "reservadas" && !owner) return false;
      if (situacao === "vencidas" && !(dias != null && dias < 0)) return false;
      return true;
    });
  }

  function preencherSelectFornecedorComContagem() {
    const select = document.getElementById("sigma-filtro-fornecedor");
    if (!select) return;

    const atual = select.value;
    const itens = despesasParaContagemFornecedor();
    const contagens = new Map();

    itens.forEach(function (item) {
      const nome = texto(item.fornecedor) || "Sem fornecedor";
      contagens.set(nome, (contagens.get(nome) || 0) + 1);
    });

    const nomes = Array.from(contagens.keys()).sort(function (a, b) {
      return a.localeCompare(b, "pt-BR");
    });

    select.innerHTML = `<option value="">Todos (${itens.length})</option>` + nomes.map(function (nome) {
      return `<option value="${escaparHtml(nome)}">${escaparHtml(nome)} (${contagens.get(nome) || 0})</option>`;
    }).join("");

    if (Array.from(select.options).some(function (option) { return option.value === atual; })) {
      select.value = atual;
    }
  }

  function atualizarOpcoesResponsavel() {
    const selectOwner = document.getElementById("sigma-filtro-owner");
    if (!selectOwner) return;

    const atual = selectOwner.value;
    const owners = Object.keys(state.reservas).map(donoReserva).filter(Boolean);
    const unicos = Array.from(new Set(owners)).sort(function (a, b) { return a.localeCompare(b, "pt-BR"); });
    selectOwner.innerHTML = '<option value="">Todos</option><option value="__livre__">Sem usuário</option>' +
      unicos.map(function (nome) { return `<option value="${escaparHtml(nome)}">${escaparHtml(nome)}</option>`; }).join("");
    if (Array.from(selectOwner.options).some(function (o) { return o.value === atual; })) {
      selectOwner.value = atual;
    }
  }

  function preencherSelect(id, valores, textoTodos, comparador) {
    const select = document.getElementById(id);
    const atual = select.value;
    const unicos = Array.from(new Set(valores.filter(Boolean)));
    unicos.sort(comparador || function (a, b) { return a.localeCompare(b, "pt-BR"); });
    select.innerHTML = `<option value="">${textoTodos}</option>` + unicos.map(function (v) {
      return `<option value="${escaparHtml(v)}">${escaparHtml(v)}</option>`;
    }).join("");
    if (Array.from(select.options).some(function (o) { return o.value === atual; })) select.value = atual;
  }

  function ordenarCompetencias(a, b) {
    const converter = function (v) {
      const m = String(v).match(/^(\d{2})\/(\d{4})$/);
      return m ? Number(m[2]) * 100 + Number(m[1]) : 999999;
    };
    return converter(a) - converter(b);
  }

  // =========================================================
  // PREFERENCIAS_LOCAIS_POR_USUARIO
  // Guarda todos os campos, a organização e o chip selecionado.
  // Para localizar depois, use CTRL + F e procure por:
  // PREFERENCIAS_LOCAIS_POR_USUARIO
  // =========================================================
  function nomeUsuarioPreferencias() {
    if (state.usuario.nome) return state.usuario.nome;
    try {
      return localStorage.getItem("sigma-painel-financeiro-ultimo-usuario") || "usuario";
    } catch (_) {
      return "usuario";
    }
  }

  function chavePreferenciasPainel() {
    return "sigma-painel-financeiro-filtros-v1:" + normalizar(nomeUsuarioPreferencias());
  }

  function lerPreferenciasPainel() {
    try {
      const bruto = localStorage.getItem(chavePreferenciasPainel());
      const dados = bruto ? JSON.parse(bruto) : null;
      return dados && typeof dados === "object" ? dados : {};
    } catch (_) {
      return {};
    }
  }

  function salvarPreferenciasPainel() {
    if (state.restaurandoPreferencias) return;

    const dados = {
      busca: valorFiltro("sigma-busca"),
      competencia: valorFiltro("sigma-filtro-competencia"),
      fornecedor: valorFiltro("sigma-filtro-fornecedor"),
      tipo: valorFiltro("sigma-filtro-tipo"),
      responsavel: valorFiltro("sigma-filtro-owner"),
      organizacao: valorFiltro("sigma-organizacao") || "competencia",
      situacao: situacaoAtual() || "todas",
      salvoEm: Date.now(),
    };

    try {
      localStorage.setItem(chavePreferenciasPainel(), JSON.stringify(dados));
      localStorage.setItem("sigma-painel-financeiro-ultimo-usuario", nomeUsuarioPreferencias());
    } catch (_) {}
  }

  function aplicarValorSeDisponivel(id, valor) {
    const el = document.getElementById(id);
    if (!el || valor == null) return;

    if (el.tagName === "SELECT") {
      const existe = Array.from(el.options).some(function (option) { return option.value === String(valor); });
      if (!existe) return;
    }

    el.value = String(valor);
  }

  function restaurarPreferenciasPainel(somenteBasicos) {
    const dados = lerPreferenciasPainel();
    state.restaurandoPreferencias = true;

    try {
      aplicarValorSeDisponivel("sigma-busca", dados.busca || "");
      aplicarValorSeDisponivel("sigma-organizacao", dados.organizacao || "competencia");

      const situacao = dados.situacao || "todas";
      const botaoSituacao = document.querySelector(`[data-situacao="${escaparCss(situacao)}"]`);
      if (botaoSituacao) {
        document.querySelectorAll("[data-situacao]").forEach(function (botao) { botao.classList.remove("ativo"); });
        botaoSituacao.classList.add("ativo");
      }

      if (!somenteBasicos) {
        aplicarValorSeDisponivel("sigma-filtro-competencia", dados.competencia || "");
        aplicarValorSeDisponivel("sigma-filtro-fornecedor", dados.fornecedor || "");
        aplicarValorSeDisponivel("sigma-filtro-tipo", dados.tipo || "");
        aplicarValorSeDisponivel("sigma-filtro-owner", dados.responsavel || "");
      }
    } finally {
      state.restaurandoPreferencias = false;
    }
  }

  // =========================================================
  // RENDERIZAR_TABELA
  // Uma única tabela é mantida para continuar compatível com o
  // Tampermonkey de trava por usuário.
  // =========================================================
  function agendarRender(atraso) {
    if (state.inicializando || state.carregando || !state.filtrosProntos) {
      state.renderPendente = true;
      return;
    }

    clearTimeout(state.renderTimer);
    state.renderTimer = setTimeout(function () {
      state.renderPendente = false;
      renderizar();
    }, Number(atraso == null ? 60 : atraso));
  }

  function renderizar() {
    const corpo = document.getElementById("sigma-corpo-tabela");
    if (!corpo) return;

    preencherSelectFornecedorComContagem();
    atualizarContadores();
    const lista = despesasVisiveis();
    const organizacao = valorFiltro("sigma-organizacao") || "competencia";
    ordenarLista(lista, organizacao);

    if (!lista.length) {
      corpo.innerHTML = '<tr><td colspan="9" class="sigma-vazio"><i class="fa-regular fa-folder-open"></i><br>Nenhuma despesa encontrada com estes filtros.</td></tr>';
      return;
    }

    const quantidadePorGrupo = new Map();
    lista.forEach(function (item) {
      const grupo = obterGrupo(item, organizacao);
      quantidadePorGrupo.set(grupo, (quantidadePorGrupo.get(grupo) || 0) + 1);
    });

    let html = "";
    let grupoAnterior = null;
    lista.forEach(function (item) {
      const grupo = obterGrupo(item, organizacao);
      if (grupo !== grupoAnterior) {
        html += `<tr class="sigma-grupo"><td colspan="9">${escaparHtml(grupo)} <span style="color:#64748b;font-weight:700">• ${quantidadePorGrupo.get(grupo) || 0} despesa(s)</span></td></tr>`;
        grupoAnterior = grupo;
      }
      html += htmlDespesa(item);
    });

    corpo.innerHTML = html;
  }

  function ordenarLista(lista, modo) {
    lista.sort(function (a, b) {
      const ownerA = donoReserva(a.id) || "Sem usuário";
      const ownerB = donoReserva(b.id) || "Sem usuário";
      let primeiro = 0;

      if (modo === "competencia") primeiro = ordenarCompetencias(a.competencia, b.competencia);
      if (modo === "fornecedor") primeiro = a.fornecedor.localeCompare(b.fornecedor, "pt-BR") || ordenarCompetencias(a.competencia, b.competencia);
      if (modo === "tipo") primeiro = a.tipo.localeCompare(b.tipo, "pt-BR") || ordenarCompetencias(a.competencia, b.competencia);
      if (modo === "responsavel") primeiro = ownerA.localeCompare(ownerB, "pt-BR") || ordenarCompetencias(a.competencia, b.competencia);
      if (primeiro) return primeiro;
      return chaveData(a.vencimento) - chaveData(b.vencimento) || Number(a.id) - Number(b.id);
    });
  }

  function obterGrupo(item, modo) {
    if (modo === "fornecedor") return "Fornecedor: " + (item.fornecedor || "Sem fornecedor");
    if (modo === "tipo") return "Tipo: " + (item.tipo || "Sem tipo");
    if (modo === "responsavel") return "Responsável: " + (donoReserva(item.id) || "Sem usuário");
    if (modo === "vencimento") return "Fila por vencimento";
    return "Competência " + item.competencia;
  }

  function htmlDespesa(item) {
    const owner = donoReserva(item.id);
    const bloqueado = owner && !mesmaPessoa(owner, state.usuario.nome);
    const dias = diasPara(item.vencimento);
    const classeData = dias == null ? "" : dias < 0 ? "vencida" : dias === 0 ? "hoje" : "";
    const cor = corUsuario(owner);
    const textoOwner = owner || "Sem usuário";
    const reservando = state.reservandoIds.has(item.id);
    const acaoOwner = owner
      ? `<button type="button" data-liberar-id="${escaparHtml(item.id)}" title="${mesmaPessoa(owner, state.usuario.nome) ? "Liberar" : "Remover reserva de " + escaparHtml(owner)}" ${reservando ? "disabled" : ""}>×</button>`
      : `<button type="button" class="sigma-owner-reservar" data-reservar-id="${escaparHtml(item.id)}" title="Reservar para ${escaparHtml(state.usuario.nome || "o usuário logado")}" ${reservando ? "disabled" : ""}>+</button>`;
    const marcadores = (item.marcadoresTipo || []).map(function (marcador) {
      const classes = marcador.classes || "fa-solid fa-circle-info";
      return `<i class="${escaparHtml(classes)}" title="${escaparHtml(marcador.titulo || "Marcador especial")}"></i>`;
    }).join("");
    const tipoHtml = `<span class="sigma-tipo-conteudo">`
      + (item.imagemTipoSrc ? `<img class="sigma-tipo-img" src="${escaparHtml(item.imagemTipoSrc)}" alt="">` : "")
      + `<span class="sigma-tipo-texto" title="${escaparHtml(item.tipo)}">${escaparHtml(item.tipo)}</span>`
      + (marcadores ? `<span class="sigma-tipo-extra">${marcadores}</span>` : "")
      + `</span>`;

    let html = "";

    // Igual à tela normal do InfraDesk: a observação pertence à despesa
    // seguinte e aparece imediatamente ANTES da linha principal.
    if (item.observacoes && item.observacoes.length) {
      html += `<tr class="sigma-observacoes"><td colspan="9">${item.observacoes.map(function (obs) {
        return `<span class="sigma-observacao">${escaparHtml(obs)}</span>`;
      }).join("")}</td></tr>`;
    }

    html += `<tr class="tr-index sigma-despesa" data-sigma-id="${escaparHtml(item.id)}">
      <td class="sigma-id"><p>${escaparHtml(item.id)}</p>${item.numeroDocumento ? `<small>Doc. ${escaparHtml(item.numeroDocumento)}</small>` : ""}${item.statusTexto ? `<span class="sigma-status-mini" title="${escaparHtml(item.statusTexto)}">${escaparHtml(item.statusTexto)}</span>` : ""}</td>
      <td class="sigma-desc" title="${escaparHtml(item.descricao)}">${escaparHtml(item.descricao)}</td>
      <td class="sigma-fornecedor" title="${escaparHtml(item.fornecedor)}">${escaparHtml(item.fornecedor)}</td>
      <td class="sigma-tipo">${tipoHtml}</td>
      <td><span class="sigma-competencia" title="Data de emissão: ${escaparHtml(item.emissaoTexto)}">${escaparHtml(item.competencia)}</span></td>
      <td class="sigma-data ${classeData}" title="${dias == null ? "" : dias < 0 ? Math.abs(dias) + " dia(s) vencida" : dias + " dia(s)"}">${escaparHtml(item.vencimentoTexto)}</td>
      <td class="sigma-valor">${escaparHtml(item.valor)}</td>
      <td><span class="sigma-owner" style="${owner ? `background:${cor};border-color:${cor};color:#fff` : ""}">${escaparHtml(textoOwner)}${acaoOwner}</span></td>
      <td style="text-align:center">${item.financeUrl
        ? `<button type="button" class="btn btn-success btn-sm sigma-financeiro ${bloqueado ? "tm-finance-blocked disabled" : "tm-finance-free"}" data-sigma-id="${escaparHtml(item.id)}" data-sigma-finance-url="${escaparHtml(item.financeUrl)}" data-tm-blocked-by-user="${bloqueado ? "1" : "0"}" title="${bloqueado ? "Bloqueado: " + escaparHtml(owner) : "Abrir financeiro"}" ${bloqueado ? "disabled aria-disabled=\"true\"" : ""}><i class="fa-regular fa-money-bill-1"></i></button>`
        : `<button type="button" class="btn btn-sm sigma-financeiro" disabled title="Esta etapa não possui formulário financeiro disponível"><i class="fa-solid fa-minus"></i></button>`}</td>
    </tr>`;

    return html;
  }

  function atualizarContadores() {
    const ativos = state.despesas.filter(function (item) { return !estaFinalizadaRecentemente(item.id); });
    const minhas = ativos.filter(function (item) { return mesmaPessoa(donoReserva(item.id), state.usuario.nome); }).length;
    const livresSemDono = ativos.filter(function (item) { return !donoReserva(item.id); }).length;
    const livres = livresSemDono + minhas;
    const reservadas = ativos.filter(function (item) { return !!donoReserva(item.id); }).length;
    const vencidas = ativos.filter(function (item) { const d = diasPara(item.vencimento); return d != null && d < 0; }).length;
    document.getElementById("sigma-total").textContent = ativos.length;
    document.getElementById("sigma-livres").textContent = livres;
    document.getElementById("sigma-minhas").textContent = minhas;
    document.getElementById("sigma-reservadas").textContent = reservadas;
    document.getElementById("sigma-vencidas").textContent = vencidas;
  }

  function atualizarStatus(mensagem) {
    const el = document.getElementById("sigma-status-carregamento");
    if (el) el.textContent = mensagem;
  }

  // =========================================================
  // MODAL_FINANCEIRO_REAL
  // O conteúdo vem do endpoint verdadeiro do InfraDesk.
  // A extensão que lê boletos continua podendo atuar no modal.
  // =========================================================
  function observacaoPrincipal(item) {
    if (!item || !Array.isArray(item.observacoes) || !item.observacoes.length) {
      return "Sem observação cadastrada para esta despesa.";
    }

    return item.observacoes
      .map(function (obs) { return texto(obs); })
      .filter(Boolean)
      .join(" | ");
  }

  function atualizarCabecalhoModal(item) {
    const alvo = document.querySelector("#sigma-modal-observacao .sigma-modal-observacao-texto");
    if (!alvo) return;

    const observacao = observacaoPrincipal(item);
    const id = item && item.id ? ` da despesa ${item.id}` : "";
    alvo.innerHTML = `<strong>Observação${escaparHtml(id)}:</strong> ${escaparHtml(observacao)}`;
  }

  function criarObservadorDoModal() {
    const body = document.querySelector("#ModalDespesas .modal-body");
    if (!body) return;
    state.modalObserver = new MutationObserver(function () {
      clearTimeout(criarObservadorDoModal.timer);
      criarObservadorDoModal.timer = setTimeout(function () {
        processarFormularioModal();
      }, 100);
    });
    state.modalObserver.observe(body, { childList: true, subtree: true });
  }

  async function processarFormularioModal() {
    const form = document.querySelector("#ModalDespesas form.form-financeiro");
    if (!form) return;
    const action = String(form.getAttribute("action") || "");
    const match = action.match(/\/backend\/despesas\/financeiro\/(\d+)/i);
    const id = match ? match[1] : "";
    const item = state.despesas.find(function (d) { return d.id === id; }) || state.itemModal;
    if (item) {
      state.itemModal = item;
      atualizarCabecalhoModal(item);
    }

    const login = texto(form.querySelector("#pagamento-by") ? form.querySelector("#pagamento-by").value : "");
    if (login) {
      state.usuario.login = login;
      document.documentElement.dataset.sigmaUsuarioLogin = login;
    }

    const observacao = form.querySelector("#financeiro-observacao");
    if (observacao) {
      observacao.placeholder = "Observação do pagamento ou obrigatória ao retornar uma etapa";

      // A observação do retorno deve ser escrita agora pelo usuário.
      // Nunca reaproveita a observação antiga exibida na fila.
      if (form.dataset.sigmaObservacaoNovaPreparada !== "1") {
        form.dataset.sigmaObservacaoNovaPreparada = "1";
        observacao.value = "";
        observacao.dispatchEvent(new Event("input", { bubbles: true }));
        observacao.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }

    try { await garantirDependenciasModal(); } catch (_) {}

    prepararRetornoSomenteNaTelaOriginal(form, id);

    // Clicar em Gravar sempre limpa qualquer retorno selecionado anteriormente.
    Array.from(form.querySelectorAll('button[type="submit"], input[type="submit"]')).forEach(function (botaoGravar) {
      const ehGravar = /gravar/i.test(texto(botaoGravar.textContent || botaoGravar.value || ""))
        || /fa-save/i.test(String(botaoGravar.innerHTML || ""));
      if (!ehGravar || botaoGravar.dataset.sigmaGravarPreparado === "1") return;

      botaoGravar.dataset.sigmaGravarPreparado = "1";
      botaoGravar.addEventListener("click", function () {
        const campoResetar = form.querySelector('[name="resetar"]');
        if (campoResetar) campoResetar.value = "";
        delete form.dataset.sigmaRetornoValor;
        delete form.dataset.sigmaEtapaRetorno;
      }, false);
    });

    if (form.dataset.sigmaAjaxInstalado !== "1") {
      form.dataset.sigmaAjaxInstalado = "1";
      form.addEventListener("submit", enviarFormularioViaAjax, false);
    }

    document.dispatchEvent(new CustomEvent("sigma:modal-financeiro-carregado", {
      detail: { despesaId: id, modalId: "ModalDespesas" },
    }));
  }

  async function garantirDependenciasModal() {
    if (state.dependenciasPromise) return state.dependenciasPromise;
    state.dependenciasPromise = (async function () {
      const w = paginaWindow();
      const $ = w.jQuery;
      incluirCss("sigma-sweetalert-css", "https://cdn.infradesk.app/css/plugins/sweetalert/sweetalert.css");
      incluirCss("sigma-select2-css", "https://cdnjs.cloudflare.com/ajax/libs/select2/4.0.13/css/select2.min.css");
      incluirCss("sigma-datepicker-css", "https://cdn.infradesk.app/css/plugins/datapicker/datepicker3.css");
      incluirCss("sigma-toastr-css", "https://cdn.infradesk.app/css/plugins/toastr/toastr.min.css");
      incluirCss("sigma-fileinput-css", "https://cdn.infradesk.app/css/plugins/fileinput/2fileinput.min.css");
      incluirCss("sigma-daterange-css", "https://cdn.infradesk.app/css/plugins/daterangepicker/daterangepicker-bs3.css");

      const scripts = [
        ["sigma-sweetalert-js", "https://cdn.infradesk.app/js/plugins/sweetalert/sweetalert.min.js", function () { return typeof w.swal === "function"; }],
        ["sigma-select2-js", "https://cdnjs.cloudflare.com/ajax/libs/select2/4.0.13/js/select2.min.js", function () { return $ && typeof $.fn.select2 === "function"; }],
        ["sigma-datepicker-js", "https://cdn.infradesk.app/js/plugins/datapicker/bootstrap-datepicker.js", function () { return $ && typeof $.fn.datepicker === "function"; }],
        ["sigma-datepicker-ptbr-js", "https://cdnjs.cloudflare.com/ajax/libs/bootstrap-datepicker/1.9.0/locales/bootstrap-datepicker.pt-BR.min.js", function () { return $ && $.fn.datepicker && $.fn.datepicker.dates && $.fn.datepicker.dates["pt-BR"]; }],
        ["sigma-toastr-js", "https://cdn.infradesk.app/js/plugins/toastr/toastr.min.js", function () { return typeof w.toastr === "object"; }],
        ["sigma-maskmoney-js", "https://cdn.infradesk.app/js/plugins/maskMoney/jquery.maskMoney.min.js", function () { return $ && typeof $.fn.maskMoney === "function"; }],
        ["sigma-maskedinput-js", "https://cdn.infradesk.app/js/jquery.maskedinput.min.js", function () { return $ && typeof $.fn.mask === "function"; }],
        ["sigma-fileinput-js", "https://cdn.infradesk.app/js/plugins/fileinput/2fileinput.min.js", function () { return $ && typeof $.fn.fileinput === "function"; }],
        ["sigma-moment-js", "https://cdn.infradesk.app/js/plugins/fullcalendar/moment.min.js", function () { return typeof w.moment === "function"; }],
        ["sigma-daterange-js", "https://cdn.infradesk.app/js/plugins/daterangepicker/daterangepicker.js", function () { return $ && typeof $.fn.daterangepicker === "function"; }],
      ];
      for (const item of scripts) await incluirScript(item[0], item[1], item[2]);
    })();
    try { await state.dependenciasPromise; } catch (falha) { state.dependenciasPromise = null; throw falha; }
  }

  function incluirCss(id, href) {
    if (document.getElementById(id)) return;
    const link = document.createElement("link");
    link.id = id; link.rel = "stylesheet"; link.href = href;
    document.head.appendChild(link);
  }

  function incluirScript(id, src, pronto) {
    return new Promise(function (resolve, reject) {
      if (pronto && pronto()) { resolve(); return; }
      const existente = document.getElementById(id);
      if (existente) {
        existente.addEventListener("load", resolve, { once: true });
        existente.addEventListener("error", reject, { once: true });
        return;
      }
      const script = document.createElement("script");
      script.id = id; script.src = src; script.async = false;
      script.addEventListener("load", resolve, { once: true });
      script.addEventListener("error", function () { reject(new Error("Falha ao carregar " + src)); }, { once: true });
      document.head.appendChild(script);
    });
  }

  // =========================================================
  // GRAVAR_SEM_SAIR_DO_PAINEL
  // Respeita as validações que o formulário já instalou. Somente
  // quando elas permitem o envio, interceptamos e enviamos por fetch.
  // Depois da confirmação do InfraDesk, registra no Firebase.
  // =========================================================
  function urlPostFinanceiroEnxuta(form, id) {
    const postUrl = new URL(form.action, window.location.origin);
    const retorno = new URL("/backend/despesas", window.location.origin);

    // O redirect original costuma apontar para a fila inteira. Depois do POST,
    // o fetch acabava baixando novamente mais de cem despesas só para confirmar
    // o sucesso. Redirecionando para o próprio ID, a resposta fica minúscula.
    retorno.searchParams.set("status", "T");
    retorno.searchParams.set("tipo_data", "V");
    retorno.searchParams.set("data_intervalo", "");
    retorno.searchParams.set("nfe_id", id || "");
    retorno.searchParams.set("tipo_doc", "");
    retorno.searchParams.set("descricao", "");
    retorno.searchParams.set("departamento_setor_id", "");
    retorno.searchParams.set("tipo", "");
    retorno.searchParams.set("plano_conta_id", "");
    retorno.searchParams.set("natureza_operacao_id", "");
    retorno.searchParams.set("parcela", "");
    retorno.searchParams.set("tipo_entrada", "");
    retorno.searchParams.set("show-descricao", "0");

    postUrl.searchParams.set("redirect", retorno.pathname + retorno.search);
    return postUrl.toString();
  }

  // =========================================================
  // RETORNO_SEGURO_TELA_ORIGINAL
  // Para localizar depois, use CTRL + F e procure por:
  // RETORNO_SEGURO_TELA_ORIGINAL
  //
  // O retorno embutido foi desativado porque o backend do InfraDesk conclui
  // a despesa mesmo quando recebe resetar=F ou resetar=R pelo painel.
  // Este botão não envia POST, não altera etapa e não grava nada: apenas abre
  // a fila original já filtrada pela despesa para o retorno ser feito lá.
  // =========================================================
  function urlTelaOriginalParaRetorno(form, id) {
    const actionUrl = new URL(form.action || "/backend/despesas", window.location.origin);
    const redirectOriginal = texto(actionUrl.searchParams.get("redirect"));
    let url;

    try {
      url = new URL(redirectOriginal || "/backend/despesas", window.location.origin);
    } catch (_) {
      url = new URL("/backend/despesas", window.location.origin);
    }

    url.searchParams.delete(CONFIG.parametroPainel);
    url.searchParams.set("nfe_id", id || "");
    if (!url.searchParams.get("status")) url.searchParams.set("status", CONFIG.statusFilaFixo);
    if (!url.searchParams.get("tipo_data")) url.searchParams.set("tipo_data", "V");
    url.searchParams.set("show-descricao", "1");
    return url.toString();
  }

  function abrirRetornoNaTelaOriginal(form, id) {
    const url = urlTelaOriginalParaRetorno(form, id);
    const novaAba = window.open(url, "_blank");

    if (!novaAba) {
      toast("O navegador bloqueou a nova aba. Permita pop-ups para o InfraDesk e tente novamente.", "erro");
      return;
    }

    try { novaAba.opener = null; } catch (_) {}
    paginaWindow().jQuery("#ModalDespesas").modal("hide");
    toast(
      `Despesa ${id} aberta na tela original. Lá, abra o financeiro, escreva a observação e escolha a etapa de retorno.`,
      "sucesso"
    );
  }

  function prepararRetornoSomenteNaTelaOriginal(form, id) {
    const atual = form.querySelector("#btns-voltar");
    if (!atual) return;

    const campoResetar = form.querySelector('[name="resetar"]');
    if (campoResetar) campoResetar.value = "";

    Array.from(form.querySelectorAll(".dropdown-menu")).forEach(function (menu) {
      if (menu.querySelector('[id^="btn-reset-"]')) menu.remove();
    });

    const grupo = atual.closest(".btn-group");
    if (grupo) {
      grupo.classList.remove("open");
      Array.from(grupo.querySelectorAll(".dropdown-menu")).forEach(function (menu) {
        menu.remove();
      });
    }

    let botao = atual;
    if (atual.dataset.sigmaTelaOriginalPreparada !== "1") {
      botao = atual.cloneNode(true);
      atual.replaceWith(botao);
      botao.dataset.sigmaTelaOriginalPreparada = "1";
      botao.removeAttribute("data-toggle");
      botao.removeAttribute("aria-expanded");
      botao.setAttribute("type", "button");
      botao.title = "Abrir esta despesa na tela original para retornar com segurança";
      botao.innerHTML = '<i class="fa-solid fa-arrow-up-right-from-square"></i> Retornar na tela original';
      botao.addEventListener("click", function (evento) {
        evento.preventDefault();
        evento.stopImmediatePropagation();
        abrirRetornoNaTelaOriginal(form, id);
      }, true);
    }

    botao.style.setProperty("display", "inline-flex", "important");
    botao.hidden = false;

    const aviso = Array.from(form.querySelectorAll("p")).find(function (paragrafo) {
      return /retornar uma etapa/i.test(texto(paragrafo.textContent || ""));
    });
    if (aviso) {
      aviso.textContent = "Para retornar, abra a tela original, escreva uma nova observação e escolha a etapa por lá.";
      aviso.style.color = "#9a0000";
      aviso.style.fontWeight = "700";
    }
  }

  // =========================================================
  // RETORNO_AUTOMATICO_DESATIVADO
  // Para localizar depois, use CTRL + F e procure por:
  // RETORNO_DE_ETAPA_NATIVO
  //
  // O InfraDesk usa o mesmo formulário para gravar e para retornar. A única
  // diferença é o campo oculto "resetar":
  // F = Revisar Fiscal, A = Aprovar Despesa, R = Revisar Despesa (Início).
  //
  // O retorno usa a ação e o método EXATOS do formulário original. Não troca
  // o redirect, não força _method e não usa o caminho otimizado da gravação.
  // A única intervenção é garantir o código F/A/R, apontar temporariamente o
  // formulário para um iframe oculto e clicar no botão original outra vez.
  // Assim o onclick original e o submitter original continuam participando.
  // =========================================================
  function enviarRetornoEtapaNativo(form, id, codigoRetorno, botaoRetorno) {
    // Proteção definitiva: este transporte não pode mais enviar nada.
    return Promise.reject(new Error("Retorno automático desativado; use a tela original."));

    /* Código antigo mantido abaixo apenas como histórico interno da versão. */
    return new Promise(function (resolve, reject) {
      codigoRetorno = texto(codigoRetorno);
      if (!codigoRetorno || !botaoRetorno) {
        reject(new Error("A etapa ou o botão original de retorno não foi identificado."));
        return;
      }

      const campoResetar = form.querySelector('[name="resetar"]');
      if (!campoResetar) {
        reject(new Error("O formulário do InfraDesk não possui o campo de retorno."));
        return;
      }

      campoResetar.disabled = false;
      campoResetar.value = codigoRetorno;
      campoResetar.dispatchEvent(new Event("input", { bubbles: true }));
      campoResetar.dispatchEvent(new Event("change", { bubbles: true }));

      const iframe = document.createElement("iframe");
      const nome = "sigma-retorno-nativo-" + id + "-" + Date.now() + "-" + Math.random().toString(36).slice(2);
      iframe.name = nome;
      iframe.id = nome;
      iframe.setAttribute("aria-hidden", "true");
      iframe.style.cssText = "position:fixed!important;width:1px!important;height:1px!important;left:-99999px!important;top:-99999px!important;border:0!important;opacity:0!important;pointer-events:none!important;";

      let enviado = false;
      let finalizado = false;
      const alvoAnterior = form.getAttribute("target");
      const timeout = setTimeout(function () {
        finalizar();
        reject(new Error("O InfraDesk demorou mais de 90 segundos para responder ao retorno de etapa."));
      }, 90000);

      function finalizar() {
        if (finalizado) return;
        finalizado = true;
        clearTimeout(timeout);
        delete form.dataset.sigmaDisparoRetornoNativo;
        delete form.dataset.sigmaRetornoNativoEmCurso;
        if (alvoAnterior == null) form.removeAttribute("target");
        else form.setAttribute("target", alvoAnterior);
        setTimeout(function () {
          try { iframe.remove(); } catch (_) {}
        }, 500);
      }

      iframe.addEventListener("load", function () {
        if (!enviado || finalizado) return;

        setTimeout(function () {
          if (finalizado) return;
          try {
            const doc = iframe.contentDocument || (iframe.contentWindow && iframe.contentWindow.document);
            if (!doc || !doc.documentElement) return;

            const finalUrl = iframe.contentWindow && iframe.contentWindow.location
              ? String(iframe.contentWindow.location.href || "")
              : "";
            const html = doc.documentElement.outerHTML || "";
            if (!html || finalUrl === "about:blank") return;

            finalizar();
            resolve({ doc: doc, html: html, finalUrl: finalUrl });
          } catch (falha) {
            finalizar();
            reject(new Error("Não consegui ler a confirmação do retorno de etapa: " + texto(falha.message || falha)));
          }
        }, 120);
      });

      document.body.appendChild(iframe);

      requestAnimationFrame(function () {
        try {
          // Reaplica no último instante; o onclick original fará o mesmo.
          campoResetar.disabled = false;
          campoResetar.value = codigoRetorno;
          const conferencia = new FormData(form);
          if (texto(conferencia.get("resetar")) !== codigoRetorno) {
            throw new Error("O código da etapa não entrou no formulário. Nada foi enviado.");
          }

          form.setAttribute("target", nome);
          form.dataset.sigmaRetornoNativoEmCurso = "1";
          form.dataset.sigmaDisparoRetornoNativo = "1";
          enviado = true;

          // Não alteramos action, method, enctype, redirect nem _method.
          // O clique original executa o onclick e a submissão padrão da página.
          botaoRetorno.click();
        } catch (falha) {
          finalizar();
          reject(new Error("Não consegui enviar o retorno de etapa: " + texto(falha.message || falha)));
        } finally {
          delete form.dataset.sigmaDisparoRetornoNativo;
        }
      });
    });
  }

  async function executarRetornoEtapaOriginal(form, botaoRetorno, codigoRetorno, etapaRetorno) {
    // Proteção definitiva: nenhuma opção do painel pode chamar este fluxo.
    return;

    if (!form || form.dataset.sigmaEnviando === "1") return;

    const observacao = form.querySelector("#financeiro-observacao");
    if (!texto(observacao ? observacao.value : "")) {
      const root = paginaWindow();
      if (typeof root.swal === "function") {
        root.swal("Escreva uma nova observação para justificar o retorno.");
      } else {
        window.alert("Escreva uma nova observação para justificar o retorno.");
      }
      if (observacao) observacao.focus();
      return;
    }

    const campoResetar = form.querySelector('[name="resetar"]');
    codigoRetorno = texto(codigoRetorno);
    if (!campoResetar || !codigoRetorno) {
      toast("Não consegui identificar a etapa escolhida. Feche o modal e abra novamente.", "erro");
      return;
    }

    const match = String(form.action || "").match(/\/backend\/despesas\/financeiro\/(\d+)/i);
    const id = match ? match[1] : "";
    const item = state.despesas.find(function (d) { return d.id === id; }) || state.itemModal;
    if (!id) {
      toast("Não consegui identificar a despesa deste formulário.", "erro");
      return;
    }

    form.dataset.sigmaEnviando = "1";

    try {
      const reserva = await reservarDespesaFirebaseSeguro(
        id,
        state.usuario,
        { permitirAssumir: false }
      );
      if (donoItemReserva(reserva.item)) {
        state.reservas[id] = reserva.item;
      } else {
        delete state.reservas[id];
      }
      if (!reserva.ok) {
        renderizar();
        throw new Error(mensagemFalhaReserva(reserva));
      }
    } catch (falhaReserva) {
      form.dataset.sigmaEnviando = "0";
      toast("Não consegui confirmar a reserva: " + texto(falhaReserva.message || falhaReserva), "erro");
      return;
    }

    campoResetar.disabled = false;
    campoResetar.value = codigoRetorno;
    campoResetar.dispatchEvent(new Event("input", { bubbles: true }));
    campoResetar.dispatchEvent(new Event("change", { bubbles: true }));

    state.salvandoId = id;
    form.dataset.sigmaAcaoAtual = "retorno";
    mostrarEstadoGravacao(
      form,
      id,
      true,
      `Retornando despesa ${id}...`,
      `Enviando para ${etapaRetorno || "a etapa selecionada"} pelo botão original do InfraDesk.`
    );
    atualizarStatus(`Retornando a despesa ${id} no InfraDesk...`);

    const avisoDemora = setTimeout(function () {
      mostrarEstadoGravacao(
        form,
        id,
        true,
        `O InfraDesk ainda está retornando a despesa ${id}...`,
        "O clique original foi acionado. Não clique novamente enquanto aguardamos a resposta."
      );
    }, 3500);

    try {
      const retornoNativo = await enviarRetornoEtapaNativo(
        form,
        id,
        codigoRetorno,
        botaoRetorno
      );
      const html = retornoNativo.html || "";
      const doc = retornoNativo.doc || new DOMParser().parseFromString(html, "text/html");
      const formularioRetornado = doc.querySelector(`form.form-financeiro[action*="/financeiro/${id}"]`);

      if (formularioRetornado) {
        const areaFormulario = formularioRetornado.parentElement || formularioRetornado;
        const erroDoFormulario = areaFormulario.querySelector(".alert-danger, .error-message, .form-error, .has-error");
        const mensagem = texto(
          erroDoFormulario
            ? erroDoFormulario.textContent
            : "O InfraDesk devolveu o formulário. Confira a observação e os campos obrigatórios."
        );
        restaurarFormularioRetornado(doc, formularioRetornado);
        throw new Error(mensagem || "O InfraDesk devolveu o formulário para correção.");
      }

      mostrarEstadoGravacao(
        form,
        id,
        true,
        "InfraDesk confirmou o retorno.",
        "Atualizando a fila e sincronizando a equipe."
      );

      if (item) gravarEstadoFinal(item, codigoRetorno);
      state.despesas = state.despesas.filter(function (d) { return d.id !== id; });
      paginaWindow().jQuery("#ModalDespesas").modal("hide");
      reconstruirOpcoesFiltros();
      renderizar();

      toast(`Despesa ${id} retornada para ${etapaRetorno || "a etapa escolhida"}.`, "sucesso");
      atualizarStatus(`${state.despesas.length} despesas restantes na fila`);
    } catch (falha) {
      console.error(PREFIXO, "Retorno de etapa pelo botão original", falha);
      toast(
        "Não consegui confirmar o retorno da etapa: " + texto(falha.message || falha)
        + " Consulte a despesa no InfraDesk antes de tentar novamente.",
        "erro"
      );
      atualizarStatus(`Falha ao confirmar o retorno da despesa ${id}`);
    } finally {
      clearTimeout(avisoDemora);
      state.salvandoId = "";
      mostrarEstadoGravacao(form, id, false);

      const overlay = document.getElementById("sigma-modal-salvando");
      if (overlay) {
        overlay.classList.remove("ativo");
        overlay.setAttribute("aria-hidden", "true");
      }

      form.dataset.sigmaEnviando = "0";
      delete form.dataset.sigmaAcaoAtual;
      delete form.dataset.sigmaDisparoRetornoNativo;
      delete form.dataset.sigmaRetornoNativoEmCurso;
      campoResetar.value = "";
      Array.from(document.querySelectorAll('#ModalDespesas button, #ModalDespesas input[type="submit"]')).forEach(function (botao) {
        botao.disabled = false;
      });
    }
  }

  function mostrarEstadoGravacao(form, id, ativo, titulo, detalhe) {
    const overlay = document.getElementById("sigma-modal-salvando");
    const tituloEl = document.getElementById("sigma-salvando-titulo");
    const detalheEl = document.getElementById("sigma-salvando-detalhe");

    if (overlay) {
      overlay.classList.toggle("ativo", !!ativo);
      overlay.setAttribute("aria-hidden", ativo ? "false" : "true");
    }
    if (tituloEl && titulo) tituloEl.textContent = titulo;
    if (detalheEl && detalhe) detalheEl.textContent = detalhe;

    if (!form) return;
    const botao = Array.from(form.querySelectorAll('button[type="submit"], input[type="submit"]')).find(function (el) {
      return /gravar/i.test(texto(el.textContent || el.value || "")) || /fa-save/i.test(String(el.innerHTML || ""));
    });

    if (!botao) return;
    if (ativo) {
      if (!botao.dataset.sigmaTextoOriginal) {
        botao.dataset.sigmaTextoOriginal = botao.tagName.toLowerCase() === "input" ? botao.value : botao.innerHTML;
      }
      const textoProcessando = form.dataset.sigmaAcaoAtual === "retorno"
        ? "Retornando..."
        : "Gravando...";
      if (botao.tagName.toLowerCase() === "input") {
        botao.value = textoProcessando;
      } else {
        botao.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> ${textoProcessando}`;
      }
    } else if (botao.dataset.sigmaTextoOriginal) {
      if (botao.tagName.toLowerCase() === "input") {
        botao.value = botao.dataset.sigmaTextoOriginal;
      } else {
        botao.innerHTML = botao.dataset.sigmaTextoOriginal;
      }
      delete botao.dataset.sigmaTextoOriginal;
    }
  }

  async function enviarFormularioViaAjax(evento) {
    const form = evento.currentTarget;

    // Os validadores nativos do InfraDesk foram registrados antes.
    // Se algum deles impediu o envio, não fazemos nada.
    if (evento.defaultPrevented) return;
    if (form.dataset.sigmaEnviando === "1") {
      evento.preventDefault();
      return;
    }

    evento.preventDefault();
    evento.stopPropagation();
    form.dataset.sigmaEnviando = "1";

    const match = String(form.action || "").match(/\/backend\/despesas\/financeiro\/(\d+)/i);
    const id = match ? match[1] : "";
    const item = state.despesas.find(function (d) { return d.id === id; }) || state.itemModal;

    try {
      const reserva = await reservarDespesaFirebaseSeguro(
        id,
        state.usuario,
        { permitirAssumir: false }
      );
      if (donoItemReserva(reserva.item)) {
        state.reservas[id] = reserva.item;
      } else {
        delete state.reservas[id];
      }
      if (!reserva.ok) {
        form.dataset.sigmaEnviando = "0";
        renderizar();
        toast(mensagemFalhaReserva(reserva), "erro");
        return;
      }
    } catch (falhaReserva) {
      form.dataset.sigmaEnviando = "0";
      toast("Não consegui confirmar a reserva: " + texto(falhaReserva.message || falhaReserva), "erro");
      return;
    }

    // Este listener cuida somente do botão Gravar. Retornos são tratados pelo
    // clique original das opções F/A/R e nunca passam por este fetch.
    const campoResetarGravacao = form.querySelector('[name="resetar"]');
    if (campoResetarGravacao) campoResetarGravacao.value = "";
    const botoes = Array.from(form.querySelectorAll("button, input[type=submit]"));
    botoes.forEach(function (b) { b.disabled = true; });
    state.salvandoId = id;
    form.dataset.sigmaAcaoAtual = "gravacao";

    mostrarEstadoGravacao(
      form,
      id,
      true,
      `Gravando despesa ${id}...`,
      "Enviando os dados ao InfraDesk. A resposta usa uma consulta reduzida para ser mais rápida."
    );
    atualizarStatus(`Gravando despesa ${id} no InfraDesk...`);

    let avisoDemora = setTimeout(function () {
      mostrarEstadoGravacao(
        form,
        id,
        true,
        `O InfraDesk ainda está processando a despesa ${id}...`,
        "O clique foi recebido. Não clique novamente; estamos aguardando a confirmação do servidor."
      );
    }, 3500);

    try {
      const resposta = await fetch(urlPostFinanceiroEnxuta(form, id), {
        method: "POST",
        credentials: "same-origin",
        body: new FormData(form),
        cache: "no-store",
      });
      const html = await resposta.text();
      if (!resposta.ok) throw new Error(`InfraDesk retornou HTTP ${resposta.status}.`);
      const doc = new DOMParser().parseFromString(html, "text/html");
      const formularioRetornado = doc.querySelector(`form.form-financeiro[action*="/financeiro/${id}"]`);

      // Quando o próprio formulário volta, o InfraDesk recusou algum campo.
      // Nesse caso recolocamos a resposta dentro do modal e não alteramos o
      // Firebase nem removemos a despesa da fila.
      if (formularioRetornado) {
        const areaFormulario = formularioRetornado.parentElement || formularioRetornado;
        const erroDoFormulario = areaFormulario.querySelector(".alert-danger, .error-message, .form-error, .has-error");
        const mensagem = texto(erroDoFormulario ? erroDoFormulario.textContent : "O InfraDesk devolveu o formulário. Confira os campos obrigatórios.");

        restaurarFormularioRetornado(doc, formularioRetornado);
        throw new Error(mensagem || "O InfraDesk devolveu o formulário para correção.");
      }

      mostrarEstadoGravacao(
        form,
        id,
        true,
        "InfraDesk confirmou. Atualizando a equipe...",
        "Gravação confirmada. Atualizando a fila e sincronizando a equipe em segundo plano."
      );

      // O InfraDesk já confirmou neste ponto. A despesa sai da fila agora;
      // o Firebase sincroniza em segundo plano e possui fila local de repetição.
      if (item) gravarEstadoFinal(item, "");
      state.despesas = state.despesas.filter(function (d) { return d.id !== id; });
      paginaWindow().jQuery("#ModalDespesas").modal("hide");
      reconstruirOpcoesFiltros();
      renderizar();

      toast(`Despesa ${id} gravada e concluída com sucesso.`, "sucesso");
      atualizarStatus(`${state.despesas.length} despesas restantes na fila`);
    } catch (falha) {
      console.error(PREFIXO, "Gravação", falha);
      toast("Não consegui confirmar a gravação: " + texto(falha.message || falha), "erro");
      atualizarStatus(`Falha ao gravar a despesa ${id}`);
    } finally {
      clearTimeout(avisoDemora);
      state.salvandoId = "";

      // Destrava sempre, inclusive quando o formulário original foi substituído
      // pela resposta do InfraDesk durante uma validação.
      mostrarEstadoGravacao(form, id, false);
      const overlay = document.getElementById("sigma-modal-salvando");
      if (overlay) {
        overlay.classList.remove("ativo");
        overlay.setAttribute("aria-hidden", "true");
      }

      form.dataset.sigmaEnviando = "0";
      delete form.dataset.sigmaAcaoAtual;
      delete form.dataset.sigmaEtapaRetorno;
      delete form.dataset.sigmaRetornoValor;
      const campoResetarFinal = form.querySelector('[name="resetar"]');
      if (campoResetarFinal) campoResetarFinal.value = "";
      botoes.forEach(function (b) { b.disabled = false; });
      Array.from(document.querySelectorAll('#ModalDespesas button, #ModalDespesas input[type="submit"]')).forEach(function (b) {
        b.disabled = false;
      });
    }
  }

  function restaurarFormularioRetornado(doc, formularioRetornado) {
    const modalBody = document.querySelector("#ModalDespesas .modal-body");
    if (!modalBody || !formularioRetornado) return;

    const corpoResposta = doc && doc.body ? doc.body : null;
    const respostaPareceFragmento = corpoResposta
      && !doc.querySelector("#wrapper, nav.navbar, .navbar-default, .sigma-topo")
      && corpoResposta.innerHTML.length < 250000;

    if (respostaPareceFragmento) {
      modalBody.innerHTML = corpoResposta.innerHTML;
    } else {
      const avisos = Array.from(doc.querySelectorAll(".alert, .error-message, .form-error"))
        .filter(function (el) {
          return el === formularioRetornado || formularioRetornado.contains(el) || el.compareDocumentPosition(formularioRetornado) & Node.DOCUMENT_POSITION_FOLLOWING;
        })
        .slice(-4)
        .map(function (el) { return el.outerHTML; })
        .join("");
      modalBody.innerHTML = avisos + formularioRetornado.outerHTML;
    }

    setTimeout(function () {
      processarFormularioModal();
    }, 0);
  }

  function mostrarErroFatal(falha) {
    const mensagem = texto(falha && (falha.message || falha)) || "Erro desconhecido ao iniciar o painel.";
    const corpo = document.getElementById("sigma-corpo-tabela");

    if (corpo) {
      corpo.innerHTML = `<tr><td colspan="9" class="sigma-vazio" style="color:#b91c1c!important">
        <i class="fa-solid fa-triangle-exclamation"></i><br>
        <strong>O painel não conseguiu iniciar.</strong><br>
        <small>${escaparHtml(mensagem)}</small><br><br>
        <button type="button" class="sigma-btn" style="background:#991b1b" onclick="location.reload()">Tentar novamente</button>
      </td></tr>`;
      atualizarStatus("O painel não conseguiu iniciar");
      return;
    }

    // Última proteção: nunca deixar a aba em branco, mesmo se a falha
    // acontecer antes da estrutura principal ser criada.
    document.body.innerHTML = `
      <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:30px;background:#eef2f7;font-family:Arial,sans-serif">
        <div style="max-width:720px;padding:24px;border-radius:14px;background:#fff;box-shadow:0 16px 40px rgba(15,23,42,.16);color:#991b1b">
          <h2 style="margin:0 0 12px">O Painel Financeiro não conseguiu iniciar</h2>
          <p style="color:#475569">${escaparHtml(mensagem)}</p>
          <button type="button" onclick="location.reload()" style="height:38px;padding:0 14px;border:0;border-radius:8px;background:#0f172a;color:#fff;font-weight:800;cursor:pointer">Tentar novamente</button>
        </div>
      </div>`;
  }
})();
