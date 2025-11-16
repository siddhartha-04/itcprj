/*import { io } from "socket.io-client";

// Change this to match your backend server port
const socket = io("http://localhost:3000");

export default socket;*/

// socket.js — Socket.IO client with reconnection and CORS
import { io } from "socket.io-client";

const socket = io("http://localhost:3001", {
  transports: ["websocket"],           // prefer WebSocket
  withCredentials: true,               // send cookies/auth if needed
  reconnection: true,                  // auto-reconnect enabled
  reconnectionAttempts: Infinity,      // keep trying
  reconnectionDelay: 500,              // initial backoff
  reconnectionDelayMax: 5000,          // max backoff
  timeout: 20000,                      // connection attempt timeout (ms)
  // path: "/socket.io",               // uncomment if you changed server path
});

socket.on("connect_error", (err) => {
  console.warn("socket connect_error:", err?.message || err);
});
socket.on("reconnect_attempt", (n) => {
  console.log("socket reconnect_attempt:", n);
});
socket.on("disconnect", (reason) => {
  console.log("socket disconnect:", reason);
});

export default socket;
