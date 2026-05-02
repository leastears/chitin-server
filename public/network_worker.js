/**
 * Chitin Network Web Worker
 * Держит WebSocket соединение активным даже когда основной тред Godot приостановлен браузером
 */

let socket = null;
let isConnected = false;
let reconnectTimer = null;
let serverUrl = "";

// Пингер чтобы соединение не падало
const PING_INTERVAL = 25000;
let pingTimer = null;

self.onmessage = function(e) {
    const msg = e.data;
    
    switch(msg.type) {
        case "connect":
            serverUrl = msg.url;
            connect();
            break;
            
        case "send":
            if (socket && socket.readyState === WebSocket.OPEN) {
                socket.send(msg.data);
            }
            break;
            
        case "disconnect":
            close();
            break;
    }
}

function connect() {
    if (socket) {
        socket.close();
    }
    
    socket = new WebSocket(serverUrl);
    
    socket.onopen = function() {
        isConnected = true;
        self.postMessage({ type: "connected" });
        
        // Запускаем пинг
        pingTimer = setInterval(() => {
            if (socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: "ping" }));
            }
        }, PING_INTERVAL);
    }
    
    socket.onmessage = function(event) {
        self.postMessage({
            type: "message",
            data: event.data
        });
    }
    
    socket.onclose = function() {
        isConnected = false;
        clearInterval(pingTimer);
        self.postMessage({ type: "disconnected" });
        
        // Автоматический реконнект
        reconnectTimer = setTimeout(connect, 3000);
    }
    
    socket.onerror = function(err) {
        self.postMessage({ type: "error", error: err });
    }
}

function close() {
    clearTimeout(reconnectTimer);
    clearInterval(pingTimer);
    
    if (socket) {
        socket.close();
        socket = null;
    }
    
    isConnected = false;
}