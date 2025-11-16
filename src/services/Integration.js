// aiIntegration.js
/*import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";
dotenv.config();

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY,
});
const MODEL = (process.env.GOOGLE_GEMINI_MODEL || "gemini-2.5-flash").trim();

async function withRetry(fn, { retries = 3, baseDelayMs = 500 } = {}) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      const status = err?.status ?? err?.code;
      const msg = String(err?.message || "");
      const retryable =
        (typeof status === "number" && status >= 500) ||
        /(ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|INTERNAL)/i.test(msg);
      if (!retryable || attempt >= retries) throw err;
      const delay = baseDelayMs * Math.pow(2, attempt);
      await new Promise(r => setTimeout(r, delay));
      attempt++;
    }
  }
}

export async function queryWithAI(userMessage, context = {}) {
  const contents = `You are an Azure DevOps assistant.

Context:
${JSON.stringify(context, null, 2)}

Provide concise answers about Azure Boards data using <br> for new lines and <b> for emphasis.

User question: ${userMessage}`;
  const res = await withRetry(() =>
    ai.models.generateContent({ model: MODEL, contents })
  );
  return res.text || "";
}

export async function queryWithTools(userMessage, availableTools = []) {
  const tools = availableTools.map(t => `- ${t.name}: ${t.description}`).join("\n");
  const contents = `You are an Azure DevOps assistant with these tools:
${tools}

Explain which tool you would use and why.

User: ${userMessage}`;
  const res = await withRetry(() =>
    ai.models.generateContent({ model: MODEL, contents })
  );
  return { content: res.text || "", toolCall: null };
}

export async function streamAIResponse(userMessage, context = {}) {
  try {
    const contents = `You are an Azure DevOps assistant.
Context:
${JSON.stringify(context, null, 2)}

User: ${userMessage}`;
    const stream = await ai.models.generateContentStream({ model: MODEL, contents });
    return stream;
  } catch {
    return null;
  }
}

export function getGeminiModel() {
  return MODEL;
}*/
// integration.js — OpenRouter + DeepSeek V3.1 (Chat Completions, OpenAI-compatible)
// integration.js — OpenRouter + DeepSeek V3.1 (Chat Completions, OpenAI-compatible)
/*import dotenv from "dotenv";
import axios from "axios";
dotenv.config();

const OR_BASE = (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
const OR_KEY = process.env.OPENROUTER_API_KEY;
const OR_MODEL = (process.env.OPENROUTER_MODEL || "deepseek/deepseek-chat-v3.1:free").trim();
const APP_URL = process.env.PUBLIC_APP_URL || "http://localhost:3000";
const APP_NAME = process.env.APP_NAME || "Azure DevOps Assistant";

async function withRetry(fn, { retries = 3, baseDelayMs = 500 } = {}) {
  let attempt = 0;
  while (true) {
    try { return await fn(); }
    catch (err) {
      const status = err?.response?.status ?? err?.code;
      const msg = String(err?.message || "");
      const retryable =
        (typeof status === "number" && (status >= 500 || status === 429 || status === 408)) ||
        /(ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|timeout)/i.test(msg);
      if (!retryable || attempt >= retries) throw err;
      await new Promise(r => setTimeout(r, baseDelayMs * Math.pow(2, attempt++)));
    }
  }
}

export function getModelName() {
  return OR_MODEL;
}

function openRouterHeaders() {
  return {
    Authorization: `Bearer ${OR_KEY}`,       // API key bearer auth (required)
    "Content-Type": "application/json",
    "HTTP-Referer": APP_URL,                  // attribution header (recommended by OpenRouter)
    "X-Title": APP_NAME,                      // attribution header (recommended by OpenRouter)
  };
}

export async function queryWithAI(userMessage, context = {}) {
  if (!OR_KEY) return "(AI disabled: OPENROUTER_API_KEY missing)";

  const headers = openRouterHeaders();
  const messages = [
    { role: "system", content: "You are an Azure DevOps assistant. Use <br> for new lines and <b> for emphasis." },
    { role: "system", content: `Context:\n${JSON.stringify(context, null, 2)}` },
    { role: "user", content: userMessage },
  ];

  const body = {
    model: OR_MODEL,   // e.g., deepseek/deepseek-chat-v3.1:free
    messages,
    temperature: 0.2,
    // stream: true, // enable if you implement SSE parsing in your server/UI
  };

  const url = `${OR_BASE}/chat/completions`;
  try {
    const resp = await withRetry(() => axios.post(url, body, { headers, timeout: 30000 }));
    return resp.data?.choices?.[0]?.message?.content || "";
  } catch (err) {
    // Helpful guidance for common OpenRouter policy/auth errors
    const status = err?.response?.status;
    const emsg = err?.response?.data?.error?.message || err?.message || "";
    if (status === 404 && /No endpoints found matching your data policy/i.test(emsg)) {
      return "AI is unavailable: OpenRouter privacy settings block this model. Enable free endpoints that may train/publish or disable ZDR-only in your OpenRouter privacy settings, then retry.";
    }
    if (status === 401 && /No cookie auth credentials/i.test(emsg)) {
      return "AI is unavailable: missing/invalid API auth. Re-enter the OpenRouter API key and ensure requests include Authorization: Bearer <key> with attribution headers.";
    }
    throw err;
  }
}

// Placeholder for streaming support (SSE) if you add progressive rendering later
export async function streamAIResponse() {
  return null;
}*/
// Integration.js — OpenRouter chat completions with compact context and 429 backoff

// Integration.js — OpenRouter chat with compact context, retries, and non-empty fallback

import axios from "axios";

// Endpoint and key
const OPENROUTER_URL =
  (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/+$/, "") +
  "/chat/completions";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_KEY || "";

// Model guard: prefer explicit OpenRouter model ids like "openai/gpt-4o-mini"
function resolveModel() {
  const raw = (process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini").trim();
  // If user set something like "gpt-4-turbo" or a bare id, auto-correct to a safe default
  const looksBareOpenAI = /^gpt-|^o3|^o1|^text-/.test(raw);
  const isOldBare = looksBareOpenAI && !raw.includes("/");
  if (isOldBare) return "openai/gpt-4o-mini";
  return raw;
}
const MODEL = resolveModel();

function compactSprintContext(ctx = {}) {
  try {
    const pick = (s) => ({
      id: s.id,
      title: String(s.title || "").slice(0, 140),
      state: s.state,
      type: s.type,
    });

    const current = {
      name: ctx.currentSprint || null,
      stats: ctx.currentSprintStats
        ? {
            total: ctx.currentSprintStats.total || 0,
            todo: ctx.currentSprintStats.todo || 0,
            doing: ctx.currentSprintStats.doing || 0,
            done: ctx.currentSprintStats.done || 0,
            remainingWork: ctx.currentSprintStats.remainingWork || 0,
            storyPoints: ctx.currentSprintStats.storyPoints || 0,
          }
        : { total: 0, todo: 0, doing: 0, done: 0, remainingWork: 0, storyPoints: 0 },
      items: (ctx.currentSprintItems || []).slice(0, 8).map(pick),
    };

    const lastTwo = (ctx.lastTwoSprints || [])
      .slice(0, 2)
      .map((b) => ({
        sprintName: b.sprintName,
        items: b.items,
        todo: b.todo,
        doing: b.doing,
        done: b.done,
      }));

    return { now: ctx.now || null, current, lastTwo };
  } catch {
    return { now: null, current: null, lastTwo: [] };
  }
}

function buildPrompt(userText, compact) {
  const system = [
  "You are an intelligent Azure Boards assistant integrated with Azure DevOps data.",
  "Your job is to understand and summarize sprint, task, issue, and work item information naturally and clearly.",
  "",
  "Rules:",
  "- Use the data provided from Azure DevOps (titles, descriptions, states, story points, and child tasks) to reason accurately.",
  "- Do not invent data or IDs — if something is missing, mention what to fetch next (e.g., 'Try listing tasks of Sprint 2').",
  "- Provide responses in natural language narrative or clear bullet points — easy for humans to read.",
  "- When summarizing sprints, include progress, trends, blockers, or completion status.",
  "- When describing a work item, include its title, description, related child tasks or links, and give a concise status overview.",
  "- Avoid raw JSON or code; give clean text summaries.",
  "- Be concise (4–6 bullets or 2–3 sentences) unless the user requests more detail.",
  "- If the user asks strategic questions (like launch timing or prioritization), reason clearly and justify your answer briefly.",
].join("\n");


  const context = [
    `Current sprint: ${compact?.current?.name || "unknown"}`,
    `Stats: total=${compact?.current?.stats?.total || 0}, todo=${compact?.current?.stats?.todo || 0}, doing=${compact?.current?.stats?.doing || 0}, done=${compact?.current?.stats?.done || 0}`,
    `Top items: ${(compact?.current?.items || []).map(i => `#${i.id} ${i.title} [${i.state}|${i.type}]`).join("; ").slice(0, 400)}`,
    `Last two sprints: ${(compact?.lastTwo || []).map(b => `${b.sprintName}: total=${b.items}, todo=${b.todo}, doing=${b.doing}, done=${b.done}`).join("; ")}`,
  ].join("\n");

  const user = [
    "User question:",
    String(userText || "").trim().slice(0, 2000),
  ].join("\n");

  return { system, context, user };
}

async function postWithBackoff(payload, headers, maxRetries = 3, initialDelayMs = 900) {
  let attempt = 0;
  let delay = initialDelayMs;
  // Add small jitter to reduce thundering herds
  const jitter = () => Math.floor(delay * (1 + 0.2 * Math.random()));

  while (true) {
    try {
      const res = await axios.post(OPENROUTER_URL, payload, { headers, timeout: 30000 });
      return res.data;
    } catch (err) {
      const status = err?.response?.status;
      const retryAfter = err?.response?.headers?.["retry-after"] || err?.response?.headers?.["retry-after-ms"];
      const retriable = status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
      if (!retriable || attempt >= maxRetries) throw err;

      let waitMs = jitter();
      if (retryAfter) {
        const sec = Number(retryAfter);
        const ms = Number.isNaN(sec) ? null : sec * 1000;
        if (ms && ms > 0) waitMs = Math.max(waitMs, ms);
      }
      await new Promise((r) => setTimeout(r, waitMs));
      attempt += 1;
      delay *= 2;
    }
  }
}

export function getModelName() {
  return MODEL;
}

export async function queryWithAI(userText, contextObj) {
  if (!OPENROUTER_API_KEY) {
    return "⚠️ AI is disabled (missing OPENROUTER_API_KEY).";
  }

  // Compact context
  const compact = compactSprintContext(contextObj);
  const { system, context, user } = buildPrompt(userText, compact);

  // Build messages
  const messages = [
    { role: "system", content: system },
    { role: "system", content: `Context:\n${context}` },
    { role: "user", content: user },
  ];

  // Tokens and temperature
  const maxTokens = Number(process.env.OPENROUTER_MAX_TOKENS || 400);
  const temperature = Number(process.env.OPENROUTER_TEMPERATURE || 0.3);

  // Payload
  const payload = {
    model: MODEL,
    messages,
    max_tokens: maxTokens,
    temperature,
    stream: false,
  };

  // OpenRouter headers
  const headers = {
    Authorization: `Bearer ${OPENROUTER_API_KEY}`,
    "Content-Type": "application/json",
    "HTTP-Referer": process.env.OPENROUTER_HTTP_REFERER || "http://localhost:3000",
    "X-Title": process.env.OPENROUTER_X_TITLE || "Azure DevOps Assistant",
  };

  try {
    const data = await postWithBackoff(payload, headers);

    // Log once to diagnose empties or model errors
    try {
      // eslint-disable-next-line no-console
      console.log("AI RAW RESPONSE:", JSON.stringify(data, null, 2));
    } catch (_) {}

    const text =
      data?.choices?.[0]?.message?.content?.trim() ||
      data?.choices?.[0]?.text?.trim() ||
      "";

    // Always return non-empty guidance to the UI
    return text || "⚠️ AI is temporarily rate limited or returned no content. Please try again in a few seconds.";
  } catch (e) {
    const status = e?.response?.status;
    if (status === 429) {
      return "⚠️ AI is temporarily rate limited. Please try again in a few seconds.";
    }
    return `⚠️ AI is unavailable right now (${status || "error"}). Please try again later.`;
  }
}


