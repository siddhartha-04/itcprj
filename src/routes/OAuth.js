import express from "express";
import crypto from "crypto";
import dotenv from "dotenv";
dotenv.config();

const router = express.Router();

// In-memory storage (use Redis/DB in production)
const authCodes = new Map();
const accessTokens = new Map();
const clients = new Map();

// Register a default client for ChatGPT
const CHATGPT_CLIENT_ID = process.env.OAUTH_CLIENT_ID || "chatgpt-mcp-client";
const CHATGPT_CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET || crypto.randomBytes(32).toString("hex");

clients.set(CHATGPT_CLIENT_ID, {
  clientSecret: CHATGPT_CLIENT_SECRET,
  redirectUris: [
    "https://chat.openai.com/aip/oauth/callback",
    "http://localhost:3000/oauth/callback", // For testing
  ],
});

console.log("🔐 OAuth Client Credentials:");
console.log(`   Client ID: ${CHATGPT_CLIENT_ID}`);
console.log(`   Client Secret: ${CHATGPT_CLIENT_SECRET}`);

/**
 * OAuth Authorization Endpoint
 * GET /oauth/authorize?response_type=code&client_id=xxx&redirect_uri=xxx&state=xxx
 */
router.get("/authorize", (req, res) => {
  const { response_type, client_id, redirect_uri, state, scope } = req.query;

  // Validate client
  const client = clients.get(client_id);
  if (!client) {
    return res.status(400).json({ error: "invalid_client" });
  }

  // Validate redirect URI
  if (!client.redirectUris.includes(redirect_uri)) {
    return res.status(400).json({ error: "invalid_redirect_uri" });
  }

  // For simplicity, auto-approve (in production, show consent screen)
  const code = crypto.randomBytes(32).toString("hex");
  
  authCodes.set(code, {
    clientId: client_id,
    redirectUri: redirect_uri,
    scope: scope || "read write",
    expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes
  });

  // Redirect back to ChatGPT with authorization code
  const redirectUrl = new URL(redirect_uri);
  redirectUrl.searchParams.set("code", code);
  redirectUrl.searchParams.set("state", state);

  res.redirect(redirectUrl.toString());
});

/**
 * OAuth Token Endpoint
 * POST /oauth/token
 * Body: grant_type=authorization_code&code=xxx&redirect_uri=xxx&client_id=xxx&client_secret=xxx
 */
router.post("/token", express.urlencoded({ extended: true }), (req, res) => {
  const { grant_type, code, redirect_uri, client_id, client_secret } = req.body;

  // Validate grant type
  if (grant_type !== "authorization_code") {
    return res.status(400).json({ error: "unsupported_grant_type" });
  }

  // Validate client credentials
  const client = clients.get(client_id);
  if (!client || client.clientSecret !== client_secret) {
    return res.status(401).json({ error: "invalid_client" });
  }

  // Validate authorization code
  const authCode = authCodes.get(code);
  if (!authCode) {
    return res.status(400).json({ error: "invalid_grant" });
  }

  if (authCode.expiresAt < Date.now()) {
    authCodes.delete(code);
    return res.status(400).json({ error: "expired_token" });
  }

  if (authCode.redirectUri !== redirect_uri) {
    return res.status(400).json({ error: "invalid_grant" });
  }

  // Generate access token
  const accessToken = crypto.randomBytes(32).toString("hex");
  const refreshToken = crypto.randomBytes(32).toString("hex");

  accessTokens.set(accessToken, {
    clientId: client_id,
    scope: authCode.scope,
    expiresAt: Date.now() + 3600 * 1000, // 1 hour
  });

  // Clean up authorization code
  authCodes.delete(code);

  res.json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: 3600,
    refresh_token: refreshToken,
    scope: authCode.scope,
  });
});

/**
 * OIDC Discovery Endpoint (required by ChatGPT)
 * GET /.well-known/openid-configuration
 */
router.get("/.well-known/openid-configuration", (req, res) => {
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  
  res.json({
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/oauth/authorize`,
    token_endpoint: `${baseUrl}/oauth/token`,
    userinfo_endpoint: `${baseUrl}/oauth/userinfo`,
    jwks_uri: `${baseUrl}/oauth/jwks`,
    response_types_supported: ["code"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    scopes_supported: ["openid", "profile", "email"],
  });
});

/**
 * UserInfo Endpoint
 * GET /oauth/userinfo
 * Headers: Authorization: Bearer <access_token>
 */
router.get("/userinfo", (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "invalid_token" });
  }

  const token = authHeader.substring(7);
  const tokenData = accessTokens.get(token);

  if (!tokenData || tokenData.expiresAt < Date.now()) {
    return res.status(401).json({ error: "invalid_token" });
  }

  res.json({
    sub: "azure-devops-user",
    name: "Azure DevOps User",
    email: "user@azuredevops.com",
  });
});

/**
 * Middleware to verify access tokens
 */
export function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "missing_token" });
  }

  const token = authHeader.substring(7);
  const tokenData = accessTokens.get(token);

  if (!tokenData || tokenData.expiresAt < Date.now()) {
    return res.status(401).json({ error: "invalid_token" });
  }

  req.user = { clientId: tokenData.clientId, scope: tokenData.scope };
  next();
}

export default router;
