// script.js (v2 - Mostrar+ controla GTIN/infAdProd/docs do destinatário + validação autorização + frete como antes)
(() => {
  "use strict";

  const $id = (id) => document.getElementById(id);

  // ---------- Helpers ----------
  function escapeHtml(str) {
    return String(str ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function isElement(n) {
    return n && n.nodeType === 1;
  }

  function firstDescByLocal(el, localName) {
    if (!el) return null;
    if (el.getElementsByTagNameNS) {
      const list = el.getElementsByTagNameNS("*", localName);
      return list && list.length ? list[0] : null;
    }
    const list = el.getElementsByTagName(localName);
    return list && list.length ? list[0] : null;
  }

  function firstChildByLocal(el, localName) {
    if (!el) return null;
    for (const n of el.childNodes) {
      if (isElement(n) && n.localName === localName) return n;
    }
    return null;
  }

  function childrenByLocal(el, localName) {
    if (!el) return [];
    const out = [];
    for (const n of el.childNodes) {
      if (isElement(n) && n.localName === localName) out.push(n);
    }
    return out;
  }

  function textOf(el) {
    return (el?.textContent ?? "").trim();
  }

  function getTextPath(root, pathArr) {
    let cur = root;
    for (const name of pathArr) {
      cur = firstChildByLocal(cur, name);
      if (!cur) return "";
    }
    return textOf(cur);
  }

  function toNumber(val) {
    const s = String(val ?? "").trim();
    if (!s) return 0;
    const n = Number(s);
    return Number.isFinite(n) ? n : 0;
  }

  function fmtNumber(val, digits) {
    const n = toNumber(val);
    return n.toLocaleString("pt-BR", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  }

  function fmtCurrency(val) {
    const n = toNumber(val);
    return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  }

  function parseDateToBR(s) {
    const v = String(s ?? "").trim();
    if (!v) return "-";
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return "-";
    return d.toLocaleDateString("pt-BR");
  }

  function normalizeGtin(val) {
    const s = String(val ?? "").trim();
    if (!s) return "";
    const up = s.toUpperCase().replace(/\s+/g, " ").trim();
    // NF-e frequentemente manda "SEM GTIN" quando não existe GTIN
    if (up === "SEM GTIN" || up === "SEMGTIN") return "";
    // alguns ERPs podem mandar variações
    if (up === "NAO INFORMADO" || up === "NÃO INFORMADO") return "";
    return s;
  }

  function clearEl(id) {
    const el = $id(id);
    if (el) el.innerHTML = "";
  }

  function setDisplay(id, value) {
    const el = $id(id);
    if (el) el.style.display = value;
  }

  function removeEl(id) {
    const el = $id(id);
    if (el) el.remove();
  }

  function showToast(message, { type = "info", ms = 6000 } = {}) {
    removeEl("toastNfe");
    const el = document.createElement("div");
    el.id = "toastNfe";

    const bg =
      type === "warn" ? "#6a1b9a" :
      type === "error" ? "#d32f2f" :
      "#1565c0";

    el.innerHTML = `
      <div style="
        position: fixed;
        top: 12px;
        left: 50%;
        transform: translateX(-50%);
        background: ${bg};
        color: #fff;
        padding: 10px 14px;
        border-radius: 8px;
        z-index: 9999;
        font: 600 14px/1.2 system-ui, -apple-system, Segoe UI, Roboto, Arial;
        box-shadow: 0 10px 25px rgba(0,0,0,.25);
        max-width: 92vw;
        display: flex;
        gap: 10px;
        align-items: center;
      ">
        <span style="flex:1">${escapeHtml(message)}</span>
        <button id="toastClose" style="
          border: 0;
          background: rgba(255,255,255,.15);
          color: #fff;
          width: 28px;
          height: 28px;
          border-radius: 6px;
          cursor: pointer;
          font-size: 16px;
          line-height: 28px;
        ">×</button>
      </div>
    `;
    document.body.appendChild(el);

    $id("toastClose").addEventListener("click", () => removeEl("toastNfe"));
    if (ms > 0) setTimeout(() => removeEl("toastNfe"), ms);
  }

  function parseXmlText(xmlText) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, "application/xml");
    const parserError = doc.getElementsByTagName("parsererror");
    if (parserError && parserError.length) {
      throw new Error("XML inválido (erro de parse).");
    }
    return doc;
  }

  function resetUI() {
    clearEl("tbody");
    clearEl("nf");
    clearEl("enx");
    clearEl("ve1");
    clearEl("dadosAdic");
    clearEl("totaisNfs");

    removeEl("toastNfe");

    // inputs visíveis
    setDisplay("divarquivo", "block");
    setDisplay("divarquivo2", "block");

    // container principal
    const tudo = $id("tudo");
    if (tudo) {
      tudo.style.display = "block";
      tudo.style.color = "";
    }

    // alerta entrada
    setDisplay("alerta", "none");

    // frete/tpNF limpa
    const frete = $id("frete");
    if (frete) {
      frete.innerHTML = "";
      frete.style.display = "none";
      frete.style.backgroundImage = "";
    }

    const tpNF = $id("tpNF");
    if (tpNF) {
      tpNF.innerHTML = "";
      tpNF.style.display = "none";
      tpNF.style.background = "";
    }
  }

  // ---------- Seleção de linha (delegação) ----------
  function selLinha(linha, multiplos = false) {
    if (!linha) return;
    if (!multiplos) {
      const parent = linha.parentElement;
      if (parent) {
        const trs = parent.getElementsByTagName("tr");
        for (const tr of trs) tr.classList.remove("selecionado");
      }
    }
    linha.classList.toggle("selecionado");
  }
  window.selLinha = selLinha;

  function initRowSelectionOnce() {
    if (window.__rowSelectionInit) return;
    window.__rowSelectionInit = true;

    const tbody = $id("tbody");
    if (!tbody) return;

    tbody.addEventListener("click", (e) => {
      const tr = e.target.closest("tr");
      if (!tr) return;
      const mult = e.ctrlKey || e.metaKey;
      selLinha(tr, mult);
    });
  }

  // ---------- Loader ----------
  async function carregar(fileInput) {
    try {
      resetUI();

      const file = fileInput?.files?.[0];
      if (!file) return;

      setDisplay("tudo", "block");

      const xmlText = await file.text();
      const xmlDoc = parseXmlText(xmlText);

      carregarXML(xmlDoc);

      // esconde inputs após carregar
      setDisplay("divarquivo", "none");
      setDisplay("divarquivo2", "none");

      const dadosEnxuto = $id("dadosEnxuto");
      if (dadosEnxuto) dadosEnxuto.style.top = "1px";
    } catch (err) {
      console.error(err);
      showToast(`Erro ao ler XML: ${err.message || err}`, { type: "error", ms: 8000 });
    }
  }
  window.carregar = carregar;

  // ---------- Render ----------
  function carregarXML(xmlDoc) {
    initRowSelectionOnce();

    const root = xmlDoc.documentElement;
	const nfeProc = (root && root.localName === "nfeProc")
	  ? root
	  : firstDescByLocal(root, "nfeProc");

	const infNFe = firstDescByLocal(nfeProc || root, "infNFe");
    if (!infNFe) {
      showToast("Não encontrei a tag infNFe. Esse XML não parece NF-e.", { type: "error", ms: 8000 });
      return;
    }

    // --- Autorização (validação como no antigo, mas sem tarja gigante) ---
    let isAutorizada = false;
    let cStat = "";
    if (nfeProc) {
      const protNFe = firstChildByLocal(nfeProc, "protNFe");
      const infProt = firstChildByLocal(protNFe, "infProt");
      cStat = getTextPath(infProt, ["cStat"]);
      // 100 = Autorizado o uso da NF-e (o mais comum)
      isAutorizada = cStat ? cStat === "100" : true;
    }

    if (!nfeProc || !isAutorizada) {
      showToast("XML antes de autorizado na SEFAZ (pré-autorização). Vou mostrar os dados mesmo assim.", {
        type: "warn",
        ms: 7000,
      });

      // badge discreto na área que você já tinha (tpNF div)
      const tpNFdiv = $id("tpNF");
      if (tpNFdiv) {
        tpNFdiv.style.display = "block";
        tpNFdiv.style.textAlign = "center";
        tpNFdiv.style.fontWeight = "800";
        tpNFdiv.style.color = "#fff";
        tpNFdiv.style.background = "#6a1b9a";
        tpNFdiv.style.borderRadius = "6px";
        tpNFdiv.innerHTML = "PRÉ-AUTORIZAÇÃO";
      }
    }

    // --- blocos principais ---
    const ide = firstChildByLocal(infNFe, "ide");
    const emit = firstChildByLocal(infNFe, "emit");
    const dest = firstChildByLocal(infNFe, "dest");
    const total = firstChildByLocal(infNFe, "total");
    const transp = firstChildByLocal(infNFe, "transp");
    const cobr = firstChildByLocal(infNFe, "cobr");
    const infAdic = firstChildByLocal(infNFe, "infAdic");
    const compra = firstChildByLocal(infNFe, "compra");

    // ---------- Cabeçalho Emitente (mantém como está: CNPJ/IE separados) ----------
    const emitNome = getTextPath(emit, ["xNome"]);
    const emitCNPJ = getTextPath(emit, ["CNPJ"]);
    const emitIE = getTextPath(emit, ["IE"]);
    const enderEmit = firstChildByLocal(emit, "enderEmit");
    const emitMun = getTextPath(enderEmit, ["xMun"]);
    const emitUF = getTextPath(enderEmit, ["UF"]);
    const emitCMun = getTextPath(enderEmit, ["cMun"]);
    const natOp = getTextPath(ide, ["natOp"]);

    const nfHtml = `
      <tr>
        <td><label>Razão</label/>${escapeHtml(emitNome)}</td>
        <td style="width:120px;"><label>CNPJ Emit.</label/>${escapeHtml(emitCNPJ)}</td>
        <td style="width:120px;"><label>IE Emit.</label/>${escapeHtml(emitIE)}</td>
        <td><label>Município</label/>${escapeHtml(emitMun)}, ${escapeHtml(emitUF)} - Cód.: ${escapeHtml(emitCMun)}</td>
      </tr>
      <tr>
        <td colspan="4"><label>Natureza da Operação</label/>${escapeHtml(natOp)}</td>
      </tr>
    `;
    $id("nf").insertAdjacentHTML("beforeend", nfHtml);

    // ---------- Tipo NF (Entrada/Saída) ----------
    const tpNFraw = getTextPath(ide, ["tpNF"]);
    const tpNF = tpNFraw === "0" ? "Entrada" : "Saída";
    if (tpNF === "Entrada") {
      const tudo = $id("tudo");
      if (tudo) tudo.style.display = "none";
      setDisplay("alerta", "block");
    }

    // ---------- Chave ----------
    let chave = "";
    if (nfeProc) {
      const protNFe = firstChildByLocal(nfeProc, "protNFe");
      const infProt = firstChildByLocal(protNFe, "infProt");
      chave = getTextPath(infProt, ["chNFe"]);
    }
    if (!chave) {
      const idAttr = infNFe.getAttribute("Id") || "";
      chave = idAttr.startsWith("NFe") ? idAttr.slice(3) : idAttr;
    }

    // ---------- Cabeçalho Destinatário (LIMPO + docs no Mostrar+) ----------
    const nNF = getTextPath(ide, ["nNF"]);
    const destNome = getTextPath(dest, ["xNome"]);
    const destDoc = getTextPath(dest, ["CNPJ"]) || getTextPath(dest, ["CPF"]);
    const destIE = getTextPath(dest, ["IE"]);

    const enderDest = firstChildByLocal(dest, "enderDest");
    const destMun = getTextPath(enderDest, ["xMun"]);
    const destUF = getTextPath(enderDest, ["UF"]);
    const destCMun = getTextPath(enderDest, ["cMun"]);
    const destLgr = getTextPath(enderDest, ["xLgr"]);
    const destNro = getTextPath(enderDest, ["nro"]);

    const dhEmi = getTextPath(ide, ["dhEmi"]) || getTextPath(ide, ["dEmi"]);
    const dhSaiEnt = getTextPath(ide, ["dhSaiEnt"]) || getTextPath(ide, ["dSaiEnt"]);

    const emissaoBR = parseDateToBR(dhEmi);
    const saidaBR = parseDateToBR(dhSaiEnt);

    const docSpanParts = [];
    if (destDoc) docSpanParts.push(escapeHtml(destDoc));
    if (destIE) docSpanParts.push("IE: " + escapeHtml(destIE));
    const docSpan =
      docSpanParts.length
        ? `<span class="coluna1 coluna-oculta"><br>${docSpanParts.join("<br>")}</span>`
        : "";

    const enxHtml = `
      <tr>
        <td><label>Nro NF</label/>${escapeHtml(nNF)}</td>
        <td><label>Tipo</label/>${escapeHtml(tpNF)}</td>
        <td><label>Razão</label/>${escapeHtml(destNome)}${docSpan}</td>
        <td><label>Município</label>${escapeHtml(destMun)}, ${escapeHtml(destUF)} - Cód.: ${escapeHtml(destCMun)}</td>
        <td colspan="2"><label>Endereço</label>${escapeHtml(destLgr)}${destNro ? ", " + escapeHtml(destNro) : ""}</td>
      </tr>
      <tr>
        <td colspan="3"><label>Chave de Acesso</label>${escapeHtml(chave)}</td>
        <td><label>Emissão</label>${escapeHtml(emissaoBR)}</td>
        <td><label>Saída</label>${escapeHtml(saidaBR)}</td>
      </tr>
    `;
    $id("enx").insertAdjacentHTML("beforeend", enxHtml);

    document.title = `EA - XML | NF ${nNF || "-"}`;

    // ---------- Frete (como o seu antigo: só aparece quando é por conta do destinatário) ----------
    if (transp) {
      const modFrete = getTextPath(transp, ["modFrete"]);
      // 1 = por conta do destinatário (FOB). (deixo igual ao seu antigo)
      if (modFrete === "1") {
        const freteEl = $id("frete");
        if (freteEl) {
          freteEl.style.display = "block";
          freteEl.style.fontWeight = "bolder";
          freteEl.style.color = "#ff0022";
          freteEl.style.textAlign = "center";
          freteEl.innerHTML = "Frete<br>a<br>Pagar";
          freteEl.style.backgroundImage = "url(img/frete.jpg)";
          freteEl.style.backgroundRepeat = "no-repeat";
          freteEl.style.backgroundPosition = "center";
        }
      }
    }

    // ---------- Produtos ----------
    const dets = childrenByLocal(infNFe, "det");
    for (const det of dets) {
      const nItem = det.getAttribute("nItem") || "";

      const prod = firstChildByLocal(det, "prod");
      const imposto = firstChildByLocal(det, "imposto");

      const cProd = getTextPath(prod, ["cProd"]);
      const cEAN = normalizeGtin(getTextPath(prod, ["cEAN"]));
      const cEANTrib = normalizeGtin(getTextPath(prod, ["cEANTrib"]));

      // novos campos que alguns XMLs trazem (cBarra/cBarraTrib)
      const cBarra = normalizeGtin(getTextPath(prod, ["cBarra"]));
      const cBarraTrib = normalizeGtin(getTextPath(prod, ["cBarraTrib"]));

      const xProd = getTextPath(prod, ["xProd"]);
      const NCM = getTextPath(prod, ["NCM"]);
      const CFOP = getTextPath(prod, ["CFOP"]);
      const CEST = getTextPath(prod, ["CEST"]);

      const uCom = getTextPath(prod, ["uCom"]);
      const uTrib = getTextPath(prod, ["uTrib"]);
      const qCom = getTextPath(prod, ["qCom"]);
      const qTrib = getTextPath(prod, ["qTrib"]);
      const vUnCom = getTextPath(prod, ["vUnCom"]);
      const vUnTrib = getTextPath(prod, ["vUnTrib"]);
      const vProd = getTextPath(prod, ["vProd"]);
      const vDesc = getTextPath(prod, ["vDesc"]);
      const vOutro = getTextPath(prod, ["vOutro"]);

      const xPed = getTextPath(prod, ["xPed"]);
      const infAdProd = getTextPath(det, ["infAdProd"]); // é do DET, não do PROD

      const unidade = uCom === uTrib || !uTrib ? uCom : `${uCom}<br>${uTrib}`;
      const quantidade =
        qCom === qTrib || !qTrib
          ? fmtNumber(qCom, 3)
          : `${fmtNumber(qCom, 3)}<br>${fmtNumber(qTrib, 3)}`;
      const vlUnit =
        vUnCom === vUnTrib || !vUnTrib
          ? fmtNumber(vUnCom, 2)
          : `${fmtNumber(vUnCom, 2)}<br>${fmtNumber(vUnTrib, 2)}`;
      const vTotal = fmtNumber(vProd, 2);

      // Ref cell: cProd sempre; GTINs/Barra apenas no Mostrar+
      const gtins = [];
      if (cEAN) gtins.push(cEAN);
      if (cEANTrib && cEANTrib !== cEAN) gtins.push(cEANTrib);
      if (cBarra) gtins.push("Barra: " + cBarra);
      if (cBarraTrib && cBarraTrib !== cBarra) gtins.push("Barra Trib: " + cBarraTrib);

      const gtinSpan =
        gtins.length
          ? `<span class="coluna1 coluna-oculta"><br>${gtins.map(escapeHtml).join("<br>")}</span>`
          : "";

      // Descrição: xProd sempre; infAdProd e xPed só no Mostrar+
      const descExtras = [];
      if (infAdProd) descExtras.push(escapeHtml(infAdProd));
      if (xPed) descExtras.push(`Pedido: <span style="color:red;">${escapeHtml(xPed)}</span>`);

      const descSpan =
        descExtras.length
          ? `<span class="coluna1 coluna-oculta"><br>${descExtras.join("<br>")}</span>`
          : "";

      // ICMS (primeiro tipo dentro de <ICMS>)
      const ICMS = firstChildByLocal(imposto, "ICMS");
      const icmsTipo = ICMS ? Array.from(ICMS.childNodes).find(isElement) : null;

      const orig = getTextPath(icmsTipo, ["orig"]);
      const cst = getTextPath(icmsTipo, ["CST"]) || getTextPath(icmsTipo, ["CSOSN"]);
      const icmsCstExib = (orig || "") + (cst || "");

      const vBC = getTextPath(icmsTipo, ["vBC"]);
      const pICMS = getTextPath(icmsTipo, ["pICMS"]);
      const vICMS = getTextPath(icmsTipo, ["vICMS"]);
      const vBCST = getTextPath(icmsTipo, ["vBCST"]);
      const vICMSST = getTextPath(icmsTipo, ["vICMSST"]);
      const vICMSDeson = getTextPath(icmsTipo, ["vICMSDeson"]);
      const vFCPST = getTextPath(icmsTipo, ["vFCPST"]);
      const pMVAST = getTextPath(icmsTipo, ["pMVAST"]);

      // IPI
      const IPI = firstChildByLocal(imposto, "IPI");
      const IPITrib = firstChildByLocal(IPI, "IPITrib");
      const IPINT = firstChildByLocal(IPI, "IPINT");
      const vIPI = getTextPath(IPITrib, ["vIPI"]) || "0";
      const pIPI = getTextPath(IPITrib, ["pIPI"]) || "0";
      const cstIPI = getTextPath(IPITrib, ["CST"]) || getTextPath(IPINT, ["CST"]);

      // PIS / COFINS
      const PIS = firstChildByLocal(imposto, "PIS");
      const pisTipo = PIS ? Array.from(PIS.childNodes).find(isElement) : null;
      const pisCST = getTextPath(pisTipo, ["CST"]);
      const pPIS = getTextPath(pisTipo, ["pPIS"]) || "0";

      const COFINS = firstChildByLocal(imposto, "COFINS");
      const cofinsTipo = COFINS ? Array.from(COFINS.childNodes).find(isElement) : null;
      const cofinsCST = getTextPath(cofinsTipo, ["CST"]);
      const pCOFINS = getTextPath(cofinsTipo, ["pCOFINS"]) || "0";

      const rowHtml = `
        <tr class="table-row">
          <td class="nitem">${escapeHtml(nItem)}</td>
          <td>${escapeHtml(cProd)}${gtinSpan}</td>
          <td>${escapeHtml(xProd)}${descSpan}</td>
          <td>${escapeHtml(NCM)}</td>
          <td>${escapeHtml(icmsCstExib)}</td>
          <td>${escapeHtml(CFOP)}</td>
          <td class="coluna1 coluna-oculta">${escapeHtml(CEST)}</td>
          <td>${unidade}</td>
          <td class="num">${quantidade}</td>
          <td class="num">${vlUnit}</td>
          <td class="num">${vTotal}</td>
          <td class="coluna1 coluna-oculta">${escapeHtml(vDesc)}</td>
          <td class="coluna1 coluna-oculta">${escapeHtml(vICMSDeson)}</td>
          <td class="coluna1 coluna-oculta">${escapeHtml(vOutro)}</td>
          <td class="coluna1 coluna-oculta">${escapeHtml(vFCPST)}</td>
          <td>${fmtNumber(vBC, 2)}</td>
          <td>${escapeHtml(pICMS)}</td>
          <td>${fmtNumber(vICMS, 2)}</td>
          <td>${fmtNumber(vBCST, 2)}</td>
          <td>${fmtNumber(vICMSST, 2)}</td>
          <td>${fmtNumber(vIPI, 2)}</td>
          <td>${fmtNumber(pIPI, 2)}</td>
          <td class="coluna1 coluna-oculta">${escapeHtml(pMVAST)}</td>
          <td class="coluna1 coluna-oculta">${escapeHtml(cstIPI)}</td>
          <td class="coluna1 coluna-oculta">${escapeHtml(pisCST)}<br>${escapeHtml(cofinsCST)}</td>
          <td class="coluna1 coluna-oculta">${fmtNumber(pPIS, 2)}</td>
          <td class="coluna1 coluna-oculta">${fmtNumber(pCOFINS, 2)}</td>
        </tr>
      `;
      $id("tbody").insertAdjacentHTML("beforeend", rowHtml);
    }

    // ---------- Duplicatas / vencimentos ----------
    if (cobr) {
      const dups = childrenByLocal(cobr, "dup");
      for (const dup of dups) {
        const nDup = getTextPath(dup, ["nDup"]);
        const dVenc = getTextPath(dup, ["dVenc"]);
        const vDup = getTextPath(dup, ["vDup"]);

        const boxHtml = `
          <div class="vencimento">
            <table class="GeralXslt box">
              <tbody>
                <tr><td class="c1">Nº</td><td class="c2">${escapeHtml(nDup)}</td></tr>
                <tr><td class="c1">Venc.</td><td class="c2">${escapeHtml(dVenc)}</td></tr>
                <tr><td class="c1">Valor</td><td class="c2">${fmtCurrency(vDup)}</td></tr>
              </tbody>
            </table>
          </div>
        `;
        $id("ve1").insertAdjacentHTML("beforeend", boxHtml);
      }
    }

    // ---------- Informações adicionais (só cria linhas se tiver conteúdo) ----------
    const infAdFisc = getTextPath(infAdic, ["infAdFisc"]);
    const infCpl = getTextPath(infAdic, ["infCpl"]);
    const pedido = getTextPath(compra, ["xPed"]);

    // NFref varia muito, pega qualquer descendente com esse nome:
    const nfRefNode = firstDescByLocal(ide, "NFref");
    const nfRef = textOf(nfRefNode);

    const adicLines = [];
    if (infAdFisc) adicLines.push(`<tr><td>${escapeHtml(infAdFisc)}</td></tr>`);
    if (infCpl) adicLines.push(`<tr><td>${escapeHtml(infCpl)}</td></tr>`);
    if (pedido) adicLines.push(`<tr><td style="color:red;font-weight:bold;font-size:16px;">Pedido: ${escapeHtml(pedido)}</td></tr>`);
    if (nfRef) adicLines.push(`<tr><td>NF de Ref.: ${escapeHtml(nfRef)}</td></tr>`);

    if (adicLines.length) {
      $id("dadosAdic").insertAdjacentHTML("beforeend", adicLines.join(""));
    }

    // ---------- Totais ----------
    const ICMSTot = total ? firstDescByLocal(total, "ICMSTot") : null;
    if (ICMSTot) {
      const totHtml = `
        <tr>
          <td>${fmtNumber(getTextPath(ICMSTot, ["vDesc"]), 2)}</td>
          <td>${fmtNumber(getTextPath(ICMSTot, ["vICMSDeson"]), 2)}</td>
          <td>${fmtNumber(getTextPath(ICMSTot, ["vBC"]), 2)}</td>
          <td>${fmtNumber(getTextPath(ICMSTot, ["vICMS"]), 2)}</td>
          <td>${fmtNumber(getTextPath(ICMSTot, ["vBCST"]), 2)}</td>
          <td>${fmtNumber(getTextPath(ICMSTot, ["vST"]), 2)}</td>
          <td>${fmtNumber(getTextPath(ICMSTot, ["vOutro"]), 2)}</td>
          <td>${fmtNumber(getTextPath(ICMSTot, ["vFCPST"]), 2)}</td>
          <td>${fmtNumber(getTextPath(ICMSTot, ["vIPI"]), 2)}</td>
          <td>${fmtNumber(getTextPath(ICMSTot, ["vProd"]), 2)}</td>
          <td>${fmtNumber(getTextPath(ICMSTot, ["vNF"]), 2)}</td>
        </tr>
      `;
      $id("totaisNfs").insertAdjacentHTML("beforeend", totHtml);
    }
  }
})();