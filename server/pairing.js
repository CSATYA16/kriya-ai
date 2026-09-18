'use strict';
/**
 * KRIYA Pairing Module
 * Handles cryptographically secure pairing token generation, TTL,
 * one-time-use enforcement, and session token management.
 */

const crypto = require('crypto');

const PAIRING_TOKEN_TTL_MS = 5 * 60 * 1000;  // 5 minutes
const SESSION_TOKEN_BYTES  = 32;              // 256-bit session tokens

// Map: pairingToken → { expires, shortCode, macConnId }
const pairingTokens = new Map();

// Map: sessionToken → { macConnId, phoneConnId, pairedAt, macName }
const sessions = new Map();

// ─── Pairing token management ─────────────────────────────────────────────────

/**
 * Generate a cryptographically secure pairing token (hex, 128-bit).
 * Stores TTL and optional macConnId in the registry.
 */
function generatePairingToken(macConnId, macName) {
  const token     = crypto.randomBytes(16).toString('hex');
  const shortCode = _generateShortCode();
  const expires   = Date.now() + PAIRING_TOKEN_TTL_MS;
  pairingTokens.set(token, { expires, shortCode, macConnId, macName });
  // Schedule automatic expiry
  setTimeout(() => pairingTokens.delete(token), PAIRING_TOKEN_TTL_MS + 1000);
  return { token, shortCode };
}

/**
 * Validate a pairing token. Returns the stored entry or null if invalid/expired.
 */
function validatePairingToken(token) {
  const entry = pairingTokens.get(token);
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    pairingTokens.delete(token);
    return null;
  }
  return entry;
}

/**
 * Consume a pairing token (one-time use) and return the entry.
 */
function consumePairingToken(token) {
  const entry = validatePairingToken(token);
  if (!entry) return null;
  pairingTokens.delete(token); // one-time use
  return entry;
}

/**
 * Generate a human-readable short code (e.g. "X7K9-42").
 */
function _generateShortCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  let code = '';
  const rand = crypto.randomBytes(4);
  for (let i = 0; i < 4; i++) code += chars[rand[i] % chars.length];
  const num = (rand[3] % 90) + 10; // 10-99
  return `${code}-${num}`;
}

// ─── Session token management ─────────────────────────────────────────────────

/**
 * Create a new session for a mac+phone pair.
 * Returns the session token.
 */
function createSession({ macConnId, phoneConnId, macName }) {
  const sessionToken = crypto.randomBytes(SESSION_TOKEN_BYTES).toString('hex');
  sessions.set(sessionToken, {
    macConnId,
    phoneConnId,
    macName: macName || 'My Mac',
    pairedAt: new Date().toISOString(),
  });
  return sessionToken;
}

/**
 * Validate a session token. Returns the session entry or null.
 */
function validateSession(sessionToken) {
  return sessions.get(sessionToken) || null;
}

/**
 * Remove a session (disconnect).
 */
function removeSession(sessionToken) {
  sessions.delete(sessionToken);
}

/**
 * Find session by connection ID (mac or phone).
 */
function findSessionByConnId(connId) {
  for (const [token, sess] of sessions) {
    if (sess.macConnId === connId || sess.phoneConnId === connId) {
      return { token, ...sess };
    }
  }
  return null;
}

/**
 * Update phone connId in an existing session.
 */
function updateSessionPhone(sessionToken, phoneConnId) {
  const sess = sessions.get(sessionToken);
  if (sess) sess.phoneConnId = phoneConnId;
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

/**
 * Remove all sessions associated with a connection ID (on disconnect).
 */
function cleanupConnection(connId) {
  for (const [token, sess] of sessions) {
    if (sess.macConnId === connId || sess.phoneConnId === connId) {
      sessions.delete(token);
    }
  }
  for (const [token, entry] of pairingTokens) {
    if (entry.macConnId === connId) {
      pairingTokens.delete(token);
    }
  }
}

module.exports = {
  generatePairingToken,
  validatePairingToken,
  consumePairingToken,
  createSession,
  validateSession,
  removeSession,
  findSessionByConnId,
  updateSessionPhone,
  cleanupConnection,
  PAIRING_TOKEN_TTL_MS,
  // For tests
  _pairingTokens: pairingTokens,
  _sessions: sessions,
};
