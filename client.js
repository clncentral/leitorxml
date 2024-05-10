document.addEventListener('DOMContentLoaded', () => {
    const socket = io();
    const chatBox = document.getElementById('chat-box');
    const nameInput = document.getElementById('name');
    const messageInput = document.getElementById('message');
    const sendButton = document.getElementById('send-btn');

    sendButton.addEventListener('click', () => {
        const name = nameInput.value;
        const message = messageInput.value;
        sendMessage(name, message);
    });

    function sendMessage(name, message) {
        if (name && message) {
            socket.emit('chatMessage', { name, message });
            messageInput.value = '';
        }
    }

    socket.on('chatMessage', (data) => {
        const { name, message } = data;
        if (name && message) {
            const newMessage = document.createElement('p');
            newMessage.innerText = `${name}: ${message}`;
            chatBox.appendChild(newMessage);
        }
    });
});
