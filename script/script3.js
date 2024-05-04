// Variável global para armazenar o objeto SpeechSynthesisUtterance
        var utterance;

        // Variável global para controlar se a leitura está pausada
        var leituraPausada = false;

        // Função para iniciar ou parar a leitura da história
        function iniciarOuPararLeitura() {
            if (!window.speechSynthesis.speaking && !window.speechSynthesis.paused) {
                iniciarLeitura();
            }
        }

        // Função para iniciar a leitura da história
        function iniciarLeitura() {
            // Obtém todos os parágrafos da história
            var paragrafos = document.getElementsByClassName('paragrafo');

            // Inicializa o objeto SpeechSynthesisUtterance
            utterance = new SpeechSynthesisUtterance();

            // Configura a linguagem para o português do Brasil
            utterance.lang = 'pt-BR';

            // Define a voz do Google em português do Brasil
            utterance.voiceURI = 'Google português do Brasil';

            // Limpa o texto existente do objeto utterance
            utterance.text = '';

            // Percorre todos os parágrafos da história
            for (var i = 0; i < paragrafos.length; i++) {
                // Adiciona o texto de cada parágrafo ao objeto utterance
                utterance.text += paragrafos[i].textContent + ' ';
            }

            // Inicia a leitura da história em voz alta
            window.speechSynthesis.speak(utterance);
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