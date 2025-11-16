import React, { useState, useEffect, useRef } from "react";
import { io } from "socket.io-client";  // ✅ FIXED: Use named import
import "./App.css";

// Connect to backend on port 3001
const socket = io("http://localhost:3001", {
  transports: ["websocket", "polling"],
  withCredentials: true,  // ✅ ADDED: For CORS
});

function App() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [isConnected, setIsConnected] = useState(false);  // ✅ ADDED: Track connection
  const chatEndRef = useRef(null);

  // Auto scroll to bottom
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Socket.io connection and event listeners
  useEffect(() => {
    // Connection events
    const handleConnect = () => {
      console.log("✅ Connected to server");
      setIsConnected(true);
    };

    const handleDisconnect = () => {
      console.log("❌ Disconnected from server");
      setIsConnected(false);
    };

    const handleConnectError = (error) => {
      console.error("Connection error:", error);
    };

    // Bot message event
    const handleBotMessage = (message) => {
      console.log("📨 Bot message:", message);
      appendMessage("bot", message);
    };

    // Register listeners
    socket.on("connect", handleConnect);
    socket.on("disconnect", handleDisconnect);
    socket.on("connect_error", handleConnectError);
    socket.on("bot_message", handleBotMessage);

    // Cleanup on unmount
    return () => {
      socket.off("connect", handleConnect);
      socket.off("disconnect", handleDisconnect);
      socket.off("connect_error", handleConnectError);
      socket.off("bot_message", handleBotMessage);
    };
  }, []);

  const appendMessage = (sender, text) => {
    setMessages((prev) => [...prev, { sender, text }]);
  };

  const sendMessage = () => {
    if (!input.trim()) return;
    if (!isConnected) {
      appendMessage("bot", "❌ Not connected to server. Please refresh the page.");
      return;
    }

    const text = input.trim();
    appendMessage("user", text);
    console.log("📤 Sending message:", text);
    socket.emit("user_message", text);
    setInput("");
  };

  const handleKeyPress = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <div className="background">
      <div className="chat-wrapper">
        <div className="chat-container">
          <header className="chat-header">
            <div className="bot-info">
              <img src="/bot.jpg" alt="Bot Avatar" className="bot-avatar" />
              <div className="bot-details">
                <h2>Azure DevOps Assistant</h2>
                <p className="status">
                  <span className={`status-dot ${isConnected ? "connected" : "disconnected"}`}></span>
                  {isConnected ? "Online" : "Offline"}
                </p>
              </div>
            </div>
          </header>

          <div className="chat-box">
            {messages.length === 0 && (
              <div className="message bot-message">
                <div>👋 Hi! I'm your Azure DevOps Assistant.<br/>Type <b>help</b> to see what I can do!</div>
              </div>
            )}
            {messages.map((msg, i) => (
              <div
                key={i}
                className={`message ${
                  msg.sender === "bot" ? "bot-message" : "user-message"
                }`}
                dangerouslySetInnerHTML={{ __html: msg.text }}
              ></div>
            ))}
            <div ref={chatEndRef}></div>
          </div>

          <div className="input-area">
            <input
              type="text"
              placeholder="Ask me anything..."
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyPress}
              disabled={!isConnected}
            />
            <button
              className="send-btn"
              onClick={sendMessage}
              disabled={!isConnected}
              title={isConnected ? "Send" : "Connecting..."}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="22"
                height="22"
                fill="none"
                stroke="#fff"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M22 2L11 13"></path>
                <path d="M22 2L15 22L11 13L2 9L22 2Z"></path>
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
