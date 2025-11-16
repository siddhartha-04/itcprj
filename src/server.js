import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';

import { loadSprintData, getAllSprintsSummary, sprintCache } from './services/sprintDataLoader.js';
import { getModelName } from './services/Integration.js';
import { routeCommand } from './controllers/commandRouter.js';
import oauthRouter from './routes/OAuth.js';
import mcpServer from './routes/mcpServer.js';
import logger from './utils/logger.js';

dotenv.config();

const app = express();
const httpServer = createServer(app);
const PORT = process.env.PORT || 3001;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "http://localhost:3000,http://localhost:3001")
  .split(",")
  .map((s) => s.trim());

httpServer.keepAliveTimeout = 65000;
httpServer.headersTimeout = 67000;
httpServer.requestTimeout = 0;

const io = new Server(httpServer, {
  pingInterval: 25000,
  pingTimeout: 60000,
  cors: { origin: ALLOWED_ORIGINS, methods: ["GET", "POST"], credentials: true },
});

app.use(cors({ origin: ALLOWED_ORIGINS, methods: ["GET", "POST"], credentials: true }));
app.use(express.json());

const { AZURE_ORG_URL, AZURE_PROJECT, AZURE_PAT, OPENROUTER_API_KEY } = process.env;
if (!AZURE_ORG_URL || !AZURE_PROJECT || !AZURE_PAT) {
  logger.error("❌ Missing Azure DevOps config in .env (AZURE_ORG_URL, AZURE_PROJECT, AZURE_PAT)");
  process.exit(1);
}

const AI_ENABLED = !!OPENROUTER_API_KEY;
logger.info(AI_ENABLED ? `✨ OpenRouter AI enabled (model: ${getModelName()})` : "ℹ️ AI disabled");

// Routers
app.use('/oauth', oauthRouter);
app.use('/mcp', mcpServer);

io.on('connection', (socket) => {
  const sessionId = uuidv4();
  logger.info(`🟢 User connected: ${sessionId}`);

  socket.emit('bot_message', 'Hello! I’m your Azure Boards Assistant.<br>Loading sprint data...');

  setTimeout(() => {
    if (sprintCache.stories.length > 0) {
      socket.emit('bot_message', getAllSprintsSummary());
    } else {
      socket.emit('bot_message', '⚠️ Sprint data is still loading. Please wait...');
    }
    socket.emit('bot_message', "Type <b>help</b> to see what I can do!");
  }, 1500);

  socket.on('user_message', async (text) => {
    try {
      const reply = await routeCommand(text);
      socket.emit('bot_message', reply);
    } catch (err) {
      logger.error(`handleMessage error: ${err}`);
      socket.emit('bot_message', '⚠️ Sorry, something went wrong handling that request. Please try again.');
    }
  });

  socket.on('disconnect', () => {
    logger.info(`🔴 User disconnected: ${sessionId}`);
  });
});

// Startup
(async () => {
  logger.info('🚀 Starting Azure Boards Assistant...');
  await loadSprintData();
  setInterval(async () => {
    logger.info('🔄 Refreshing sprint data...');
    await loadSprintData();
  }, 15 * 60 * 1000);

  httpServer.listen(PORT, () => {
    logger.info(`Server at http://localhost:${PORT} (AI: ${AI_ENABLED ? `ENABLED (${getModelName()})` : 'DISABLED'})`);
  });
})();
