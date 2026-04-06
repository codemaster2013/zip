// ═══════════════════════════════════════════════════
//  ZIP GAME — Back4App Cloud Code (main.js)
//  Upload this file to Back4App → Cloud Code → main.js
// ═══════════════════════════════════════════════════

const crypto = require('crypto');

// ── Hash password (SHA-256 + salt) ──
function hashPassword(password, salt) {
  return crypto.createHmac('sha256', salt).update(password).digest('hex');
}

function generateSalt() {
  return crypto.randomBytes(16).toString('hex');
}

// ── Hash username for storage (one-way lookup via index) ──
function hashUsername(username) {
  return crypto.createHash('sha256').update(username.toLowerCase().trim()).digest('hex');
}

// ══════════════════════════════════════════════════════
//  REGISTER
// ══════════════════════════════════════════════════════
Parse.Cloud.define('registerUser', async (request) => {
  const { username, password } = request.params;

  if (!username || !password) throw new Error('Username and password required');
  if (username.length < 3) throw new Error('Username must be 3+ characters');
  if (password.length < 4) throw new Error('Password must be 4+ characters');
  if (!/^[a-zA-Z0-9_]+$/.test(username)) throw new Error('Username: letters, numbers, underscore only');

  const usernameHash = hashUsername(username);

  // Check if username taken
  const existing = new Parse.Query('ZipUser');
  existing.equalTo('usernameHash', usernameHash);
  const found = await existing.first({ useMasterKey: true });
  if (found) throw new Error('Username already taken');

  // Hash password
  const salt = generateSalt();
  const passwordHash = hashPassword(password, salt);

  // Save user
  const ZipUser = Parse.Object.extend('ZipUser');
  const user = new ZipUser();
  user.set('usernameHash', usernameHash);
  user.set('displayName', username); // store original casing for display
  user.set('passwordHash', passwordHash);
  user.set('salt', salt);
  user.set('credits', 2);
  user.set('score', 0);
  user.set('totalGames', 0);
  user.set('twoFaEnabled', false);
  user.set('twoFaCode', '');
  user.set('games', []);

  await user.save(null, { useMasterKey: true });

  // Update global stats
  await updateStats({ usersIncrement: 1 });

  return {
    userId: user.id,
    displayName: username,
    credits: 2,
    score: 0,
    totalGames: 0,
    twoFaEnabled: false,
    twoFaCode: '',
    games: []
  };
});

// ══════════════════════════════════════════════════════
//  LOGIN
// ══════════════════════════════════════════════════════
Parse.Cloud.define('loginUser', async (request) => {
  const { username, password, twoFaCode } = request.params;
  if (!username || !password) throw new Error('Username and password required');

  const usernameHash = hashUsername(username);
  const query = new Parse.Query('ZipUser');
  query.equalTo('usernameHash', usernameHash);
  const user = await query.first({ useMasterKey: true });

  if (!user) throw new Error('Wrong username or password');

  const salt = user.get('salt');
  const storedHash = user.get('passwordHash');
  const inputHash = hashPassword(password, salt);

  if (inputHash !== storedHash) throw new Error('Wrong username or password');

  // 2FA check
  if (user.get('twoFaEnabled') && user.get('twoFaCode')) {
    if (!twoFaCode) throw new Error('2FA_REQUIRED');
    if (twoFaCode.toUpperCase() !== user.get('twoFaCode')) throw new Error('Wrong 2FA code');
  }

  return {
    userId: user.id,
    displayName: user.get('displayName'),
    credits: user.get('credits') || 0,
    score: user.get('score') || 0,
    totalGames: user.get('totalGames') || 0,
    twoFaEnabled: user.get('twoFaEnabled') || false,
    twoFaCode: user.get('twoFaCode') || '',
    games: user.get('games') || []
  };
});

// ══════════════════════════════════════════════════════
//  GET USER (refresh)
// ══════════════════════════════════════════════════════
Parse.Cloud.define('getUser', async (request) => {
  const { userId } = request.params;
  const query = new Parse.Query('ZipUser');
  const user = await query.get(userId, { useMasterKey: true });

  return {
    userId: user.id,
    displayName: user.get('displayName'),
    credits: user.get('credits') || 0,
    score: user.get('score') || 0,
    totalGames: user.get('totalGames') || 0,
    twoFaEnabled: user.get('twoFaEnabled') || false,
    twoFaCode: user.get('twoFaCode') || '',
    games: user.get('games') || []
  };
});

// ══════════════════════════════════════════════════════
//  TOGGLE 2FA
// ══════════════════════════════════════════════════════
Parse.Cloud.define('toggle2FA', async (request) => {
  const { userId, enable } = request.params;

  const query = new Parse.Query('ZipUser');
  const user = await query.get(userId, { useMasterKey: true });

  let code = user.get('twoFaCode') || '';
  if (enable && !code) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    code = '';
    for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
  }

  user.set('twoFaEnabled', enable);
  if (enable) user.set('twoFaCode', code);
  await user.save(null, { useMasterKey: true });

  return { twoFaEnabled: enable, twoFaCode: code };
});

// ══════════════════════════════════════════════════════
//  SPEND CREDIT & SAVE GAME
// ══════════════════════════════════════════════════════
Parse.Cloud.define('spendCredit', async (request) => {
  const { userId } = request.params;

  const query = new Parse.Query('ZipUser');
  const user = await query.get(userId, { useMasterKey: true });

  const credits = user.get('credits') || 0;
  if (credits <= 0) throw new Error('Not enough credits');

  user.set('credits', credits - 1);
  await user.save(null, { useMasterKey: true });

  // Update global games count
  await updateStats({ gamesIncrement: 1 });

  return { credits: credits - 1 };
});

Parse.Cloud.define('saveGame', async (request) => {
  const { userId, diff, time, score } = request.params;

  const query = new Parse.Query('ZipUser');
  const user = await query.get(userId, { useMasterKey: true });

  const games = user.get('games') || [];
  games.unshift({ diff, time, score, at: Date.now() });
  if (games.length > 50) games.pop();

  user.set('games', games);
  user.set('score', (user.get('score') || 0) + score);
  user.set('totalGames', (user.get('totalGames') || 0) + 1);
  await user.save(null, { useMasterKey: true });

  return { ok: true };
});

// ══════════════════════════════════════════════════════
//  REDEEM CODE
// ══════════════════════════════════════════════════════
Parse.Cloud.define('redeemCode', async (request) => {
  const { userId, rawCode } = request.params;

  const clean = rawCode.replace(/[^A-Z0-9]/gi, '').toUpperCase();
  if (clean.length !== 8) throw new Error('Invalid code format');

  const codeQuery = new Parse.Query('ZipCode');
  codeQuery.equalTo('rawCode', clean);
  const codeObj = await codeQuery.first({ useMasterKey: true });

  if (!codeObj) throw new Error('Code not found');
  if (!codeObj.get('active')) throw new Error('Code has been deactivated');

  const maxUses = codeObj.get('maxUses') || 0;
  const uses = codeObj.get('uses') || 0;
  if (maxUses > 0 && uses >= maxUses) throw new Error('Code has been fully used');

  const usedBy = codeObj.get('usedBy') || [];
  if (usedBy.includes(userId)) throw new Error('You already used this code');

  // Apply credits to user
  const userQuery = new Parse.Query('ZipUser');
  const user = await userQuery.get(userId, { useMasterKey: true });
  const credits = codeObj.get('credits') || 0;
  user.set('credits', (user.get('credits') || 0) + credits);
  await user.save(null, { useMasterKey: true });

  // Update code
  usedBy.push(userId);
  codeObj.set('uses', uses + 1);
  codeObj.set('usedBy', usedBy);
  await codeObj.save(null, { useMasterKey: true });

  return { credits, newTotal: user.get('credits') };
});

// ══════════════════════════════════════════════════════
//  GENERATE CODE (admin)
// ══════════════════════════════════════════════════════
Parse.Cloud.define('generateCode', async (request) => {
  const { adminPass, credits, maxUses, note } = request.params;

  if (adminPass !== 'ZIP_ADMIN_2025') throw new Error('Unauthorized');

  const chars = 'BCDFGHJKLMNPQRSTVWXYZ2346789';
  let raw = '';
  for (let i = 0; i < 8; i++) raw += chars[Math.floor(Math.random() * chars.length)];

  const ZipCode = Parse.Object.extend('ZipCode');
  const code = new ZipCode();
  code.set('rawCode', raw);
  code.set('credits', credits || 10);
  code.set('maxUses', maxUses || 0);
  code.set('uses', 0);
  code.set('usedBy', []);
  code.set('active', true);
  code.set('note', note || '');
  await code.save(null, { useMasterKey: true });

  return { code: raw.slice(0, 4) + '-' + raw.slice(4), raw };
});

// ══════════════════════════════════════════════════════
//  TOGGLE CODE (admin)
// ══════════════════════════════════════════════════════
Parse.Cloud.define('toggleCode', async (request) => {
  const { adminPass, codeId, active } = request.params;
  if (adminPass !== 'ZIP_ADMIN_2025') throw new Error('Unauthorized');

  const query = new Parse.Query('ZipCode');
  const code = await query.get(codeId, { useMasterKey: true });
  code.set('active', active);
  await code.save(null, { useMasterKey: true });
  return { ok: true };
});

// ══════════════════════════════════════════════════════
//  GET ALL CODES (admin)
// ══════════════════════════════════════════════════════
Parse.Cloud.define('getCodes', async (request) => {
  const { adminPass } = request.params;
  if (adminPass !== 'ZIP_ADMIN_2025') throw new Error('Unauthorized');

  const query = new Parse.Query('ZipCode');
  query.descending('createdAt');
  query.limit(200);
  const results = await query.find({ useMasterKey: true });

  return results.map(c => ({
    id: c.id,
    rawCode: c.get('rawCode'),
    formatted: c.get('rawCode').slice(0, 4) + '-' + c.get('rawCode').slice(4),
    credits: c.get('credits'),
    maxUses: c.get('maxUses'),
    uses: c.get('uses'),
    usedBy: c.get('usedBy') || [],
    active: c.get('active'),
    note: c.get('note') || '',
    createdAt: c.get('createdAt')
  }));
});

// ══════════════════════════════════════════════════════
//  BULK GIVE CREDITS (admin) — server-side, hits all users
// ══════════════════════════════════════════════════════
Parse.Cloud.define('bulkGiveCredits', async (request) => {
  const { adminPass, amount } = request.params;
  if (adminPass !== 'ZIP_ADMIN_2025') throw new Error('Unauthorized');
  if (!amount || amount < 1) throw new Error('Invalid amount');

  const query = new Parse.Query('ZipUser');
  query.limit(10000);
  const users = await query.find({ useMasterKey: true });

  // Process in batches of 50
  const batchSize = 50;
  let processed = 0;
  for (let i = 0; i < users.length; i += batchSize) {
    const batch = users.slice(i, i + batchSize);
    batch.forEach(u => u.set('credits', (u.get('credits') || 0) + amount));
    await Parse.Object.saveAll(batch, { useMasterKey: true });
    processed += batch.length;
  }

  return { ok: true, processed };
});

// ══════════════════════════════════════════════════════
//  GET STATS (admin)
// ══════════════════════════════════════════════════════
Parse.Cloud.define('getStats', async (request) => {
  const { adminPass } = request.params;
  if (adminPass !== 'ZIP_ADMIN_2025') throw new Error('Unauthorized');

  const userCount = await new Parse.Query('ZipUser').count({ useMasterKey: true });
  const codeCount = await new Parse.Query('ZipCode').count({ useMasterKey: true });
  const activeCodes = await new Parse.Query('ZipCode')
    .equalTo('active', true)
    .count({ useMasterKey: true });

  const statsQuery = new Parse.Query('ZipMeta');
  statsQuery.equalTo('key', 'global');
  const meta = await statsQuery.first({ useMasterKey: true });
  const totalGames = meta ? meta.get('totalGames') || 0 : 0;

  return { userCount, codeCount, activeCodes, totalGames };
});

// ══════════════════════════════════════════════════════
//  LEADERBOARD
// ══════════════════════════════════════════════════════
Parse.Cloud.define('getLeaderboard', async (request) => {
  const query = new Parse.Query('ZipUser');
  query.descending('score');
  query.limit(50);
  query.select(['displayName', 'score', 'totalGames', 'games']);
  const results = await query.find({ useMasterKey: true });

  return results.map(u => ({
    id: u.id,
    displayName: u.get('displayName'),
    score: u.get('score') || 0,
    totalGames: u.get('totalGames') || 0,
    bestTime: getBestTime(u.get('games') || [])
  }));
});

// ══════════════════════════════════════════════════════
//  DAILY CREDIT JOB — runs via Back4App scheduled job
//  Schedule: every day at midnight (cron: 0 0 * * *)
// ══════════════════════════════════════════════════════
Parse.Cloud.job('dailyCredit', async (request) => {
  const { message } = request;
  message('Starting daily credit job...');

  const query = new Parse.Query('ZipUser');
  query.limit(10000);
  const users = await query.find({ useMasterKey: true });

  const batchSize = 50;
  let total = 0;
  for (let i = 0; i < users.length; i += batchSize) {
    const batch = users.slice(i, i + batchSize);
    batch.forEach(u => u.set('credits', (u.get('credits') || 0) + 1));
    await Parse.Object.saveAll(batch, { useMasterKey: true });
    total += batch.length;
  }

  message(`Done! Gave 1 credit to ${total} users.`);
  return `Gave 1 credit to ${total} users`;
});

// ══════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════
async function updateStats({ usersIncrement = 0, gamesIncrement = 0 }) {
  const query = new Parse.Query('ZipMeta');
  query.equalTo('key', 'global');
  let meta = await query.first({ useMasterKey: true });
  if (!meta) {
    const ZipMeta = Parse.Object.extend('ZipMeta');
    meta = new ZipMeta();
    meta.set('key', 'global');
    meta.set('totalUsers', 0);
    meta.set('totalGames', 0);
  }
  if (usersIncrement) meta.set('totalUsers', (meta.get('totalUsers') || 0) + usersIncrement);
  if (gamesIncrement) meta.set('totalGames', (meta.get('totalGames') || 0) + gamesIncrement);
  await meta.save(null, { useMasterKey: true });
}

function getBestTime(games) {
  if (!games || !games.length) return null;
  return Math.min(...games.map(g => g.time || 9999));
}
