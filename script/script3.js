// Variável global para armazenar o objeto SpeechSynthesisUtterance
var utterance;

// Variável global para controlar se a leitura está pausada
var leituraPausada = false;

// Variável global para armazenar os parágrafos da história
var paragrafos = [];
var indiceAtual = 0;

// Função para iniciar a leitura da história
function iniciarLeitura() {
    // Obtém todos os parágrafos da história
    paragrafos = document.getElementsByClassName('paragrafo');
	
	// Reinicia o índice dos parágrafos
    indiceAtual = 0;

    // Inicializa o objeto SpeechSynthesisUtterance
    utterance = new SpeechSynthesisUtterance();

    // Configura a linguagem para o português do Brasil
    utterance.lang = 'pt-BR';

    // Define a voz do Google em português do Brasil
    utterance.voiceURI = 'Google português do Brasil';

    // Limpa o texto existente do objeto utterance
    utterance.text = '';

    // Inicia a leitura do primeiro parágrafo
    lerProximoParagrafo();
}

// Função para ler o próximo parágrafo
function lerProximoParagrafo() {
    // Verifica se ainda há parágrafos para ler
    if (indiceAtual < paragrafos.length) {
        // Adiciona o texto do próximo parágrafo ao objeto utterance
        utterance.text = paragrafos[indiceAtual].textContent;
        
        // Avança para o próximo parágrafo
        indiceAtual++;

        // Inicia a leitura do parágrafo atual
        window.speechSynthesis.speak(utterance);
    }
}

// Função para pausar ou retomar a leitura
function pausarOuRetomarLeitura() {
    if (window.speechSynthesis.speaking) {
        if (!leituraPausada) {
            window.speechSynthesis.pause();
            leituraPausada = true;
        } else {
            window.speechSynthesis.resume();
            leituraPausada = false;
        }
    }
}

// Função para parar a leitura
function pararLeitura() {
    if (window.speechSynthesis.speaking || window.speechSynthesis.paused) {
        window.speechSynthesis.cancel();
        leituraPausada = false; // Reseta o estado da leitura pausada
    }
}