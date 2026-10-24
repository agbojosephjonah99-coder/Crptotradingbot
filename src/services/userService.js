/**
 * ─── User Service ─────────────────────────────────────────────────────────────
 * Manages approved, pending and blocked users.
 * Stored under cryptobot:users (unchanged key).
 *
 * USER STATES:
 *  pending  → requested access, awaiting admin approval
 *  approved → can use the bot fully
 *  blocked  → rejected or banned, cannot use bot
 */

const store = require('../lib/redis');

const USERS_KEY = 'cryptobot:users';

async function getAllUsers() {
  try { return (await store.getJSON(USERS_KEY, {})) || {}; }
  catch (err) { console.error('[UserService] read failed:', err.message); return {}; }
}

async function saveAllUsers(users) {
  await store.setJSON(USERS_KEY, users);
}

async function getUser(chatId) {
  const all = await getAllUsers();
  return all[chatId.toString()] || null;
}

function isAdminId(chatId) {
  const admin = process.env.TELEGRAM_CHAT_ID;
  return !!admin && chatId?.toString() === admin.toString();
}

async function isApproved(chatId) {
  if (isAdminId(chatId)) return true;
  const user = await getUser(chatId);
  return user?.status === 'approved';
}

async function isBlocked(chatId) {
  const user = await getUser(chatId);
  return user?.status === 'blocked';
}

// ─── Register a new user (pending approval) ───────────────────────────────────
async function registerUser({ chatId, firstName, lastName, username, param }) {
  const all = await getAllUsers();
  const id  = chatId.toString();

  // Don't overwrite existing approved/blocked users
  if (all[id]?.status === 'approved' || all[id]?.status === 'blocked') {
    return all[id];
  }

  all[id] = {
    chatId:      id,
    firstName:   firstName || '',
    lastName:    lastName  || '',
    username:    username  || '',
    source:      param     || '',   // which invite link they used
    status:      'pending',
    requestedAt: new Date().toISOString(),
    approvedAt:  null,
  };

  await saveAllUsers(all);
  return all[id];
}

async function setStatus(chatId, status, stampField) {
  const all = await getAllUsers();
  const id  = chatId.toString();
  if (!all[id]) return false;
  all[id].status = status;
  all[id][stampField] = new Date().toISOString();
  await saveAllUsers(all);
  return true;
}

async function approveUser(chatId) { return setStatus(chatId, 'approved', 'approvedAt'); }
async function blockUser(chatId)   { return setStatus(chatId, 'blocked',  'blockedAt'); }

async function removeUser(chatId) {
  const all = await getAllUsers();
  const id  = chatId.toString();
  if (!all[id]) return false;
  delete all[id];
  await saveAllUsers(all);
  return true;
}

async function getUsersByStatus(status) {
  const all = await getAllUsers();
  return Object.values(all).filter(u => u.status === status);
}

/** Admin + every approved user (deduplicated). */
async function getAllActiveChatIds() {
  const approved = await getUsersByStatus('approved');
  return [...new Set([process.env.TELEGRAM_CHAT_ID, ...approved.map(u => u.chatId)])].filter(Boolean).map(String);
}

function formatName(user) {
  if (!user) return 'Unknown user';
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || 'Unknown';
  const tag  = user.username ? `@${user.username}` : `ID: ${user.chatId}`;
  return `${name} (${tag})`;
}

module.exports = {
  getUser, getAllUsers, isApproved, isBlocked, isAdminId,
  registerUser, approveUser, blockUser, removeUser,
  getUsersByStatus, getAllActiveChatIds, formatName,
};
