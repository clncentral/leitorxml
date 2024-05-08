
function carregar(fileInput) {
    var file = fileInput.files[0];
    var fileURL = URL.createObjectURL(file);
    var xhttp = new XMLHttpRequest();
    xhttp.onreadystatechange = function() {
        if (this.readyState == 4 && this.status == 200) {
            carregarXML(this)
        }
    };

    xhttp.open("GET", fileURL, true);
    xhttp.send();

    if(Number(file.size) >= 0){
      document.getElementById('tudo').style.display = 'block'
    }
}

function carregarXML(xml) {
    var xmlDoc = xml.responseXML

  
	$(xmlDoc).find("infNFe>det").each( function() {
    var unidade, vlunid, quntidade, pis, confis, vtotal
        $(this).find("prod>uCom").text() == $(this).find("prod>uTrib").text() ? unidade = $(this).find("prod>uCom").text() : unidade = $(this).find("prod>uCom").text()+"<br>"+$(this).find("prod>uTrib").text()
        $(this).find("prod>qCom").text() == $(this).find("prod>qTrib").text() ? quntidade = Number($(this).find("prod>qCom").text()).toLocaleString('pt-br', {minimumFractionDigits: 3, maximumFractionDigits: 3}) : quntidade = Number($(this).find("prod>qCom").text()).toLocaleString('pt-br', {minimumFractionDigits: 3, maximumFractionDigits: 3})+"<br>"+Number($(this).find("prod>qTrib").text()).toLocaleString('pt-br', {minimumFractionDigits: 3, maximumFractionDigits: 3})
        $(this).find("prod>vUnCom").text() == $(this).find("prod>vUnTrib").text() ? vlunid = Number($(this).find("prod>vUnCom").text()).toLocaleString('pt-br', {minimumFractionDigits: 2, maximumFractionDigits: 2}) : vlunid = Number($(this).find("prod>vUnCom").text()).toLocaleString('pt-br', {minimumFractionDigits: 2, maximumFractionDigits: 2}) +"<br>"+Number($(this).find("prod>vUnTrib").text()).toLocaleString('pt-br', {minimumFractionDigits: 2, maximumFractionDigits: 2})
        pis = Number($(this).find("imposto>PIS>>pPIS").text()).toFixed(2)
		confis = Number($(this).find("imposto>COFINS>>pCOFINS").text()).toFixed(2)
        vtotal = Number($(this).find("prod>vProd").text()).toLocaleString('pt-br', {minimumFractionDigits: 2, maximumFractionDigits: 2})
        var info = ""
			info += "<tr class='table-row'>"
			info += "<td class='nitem'>"+$(this).attr("nItem")+"</td>"
			info += "<td>"+$(this).find("prod>cProd").text()+"<br>"+$(this).find("prod>cEAN").text()+"</td>"
			info += "<td>"+$(this).find("prod>xProd").text()+"<br>"+$(this).find("det>infAdProd").text()+" - "+"<font style='color: red;'>"+$(this).find("prod>xPed").text()+"</font></td>"
			info += "<td>"+$(this).find("prod>NCM").text()+"</td>"
			info += "<td>"+$(this).find("imposto>ICMS>>orig").text()+$(this).find("imposto>ICMS>>CST").text()+"</td>"
			info += "<td>"+$(this).find("prod>CFOP").text()+"</td>"
			info += "<td class='coluna1 coluna-oculta'>"+$(this).find("prod>CEST").text()+"</td>"
			info += "<td>"+unidade+"</td>"
			info += "<td class='num'>"+quntidade+"</td>"
			info += "<td class='num'>"+vlunid+"</td>"
			info += "<td class='num'>"+vtotal+"</td>"
			info += "<td class='coluna1 coluna-oculta'>"+$(this).find("prod>vDesc").text()+"</td>"
			info += "<td class='coluna1 coluna-oculta'>"+$(this).find("imposto>ICMS>>vICMSDeson").text()+"</td>"
			info += "<td class='coluna1 coluna-oculta'>"+$(this).find("prod>vOutro").text()+"</td>"
			info += "<td class='coluna1 coluna-oculta'>"+$(this).find("imposto>ICMS>>vFCPST").text()+"</td>"
			info += "<td>"+Number($(this).find("imposto>ICMS>>vBC").text()).toLocaleString('pt-br', {minimumFractionDigits: 2, maximumFractionDigits: 2})+"</td>"
			info += "<td>"+Number($(this).find("imposto>ICMS>>pICMS").text())+"</td>"
			info += "<td>"+Number($(this).find("imposto>ICMS>>vICMS").text()).toLocaleString('pt-br', {minimumFractionDigits: 2, maximumFractionDigits: 2})+"</td>"
			info += "<td>"+Number($(this).find("imposto>ICMS>>vBCST").text()).toLocaleString('pt-br', {minimumFractionDigits: 2, maximumFractionDigits: 2})+"</td>"
			info += "<td>"+Number($(this).find("imposto>ICMS>>vICMSST").text()).toLocaleString('pt-br', {minimumFractionDigits: 2, maximumFractionDigits: 2})+"</td>"
			
			info += "<td>"+Number($(this).find("imposto>IPI>>vIPI").text()).toLocaleString('pt-br', {minimumFractionDigits: 2, maximumFractionDigits: 2})+"</td>"
			info += "<td>"+Number($(this).find("imposto>IPI>>pIPI").text())+"</td>"
			info += "<td class='coluna1 coluna-oculta'>"+$(this).find("imposto>ICMS>>pMVAST").text()+"</td>"
			info += "<td class='coluna1 coluna-oculta'>"+$(this).find("imposto>IPI>IPINT>CST").text()+"</td>"
			info += "<td class='coluna1 coluna-oculta'>"+$(this).find("imposto>PIS>>CST").text()+"<br>"+$(this).find("imposto>COFINS>>CST").text()+"</td>"
			info += "<td class='coluna1 coluna-oculta'>"+pis+"</td>"
			info += "<td class='coluna1 coluna-oculta'>"+confis+"</td>"
			"</tr>";
        $("#tbody").append(info);
        $("#divarquivo").css('display', 'none')
		$("#divarquivo2").css('display', 'none')
        $("#dadosEnxuto").css('top', '1px')

 
});





// Tabela de produtos  
       
       $(xmlDoc).find("nfeProc").each( function() {
        var nf = ""
          nf += "<tr>"
          nf += "<td><label>Razão</label/>"+$(this).find("emit>xNome").text()+"</td>"
          nf += "<td style='width: 120px;'><label>CNPJ Emit.</label/>"+$(this).find("emit>CNPJ").text()+"</td>"
          nf += "<td style='width: 120px;'><label>IE Emit.</label/>"+$(this).find("emit>IE").text()+"</td>"
          nf += "<td><label>Município</label/>"+$(this).find("enderEmit>xMun").text()+", "+$(this).find("enderEmit>UF").text()+" - Cód.: "+$(this).find("enderEmit>cMun").text()+"</td>"
          nf +="</tr>"
          nf += "<tr>"
          nf += "<td colspan='4'><label>Natureza da Operação</label/>"+$(this).find("ide>natOp").text()+"</td>"
          nf += "</tr>"
        $("#nf").append(nf)
       })
			// Teste se Autorizada
		// Verifica se a tag nfeProc está presente no XML
	if ($(xmlDoc).find("nfeProc").length > 0) {
    // Se a tag nfeProc estiver presente, execute o código relacionado a ela

    $(xmlDoc).find("nfeProc").each( function() {
        var tpNF = $(this).find("ide>tpNF").text()
        if(tpNF == 0){
          tpNF = 'Entrada'
          $("#tudo").css('color', 'red')
		  document.getElementById('tudo').style.display = 'none'
		  document.getElementById("alerta").style.display = "block";
          //$(alert(`NF TIPO: 0 - ENTRADA`))          
        }else{
          tpNF = 'Saida'
        }
        var razao = $(this).find("dest>xNome").text()
        var loja
        switch(String($(this).find("dest>CNPJ").text()) & String($(this).find("dest>IE").text())){
            case '05789313000194' & '244762219116':
            loja = 'Central'
            break
            case '05789313000607' & '276000625118':
            loja = 'Loja 02'
            break
            case '05789313000518' & '244121997119':
            loja = 'Loja 03'
            break
            case '05789313000437' & '587055882112':
            loja = 'Loja 06'
            break
            case'05789313000356' & '535114683110':
            loja = 'Loja 07'
            break
            case'05789313000780' & '244341560119':
            loja = 'Loja 08'
            break
            case '05789313000860' & '417146805119':
            loja = 'Loja 09'
            break
            case'05789313000275' & '587144653116':
            loja = 'Loja 10'
            break
            case'05789313001247' & '671185036117':
            loja = 'CD'
            break
            case'05789313001328' & '122100090119':
            loja = 'Exn Aquí'
            break
            default:
            loja = "ERRO: CNPJ/IE"
            
            break
        }
	var dataemissao =  new Date($(this).find("ide>dhEmi").text())
	var datasaida = new Date($(this).find("ide>dhSaiEnt").text())
	var emiss =  dataemissao.toLocaleDateString()
	var saida =  datasaida.toLocaleDateString()
        var enx = ""
        enx += "<tr>"
        enx += "<td><label>Nro NF</label/>"+$(this).find("ide>nNF").text()+"</td>"
        if(tpNF == 'Entrada'){
          enx += "<td><label>Tipo</label/>"+tpNF+"</td>"
        }
        if(loja == "ERRO: CNPJ/IE"){
		enx += "<td id='rz'><label>Razão</label/>"+razao+"</td>"
	}else{
		enx += "<td id='lj'><label>Loja</label/>"+loja+"</td>"

	}
        enx += "<td><label>Município</label>"+$(this).find("enderDest>xMun").text()+", "+$(this).find("enderDest>UF").text()+" - Cód.: "+$(this).find("enderDest>cMun").text()+"</td>"
        enx += "<td colspan='2'><label>Endereço</label>"+$(this).find("enderDest>xLgr").text()+", "+$(this).find("enderDest>nro").text()+"</td>"
        enx +="</tr>"
        enx += "<tr>"
        enx += "<td colspan='3'><label>Chave de Acesso</label>"+$(this).find("chNFe").text()+"</td>"
	enx += "<td><label>Emissão</label>"+emiss+"</td>"
	enx += "<td><label>Saída</label>"+saida+"</td>"
        enx += "</tr>"
        $("#enx").append(enx)
        $("head").append('<script src="script/slect.js"></script>')
        if(loja == 'ERRO: CNPJ/IE'){
          $('body').css('color', 'red')
	  $('#rz').css({'font-family': 'Verdana', 'color':'blue' })
	
          $(alert(`Atenção!! Essa NF Não é do Enxuto.\nNF do ${razao}`))
		loja =  razao
        }
		$("#lj").css('color', 'red')
      })

} else {
    // Se a tag nfeProc não estiver presente, faça o tratamento apropriado aqui...
    alert("XML inválido. XML Recebido Antes de Autorizada na SEFAZ");
	
    // Ou execute qualquer outra ação necessária para lidar com esse cenário
	
	$(xmlDoc).find("infNFe").each( function() {
        var nf = ""
          nf += "<tr>"
          nf += "<td><label>Razão</label/>"+$(this).find("emit>xNome").text()+"</td>"
          nf += "<td style='width: 120px;'><label>CNPJ Emit.</label/>"+$(this).find("emit>CNPJ").text()+"</td>"
          nf += "<td style='width: 120px;'><label>IE Emit.</label/>"+$(this).find("emit>IE").text()+"</td>"
          nf += "<td><label>Município</label/>"+$(this).find("enderEmit>xMun").text()+", "+$(this).find("enderEmit>UF").text()+" - Cód.: "+$(this).find("enderEmit>cMun").text()+"</td>"
          nf +="</tr>"
          nf += "<tr>"
          nf += "<td colspan='4'><label>Natureza da Operação</label/>"+$(this).find("ide>natOp").text()+"</td>"
          nf += "</tr>"
        $("#nf").append(nf)
       })
	
	$(xmlDoc).find("infNFe").each( function() {
        var tpNF = $(this).find("ide>tpNF").text()
        if(tpNF == 0){
          tpNF = 'Entrada'
          $("#tudo").css('color', 'red')
		  document.getElementById('tudo').style.display = 'none'
		  document.getElementById("alerta").style.display = "block";
          //$(alert(`NF TIPO: 0 - ENTRADA`))          
        }else{
          tpNF = 'Saida'
        }
        var razao = $(this).find("dest>xNome").text()
        var loja
        switch(String($(this).find("dest>CNPJ").text()) & String($(this).find("dest>IE").text())){
            case '05789313000194' & '244762219116':
            loja = 'Central'
            break
            case '05789313000607' & '276000625118':
            loja = 'Loja 02'
            break
            case '05789313000518' & '244121997119':
            loja = 'Loja 03'
            break
            case '05789313000437' & '587055882112':
            loja = 'Loja 06'
            break
            case'05789313000356' & '535114683110':
            loja = 'Loja 07'
            break
            case'05789313000780' & '244341560119':
            loja = 'Loja 08'
            break
            case '05789313000860' & '417146805119':
            loja = 'Loja 09'
            break
            case'05789313000275' & '587144653116':
            loja = 'Loja 10'
            break
            case'05789313001247' & '671185036117':
            loja = 'CD'
            break
            case'05789313001328' & '122100090119':
            loja = 'Exn Aquí'
            break
            default:
            loja = "ERRO: CNPJ/IE"
            
            break
        }
	var dataemissao =  new Date($(this).find("ide>dhEmi").text())
	var datasaida = new Date($(this).find("ide>dhSaiEnt").text())
	var emiss =  dataemissao.toLocaleDateString()
	var saida =  datasaida.toLocaleDateString()
        var enx = ""
        enx += "<tr>"
        enx += "<td><label>Nro NF</label/>"+$(this).find("ide>nNF").text()+"</td>"
        if(tpNF == 'Entrada'){
          enx += "<td><label>Tipo</label/>"+tpNF+"</td>"
        }
        if(loja == "ERRO: CNPJ/IE"){
		enx += "<td id='rz'><label>Razão</label/>"+razao+"</td>"
	}else{
		enx += "<td id='lj'><label>Loja</label/>"+loja+"</td>"

	}
        enx += "<td><label>Município</label>"+$(this).find("enderDest>xMun").text()+", "+$(this).find("enderDest>UF").text()+" - Cód.: "+$(this).find("enderDest>cMun").text()+"</td>"
        enx += "<td colspan='2'><label>Endereço</label>"+$(this).find("enderDest>xLgr").text()+", "+$(this).find("enderDest>nro").text()+"</td>"
        enx +="</tr>"
        enx += "<tr>"
        enx += "<td colspan='3'><label>Chave de Acesso</label>"+$(this).find("chNFe").text()+"</td>"
	enx += "<td><label>Emissão</label>"+emiss+"</td>"
	enx += "<td><label>Saída</label>"+saida+"</td>"
        enx += "</tr>"
        $("#enx").append(enx)
        $("head").append('<script src="script/slect.js"></script>')
        if(loja == 'ERRO: CNPJ/IE'){
          $('body').css('color', 'red')
	  $('#rz').css({'font-family': 'Verdana', 'color':'blue' })
	
          $(alert(`Atenção!! Essa NF Não é do Enxuto.\nNF do ${razao}`))
		loja =  razao
        }
		$("#lj").css('color', 'red')
		
      })
	  $("body").append("<div id='mensagemNF'>XML Inválido, não Autorizado!!</div>");
    // Adicione estilos CSS para a mensagem
    $("#mensagemNF").css({
        "position": "absolute",
		"top": "93px",
		"right": "50%",
		"transform": "translateX(50%)",
		"padding": "10px",
		"background-color": "pink",
		"color": "white",
		"font-size": "36px",
		"font-weight": "bold",
		"border-radius": "5px",
		"z-index": "9999"
    });
	 
}


       $(xmlDoc).find("cobr>dup").each( function() {
        var vencimento = ""
        vencimento += "<tr>"
        vencimento += "<tr><td class='c1'>Nº</td><td class='c2'>"+$(this).find("nDup").text()+"</td></tr>"
        vencimento += "<tr><td class='c1'>Venc.</td><td class='c2'>"+$(this).find("dVenc").text()+"</td></tr>"
        vencimento += "<tr><td class='c1'>Valor</td><td class='c2'>"+Number($(this).find("cobr>dup>vDup").text()).toLocaleString('pt-BR', { style: 'currency', currency:'BRL'})+"</td></tr>"
        "</tr>"
        $("#ve1").append('<div id="" class="vencimento"><table class="GeralXslt box"><tbody>'+vencimento+'</tbody></table></div>')
       })

       

       $(xmlDoc).find("nfeProc").each( function() {
        var infAdic = ""
        infAdic += "<tr>"
        infAdic += "<tr><td>"+$(this).find("infAdFisc").text()+"</td></tr>"
        infAdic += "<tr><td>"+$(this).find("infCpl").text()+"</td></tr>"
		infAdic += "<tr><td style='color: red; font-weight: bold; font-size: 16px;'>"+"Pedido: "+$(this).find("compra>xPed").text()+"</td></tr>"
		infAdic += "<tr><td>"+"NF de Ref.: "+$(this).find("ide>NFref").text()+"</td></tr>"
       "</tr>"
        $("#dadosAdic").append(infAdic)
       })

       $(xmlDoc).find("transp").each( function() {
        var tpfrete = $(this).find("modFrete").text()
        if(tpfrete == 1){
          $("#frete").append('Frete<br>a<br>Pagar').css({
            'display': 'block',
            'font-weight': 'bolder',
            'color': '#ff0022',
            'text-align': 'center'
            })
          $("#frete").css({'background-image': 'url(img/frete.jpg)', 'background-repeat': 'no-repeat'})
          $(alert('Frete por conta do Enxuto'))

        }

       })

       $(xmlDoc).find("nfeProc").each( function() {
        var chave = "Nf: "+$(this).find("ide>nNF").text()
	var tl = document.getElementById("titulo");
	tl.innerHTML = "";
        $('title').append(chave);
       })



       $(xmlDoc).find("total>ICMSTot").each( function() {
        var infAdic = ""
        infAdic += "<tr>"
        infAdic += "<td>"+Number($(this).find("vDesc").text()).toLocaleString('pt-br', {minimumFractionDigits: 2, maximumFractionDigits: 2})+"</td>"
        infAdic += "<td>"+Number($(this).find("vICMSDeson").text()).toLocaleString('pt-br', {minimumFractionDigits: 2, maximumFractionDigits: 2})+"</td>"
        infAdic += "<td>"+Number($(this).find("vBC").text()).toLocaleString('pt-br', {minimumFractionDigits: 2, maximumFractionDigits: 2})+"</td>"
        infAdic += "<td>"+Number($(this).find("vICMS").text()).toLocaleString('pt-br', {minimumFractionDigits: 2, maximumFractionDigits: 2})+"</td>"
        infAdic += "<td>"+Number($(this).find("vBCST").text()).toLocaleString('pt-br', {minimumFractionDigits: 2, maximumFractionDigits: 2})+"</td>"
        infAdic += "<td>"+Number($(this).find("vST").text()).toLocaleString('pt-br', {minimumFractionDigits: 2, maximumFractionDigits: 2})+"</td>"
        infAdic += "<td>"+Number($(this).find("vOutro").text()).toLocaleString('pt-br', {minimumFractionDigits: 2, maximumFractionDigits: 2})+"</td>"
        infAdic += "<td>"+Number($(this).find("vFCPST").text()).toLocaleString('pt-br', {minimumFractionDigits: 2, maximumFractionDigits: 2})+"</td>"
        infAdic += "<td>"+Number($(this).find("vIPI").text()).toLocaleString('pt-br', {minimumFractionDigits: 2, maximumFractionDigits: 2})+"</td>"
        infAdic += "<td>"+Number($(this).find("vProd").text()).toLocaleString('pt-br', {minimumFractionDigits: 2, maximumFractionDigits: 2})+"</td>"
	      infAdic += "<td>"+Number($(this).find("vNF").text()).toLocaleString('pt-br', {minimumFractionDigits: 2, maximumFractionDigits: 2})+"</td>"
       "</tr>"
        $("#totaisNfs").append(infAdic)
       })


//Selecionar

// selecionar 
	   
var tabela = document.getElementById("tabelaProdutos");
var linhas = tabela.getElementsByTagName("tr");

for(var i = 0; i < linhas.length; i++){
	var linha = linhas[i];
	linha.addEventListener("click", function(){
//Adicionar ao atual
	selLinha(this, false); //Selecione apenas um
//selLinha(this, true); //Selecione quantos quiser
});
}

/**
Caso passe true, você pode selecionar multiplas linhas.
Caso passe false, você só pode selecionar uma linha por vez.
**/
function selLinha(linha, multiplos){
	if(!multiplos){
		var linhas = linha.parentElement.getElementsByTagName("tr");
	for(var i = 0; i < linhas.length; i++){
		var linha_ = linhas[i];
		linha_.classList.remove("selecionado");    
}
}
		linha.classList.toggle("selecionado");
}

}
