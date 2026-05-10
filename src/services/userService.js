/**
 * ─── User Service ─────────────────────────────────────────────────────────────
 * Manages approved, pending and blocked users.
 * Stored in Upstash Redis (or in-memory fallback for testing).
 *
 * USER STATES:
 *  pending  → requested access, awaiting admin approval
 *  approved → can use the bot fully
 *  blocked  → rejected or banned, cannot use bot
 */

const axios = require('axios');

const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const USERS_KEY     = 'cryptobot:users';
const useUpstash    = !!(UPSTASH_URL && UPSTASH_TOKEN);

// In-memory fallback
const memoryStore = {};

async function upstashGet(key) {
  const r = await axios.get(`${UPSTASH_URL}/get/${key}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    timeout: 5000,
  });
  return r.data.result ? JSON.parse(r.data.result) : null;
}

async function upstashSet(key, value) {
  await axios.post(`${UPSTASH_URL}/set/${key}`, JSON.stringify(value), {
    headers: {
      Authorization:  `Bearer ${UPSTASH_TOKEN}`,
      'Content-Type': 'application/json',
    },
    timeout: 5000,
  });
}

// ─── Get all users ────────────────────────────────────────────────────────────
async function getAllUsers() {
  try {
    if (useUpstash) return (await upstashGet(USERS_KEY)) || {};
    return memoryStore;
  } catch { return {}; }
}

async function saveAllUsers(users) {
  if (useUpstash) await upstashSet(USERS_KEY, users);
  else Object.assign(memoryStore, users);
}

// ─── Get single user ──────────────────────────────────────────────────────────
async function getUser(chatId) {
  const all = await getAllUsers();
  return all[chatId.toString()] || null;
}

// ─── Check if user is approved ────────────────────────────────────────────────
async function isApproved(chatId) {
  const ADMIN_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
  // Admin is always approved
  if (chatId.toString() === ADMIN_CHAT_ID?.toString()) return true;
  const user = await getUser(chatId);
  return user?.status === 'approved';
}

// ─── Check if user is blocked ─────────────────────────────────────────────────
async function isBlocked(chatId) {
  const user = await getUser(chatId);
  return user?.status === 'blocked';
}

// ─── Register a new user (pending approval) ───────────────────────────────────
async function registerUser({ chatId, firstName, lastName, username }) {
  const all = await getAllUsers();
  const id  = chatId.toString();

  // Don't overwrite existing approved/blocked users
  if (all[id]?.status === 'approved' || all[id]?.status === 'blocked') {
    return all[id];
  }

  all[id] = {
    chatId:    id,
    firstName: firstName || '',
    lastName:  lastName  || '',
    username:  username  || '',
    status:    'pending',
    requestedAt: new Date().toISOString(),
    approvedAt:  null,
  };

  await saveAllUsers(all);
  return all[id];
}

// ─── Approve a user ───────────────────────────────────────────────────────────
async function approveUser(chatId) {
  const all = await getAllUsers();
  const id  = chatId.toString();
  if (!all[id]) return false;
  all[id].status     = 'approved';
  all[id].approvedAt = new Date().toISOString();
  await saveAllUsers(all);
  return true;
}

// ─── Block a user ─────────────────────────────────────────────────────────────
async function blockUser(chatId) {
  const all = await getAllUsers();
  const id  = chatId.toString();
  if (!all[id]) return false;
  all[id].status    = 'blocked';
  all[id].blockedAt = new Date().toISOString();
  await saveAllUsers(all);
  return true;
}

// ─── Remove a user ────────────────────────────────────────────────────────────
async function removeUser(chatId) {
  const all = await getAllUsers();
  const id  = chatId.toString();
  if (!all[id]) return false;
  delete all[id];
  await saveAllUsers(all);
  return true;
}

// ─── Get users by status ──────────────────────────────────────────────────────
async function getUsersByStatus(status) {
  const all = await getAllUsers();
  return Object.values(all).filter(u => u.status === status);
}

// ─── Format user display name ─────────────────────────────────────────────────
function formatName(user) {
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || 'Unknown';
  const tag  = user.username ? `@${user.username}` : `ID: ${user.chatId}`;
  return `${name} (${tag})`;
}

module.exports = {
  getUser, getAllUsers, isApproved, isBlocked,
  registerUser, approveUser, blockUser, removeUser,
  getUsersByStatus, formatName,
};