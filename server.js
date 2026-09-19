'use strict';

const http = require('http');
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const ROOT = __dirname;
const STATE_DIR = path.join(ROOT, 'state');
const LOG_DIR = path.join(ROOT, 'logs');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const PORT = 8094;
const HOST = '127.0.0.1';
const sessions = new Map();
const loginAttempts = new Map();
let cpuSnapshot = os.cpus();
let diskCache = { at: 0, data: [] };
const codexJobs = new Map();
const USER_CAPABILITIES = ['status', 'metrics', 'service', 'terminal', 'codex-project-write', 'codex-full-access', 'user-management'];
const projectActions = new Map();
const DEFAULT_STARTUP_TIMEOUT_MS = 45_000;
const STOP_TIMEOUT_MS = 15_000;
const LOG_RETENTION_MS = 24 * 60 * 60 * 1000;
const AUDIT_LOG_FILE = path.join(LOG_DIR, 'audit.log');
const CODEX_HISTORY_DIR = path.join(LOG_DIR, 'codex-history');

for (const dir of [STATE_DIR, LOG_DIR, CODEX_HISTORY_DIR]) fs.mkdirSync(dir, { recursive: true });
if (!fs.existsSync(CONFIG_FILE)) throw new Error('config.json belum tersedia. Jalankan scripts/setup.ps1.');
const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, ''));

function saveConfig() {
  const temp = `${CONFIG_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, CONFIG_FILE);
}

function encryptionKey() {
  if (!config.sessionSecret || String(config.sessionSecret).length < 32) throw new Error('sessionSecret tidak cukup kuat untuk mengenkripsi API key.');
  return crypto.createHash('sha256').update(String(config.sessionSecret)).digest();
}

function encryptSecret(value) {
  const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') };
}

function decryptSecret(value) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(value.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(value.data, 'base64')), decipher.final()]).toString('utf8');
}

function configuredOpenAIAccounts() { return Array.isArray(config.openaiAccounts) ? config.openaiAccounts : []; }
function publicOpenAIAccount(account) { return { id: account.id, name: account.name, keyHint: account.keyHint }; }

function resolveOpenAIAccount(id) {
  if (!id || id === 'server') return null;
  const account = configuredOpenAIAccounts().find(item => item.id === id);
  if (!account) throw new Error('Akun OpenAI tidak ditemukan.');
  return { ...account, apiKey: decryptSecret(account.apiKey) };
}

const projects = [
  {
    id: 'cloudtrade', name: 'CloudTrade', category: 'Trading', color: '#49d8a4',
    domains: ['tradecloud.asia'], folder: 'D:\\Project\\CloudTrade', host: '192.168.0.130', port: 8090,
    start: { type: 'node', args: ['src/server.js'], cwd: 'D:\\Project\\CloudTrade' }
  },
  {
    id: 'remote-codex', name: 'Remote Codex', category: 'Developer tools', color: '#7c9cff',
    domains: ['xcodex.ruangiman.my.id', 'sync.ruangiman.my.id'], folder: 'D:\\Project\\remote-codex-workspace-cli', port: 8091,
    start: { type: 'powershell', script: 'D:\\Project\\remote-codex-workspace-cli\\scripts\\start-remote-codex.ps1' }
  },
  {
    id: 'fmt', name: 'FMT Operations', category: 'Operations', color: '#ffb35a',
    domains: ['fmt.ruangiman.my.id'], folder: 'D:\\Downloads_Admin\\jira-codex-dashboard', host: '192.168.0.130', port: 4310, startupTimeoutMs: 45_000,
    start: { type: 'node', args: ['server.mjs'], cwd: 'D:\\Downloads_Admin\\jira-codex-dashboard' }
  },
  {
    id: 'ruangiman', name: 'RuangIman', category: 'Static site', color: '#c99aff',
    domains: ['ruangiman.my.id', 'www.ruangiman.my.id'], folder: 'D:\\Project\\RuangIman', staticPath: 'D:\\Project\\RuangIman\\public', static: true
  },
  {
    id: 'music', name: 'Ruang Music', category: 'Media', color: '#ff7b9c',
    domains: ['music.ruangiman.my.id'], folder: 'D:\\Project\\Music', port: 8095,
    start: { type: 'node', args: ['server.js'], cwd: 'D:\\Project\\Music' }
  },
  {
    id: 'ruangdrive', name: 'RuangDrive', category: 'Storage', color: '#60c8ff',
    domains: ['drive.ruangiman.my.id'], folder: 'D:\\Project\\RuangDrive', port: 8092,
    start: { type: 'pm2', name: 'ruangdrive' }
  },
  {
    id: 'server', name: 'Server Dashboard', category: 'Infrastructure', color: '#e6f06c',
    domains: ['server.ruangiman.my.id'], folder: 'D:\\server', port: 8094, readonly: true
  }
];

function json(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length, 'Cache-Control': 'no-store' });
  res.end(data);
}

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(v => v.trim().split('=').map(decodeURIComponent)).filter(v => v.length === 2));
}

function getSession(req) {
  const token = cookies(req).server_session;
  const session = token && sessions.get(token);
  if (!session || session.expires < Date.now()) { if (token) sessions.delete(token); return null; }
  session.expires = Date.now() + 8 * 60 * 60 * 1000;
  return session;
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function configuredUsers() {
  if (Array.isArray(config.users)) return config.users;
  return [{ username: config.username, passwordSalt: config.passwordSalt, passwordHash: config.passwordHash, projects: '*', capabilities: ['status', 'metrics', 'service', 'terminal', 'codex-full-access'] }];
}

function publicUser(user) {
  return { username: user.username, projects: user.projects === '*' ? '*' : [...(user.projects || [])], capabilities: [...(user.capabilities || [])] };
}

function validateUserInput(input, { partial = false } = {}) {
  if (!partial || input.username !== undefined) {
    if (!/^[a-zA-Z0-9._-]{2,40}$/.test(String(input.username || ''))) throw new Error('Username harus 2-40 karakter (huruf, angka, titik, garis bawah, atau minus).');
  }
  if (!partial || input.projects !== undefined) {
    if (input.projects !== '*' && (!Array.isArray(input.projects) || input.projects.some(id => !projects.some(p => p.id === id)))) throw new Error('Project permission tidak valid.');
  }
  if (!partial || input.capabilities !== undefined) {
    if (!Array.isArray(input.capabilities) || input.capabilities.some(item => !USER_CAPABILITIES.includes(item))) throw new Error('Capability tidak valid.');
  }
  if (input.password !== undefined && String(input.password).length < 8) throw new Error('Password minimal 8 karakter.');
}

function hashPassword(password) {
  const passwordSalt = crypto.randomBytes(16).toString('hex');
  return { passwordSalt, passwordHash: crypto.scryptSync(String(password), Buffer.from(passwordSalt, 'hex'), 64).toString('hex') };
}

function saveUsers(users) {
  config.users = users;
  saveConfig();
  for (const [token, session] of sessions) {
    const user = users.find(item => item.username === session.user);
    if (!user) sessions.delete(token);
    else { session.projects = user.projects; session.capabilities = user.capabilities || []; }
  }
}

function requireUserManagement(res, session) {
  if (!session || !hasCapability(session, 'user-management')) { json(res, 403, { error: 'Akses manajemen user tidak diizinkan.' }); return false; }
  return true;
}

function authenticate(username, password) {
  const user = configuredUsers().find(item => item.username === username);
  if (!user) return null;
  const candidate = crypto.scryptSync(password, Buffer.from(user.passwordSalt, 'hex'), 64).toString('hex');
  return safeEqual(candidate, user.passwordHash) ? user : null;
}

function hasCapability(session, capability) {
  return session.capabilities.includes(capability);
}

function canAccessProject(session, project) {
  return session.projects === '*' || session.projects.includes(project.id);
}

function requireProjectAccess(res, session, project, capability) {
  if (!project) { json(res, 404, { error: 'Proyek tidak ditemukan' }); return false; }
  if (!canAccessProject(session, project) || !hasCapability(session, capability)) {
    json(res, 403, { error: 'Akses ke proyek atau fitur ini tidak diizinkan.' }); return false;
  }
  return true;
}

async function readBody(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 32_768) throw new Error('Request terlalu besar'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function isDisabled(id) { return fs.existsSync(path.join(STATE_DIR, `${id}.disabled`)); }
function setDisabled(id, value) {
  const file = path.join(STATE_DIR, `${id}.disabled`);
  if (value) fs.writeFileSync(file, new Date().toISOString());
  else if (fs.existsSync(file)) fs.unlinkSync(file);
}

function portOpen(port, host = '127.0.0.1') {
  return new Promise(resolve => {
    const socket = net.createConnection({ host, port });
    const done = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(800); socket.once('connect', () => done(true)); socket.once('timeout', () => done(false)); socket.once('error', () => done(false));
  });
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForPort(port, host, shouldBeOpen, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    if ((await portOpen(port, host)) === shouldBeOpen) return true;
    await delay(500);
  } while (Date.now() < deadline);
  return (await portOpen(port, host)) === shouldBeOpen;
}

async function statusFor(p) {
  const disabled = isDisabled(p.id);
  const processOnline = p.static ? fs.existsSync(p.staticPath || p.folder) : await portOpen(p.port, p.host);
  return { ...p, start: undefined, disabled, processOnline, online: !disabled && processOnline };
}

function audit(user, action, project, outcome) {
  cleanupAuditLog();
  const entry = JSON.stringify({ time: new Date().toISOString(), user, action, project, outcome });
  fs.appendFileSync(AUDIT_LOG_FILE, `${entry}\n`);
}

function cleanupAuditLog() {
  if (!fs.existsSync(AUDIT_LOG_FILE)) return;
  const cutoff = Date.now() - LOG_RETENTION_MS;
  const lines = fs.readFileSync(AUDIT_LOG_FILE, 'utf8').split(/\r?\n/).filter(Boolean);
  const retained = lines.filter(line => {
    try {
      const timestamp = Date.parse(JSON.parse(line).time);
      return Number.isFinite(timestamp) && timestamp >= cutoff;
    } catch {
      return false;
    }
  });
  if (retained.length === lines.length) return;
  const temp = `${AUDIT_LOG_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(temp, retained.length ? `${retained.join('\n')}\n` : '', 'utf8');
  fs.renameSync(temp, AUDIT_LOG_FILE);
}

function codexHistoryPaths(id) {
  if (!/^[a-f0-9]{36}$/.test(String(id))) throw new Error('ID history tidak valid.');
  return { meta: path.join(CODEX_HISTORY_DIR, `${id}.json`), output: path.join(CODEX_HISTORY_DIR, `${id}.log`) };
}

function persistCodexHistory(job) {
  const files = codexHistoryPaths(job.id);
  const meta = {
    id: job.id, project: job.project, user: job.user, status: job.status, code: job.code,
    prompt: job.prompt || '', startedAt: job.startedAt, finishedAt: job.finishedAt,
    fullAccess: !job.projectScoped, projectScoped: job.projectScoped
  };
  const temp = `${files.meta}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, files.meta);
  if (!fs.existsSync(files.output)) fs.writeFileSync(files.output, '', 'utf8');
}

function appendCodexHistory(id, text) {
  fs.appendFileSync(codexHistoryPaths(id).output, text, 'utf8');
}

function readCodexHistoryMeta(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function canReadCodexHistory(session, item) {
  if (item.user !== session.user && !hasCapability(session, 'user-management')) return false;
  const project = projects.find(entry => entry.id === item.project);
  return Boolean(project && canAccessProject(session, project));
}

function listCodexHistory(session) {
  cleanupCodexHistory();
  return fs.readdirSync(CODEX_HISTORY_DIR, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .map(entry => readCodexHistoryMeta(path.join(CODEX_HISTORY_DIR, entry.name)))
    .filter(item => item && canReadCodexHistory(session, item))
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
}

function cleanupCodexHistory() {
  const cutoff = Date.now() - LOG_RETENTION_MS;
  for (const entry of fs.readdirSync(CODEX_HISTORY_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !/^[a-f0-9]{36}\.(json|log)$/.test(entry.name)) continue;
    const file = path.join(CODEX_HISTORY_DIR, entry.name);
    const id = entry.name.slice(0, 36);
    const active = codexJobs.get(id);
    if (active?.status === 'running') continue;
    let timestamp = fs.statSync(file).mtimeMs;
    if (entry.name.endsWith('.json')) {
      const item = readCodexHistoryMeta(file);
      const parsed = Date.parse(item?.finishedAt || item?.startedAt || '');
      if (Number.isFinite(parsed)) timestamp = parsed;
    }
    if (timestamp < cutoff) fs.unlinkSync(file);
  }
}

function markInterruptedCodexHistory() {
  for (const entry of fs.readdirSync(CODEX_HISTORY_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const file = path.join(CODEX_HISTORY_DIR, entry.name); const item = readCodexHistoryMeta(file);
    if (!item || item.status !== 'running') continue;
    item.status = 'interrupted'; item.finishedAt = new Date().toISOString();
    fs.writeFileSync(file, `${JSON.stringify(item, null, 2)}\n`, 'utf8');
    appendCodexHistory(item.id, '\n[Dashboard server restarted; job status marked interrupted.]\n');
  }
}

function spawnDetached(command, args, cwd, logName) {
  const out = fs.openSync(path.join(LOG_DIR, `${logName}.log`), 'a');
  let child;
  try {
    child = spawn(command, args, { cwd, detached: true, windowsHide: true, stdio: ['ignore', out, out] });
  } finally {
    fs.closeSync(out);
  }
  child.unref();
  return child;
}

function logTail(projectId, startAt = 0, maxLength = 1200) {
  const file = path.join(LOG_DIR, `${projectId}.log`);
  if (!fs.existsSync(file)) return '';
  const content = fs.readFileSync(file).subarray(startAt).toString('utf8').trim();
  return content.slice(-maxLength);
}

async function stopPort(port) {
  // Use taskkill /T so child processes cannot keep or reopen the listener.
  // $processId is deliberately not named $id: PowerShell treats $id as the
  // built-in, read-only $PID variable because variable names are case-insensitive.
  const script = [
    `$listeners = Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue`,
    '$processIds = $listeners | Select-Object -ExpandProperty OwningProcess -Unique',
    'foreach ($processId in $processIds) {',
    '  & taskkill.exe /PID $processId /T /F 2>$null | Out-Null',
    '  if ($LASTEXITCODE -notin @(0, 128)) { throw "Gagal menghentikan process tree PID $processId (exit $LASTEXITCODE)." }',
    '}'
  ].join('; ');
  await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: STOP_TIMEOUT_MS });
}

async function startProject(p) {
  if (p.static) { setDisabled(p.id, false); return; }
  if (await portOpen(p.port, p.host)) { setDisabled(p.id, false); return; }
  if (!p.start) throw new Error(`Konfigurasi startup ${p.name} tidak tersedia.`);
  const cwd = p.start.cwd || p.folder;
  if (!fs.existsSync(cwd)) throw new Error(`Folder proyek tidak ditemukan: ${cwd}`);
  const logFile = path.join(LOG_DIR, `${p.id}.log`);
  const logStart = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;
  let child;
  let earlyExit = null;
  let launchError = null;
  if (p.start.type === 'node') {
    child = spawnDetached('C:\\Program Files\\nodejs\\node.exe', p.start.args, cwd, p.id);
    child.once('exit', (code, signal) => { earlyExit = { code, signal }; });
  }
  if (p.start.type === 'powershell') child = spawnDetached('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', p.start.script], path.dirname(p.start.script), p.id);
  if (child) child.once('error', error => { launchError = error; });
  if (p.start.type === 'pm2') {
    const cli = 'D:\\Project\\RuangDrive\\node_modules\\pm2\\bin\\pm2';
    await execFileAsync('C:\\Program Files\\nodejs\\node.exe', [cli, 'start', p.start.name, '--update-env'], { windowsHide: true, timeout: 30_000 });
  }
  if (!['node', 'powershell', 'pm2'].includes(p.start.type)) throw new Error(`Tipe startup ${p.start.type} tidak didukung.`);
  const deadline = Date.now() + (p.startupTimeoutMs || DEFAULT_STARTUP_TIMEOUT_MS);
  while (Date.now() < deadline) {
    await delay(500);
    if (await portOpen(p.port, p.host)) { setDisabled(p.id, false); return; }
    if (earlyExit || launchError) break;
  }
  const tail = logTail(p.id, logStart);
  if (launchError) throw new Error(`Gagal menjalankan ${p.name}: ${launchError.message}`);
  const exitDetail = earlyExit ? ` Proses berhenti (exit ${earlyExit.code ?? earlyExit.signal}).` : '';
  throw new Error(`Servis ${p.name} belum membuka ${p.host || '127.0.0.1'}:${p.port}.${exitDetail}${tail ? ` Log terakhir: ${tail}` : ''}`);
}

async function stopProject(p) {
  setDisabled(p.id, true);
  if (p.static) return;
  if (p.start.type === 'pm2') {
    const cli = 'D:\\Project\\RuangDrive\\node_modules\\pm2\\bin\\pm2';
    await execFileAsync('C:\\Program Files\\nodejs\\node.exe', [cli, 'stop', p.start.name], { windowsHide: true, timeout: 30_000 });
  } else {
    await stopPort(p.port);
  }
  if (!await waitForPort(p.port, p.host, false, STOP_TIMEOUT_MS)) throw new Error(`Port ${p.port} masih terbuka setelah proses dihentikan.`);
}

async function actionProject(p, action) {
  if (p.readonly) throw new Error('Dashboard tidak dapat mematikan dirinya sendiri.');
  if (projectActions.has(p.id)) throw new Error(`Aksi ${projectActions.get(p.id)} untuk ${p.name} masih berlangsung.`);
  projectActions.set(p.id, action);
  try {
    if (action === 'start') return await startProject(p);
    if (action === 'stop') return await stopProject(p);
    if (action === 'restart') { await stopProject(p); await delay(500); return await startProject(p); }
    throw new Error('Aksi tidak dikenal');
  } finally {
    projectActions.delete(p.id);
  }
}

async function executeCommand(project, command) {
  if (typeof command !== 'string' || !command.trim()) throw new Error('Perintah tidak boleh kosong.');
  if (command.length > 4000) throw new Error('Perintah maksimal 4.000 karakter.');
  if (!fs.existsSync(project.folder)) throw new Error('Folder proyek tidak ditemukan.');
  try {
    const result = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
      cwd: project.folder, windowsHide: true, timeout: 60_000, maxBuffer: 1024 * 1024, encoding: 'utf8'
    });
    return { code: 0, stdout: result.stdout || '', stderr: result.stderr || '', cwd: project.folder };
  } catch (error) {
    if (error.killed || error.signal) throw new Error('Perintah dihentikan setelah melewati batas 60 detik.');
    if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new Error('Output melebihi batas 1 MB.');
    return { code: Number.isInteger(error.code) ? error.code : 1, stdout: error.stdout || '', stderr: error.stderr || error.message, cwd: project.folder };
  }
}

async function executeCodex(project, prompt) {
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('Instruksi Codex tidak boleh kosong.');
  const entry = 'C:\\Users\\admin\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js';
  if (!fs.existsSync(entry)) throw new Error('Codex CLI tidak ditemukan pada server.');
  try {
    const result = await execFileAsync('C:\\Program Files\\nodejs\\node.exe', [entry, 'exec', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '--color', 'never', '-C', project.folder, prompt], {
      cwd: project.folder, windowsHide: true, timeout: 0, maxBuffer: Infinity, encoding: 'utf8', env: { ...process.env, CODEX_HOME: 'D:\\CodexData' }
    });
    return { code: 0, stdout: result.stdout || '', stderr: result.stderr || '', cwd: project.folder, fullAccess: true };
  } catch (error) {
    if (error.killed || error.signal) throw new Error('Proses Codex dihentikan.');
    if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new Error('Output Codex melebihi batas 4 MB.');
    return { code: Number.isInteger(error.code) ? error.code : 1, stdout: error.stdout || '', stderr: error.stderr || error.message, cwd: project.folder, fullAccess: true };
  }
}

function startCodexJob(project, prompt, session, promptId, accountId) {
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('Instruksi Codex tidak boleh kosong.');
  const entry = 'C:\\Users\\admin\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js';
  if (!fs.existsSync(entry)) throw new Error('Codex CLI tidak ditemukan pada server.');
  const account = resolveOpenAIAccount(accountId);
  const id = crypto.randomBytes(18).toString('hex');
  const projectScoped = !hasCapability(session, 'codex-full-access');
  const job = { id, project: project.id, user: session.user, status: 'running', output: '', code: null, prompt: prompt.trim(), startedAt: new Date().toISOString(), finishedAt: null, child: null, projectScoped };
  const accessArgs = projectScoped ? ['--sandbox', 'workspace-write'] : ['--dangerously-bypass-approvals-and-sandbox'];
  const args = [entry, 'exec', ...accessArgs, '--skip-git-repo-check', '--color', 'never', '-C', project.folder, prompt];
  const childEnv = { ...process.env, CODEX_HOME: 'D:\\CodexData' };
  if (account) childEnv.OPENAI_API_KEY = account.apiKey;
  const child = spawn('C:\\Program Files\\nodejs\\node.exe', args, { cwd: project.folder, windowsHide: true, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  job.child = child; codexJobs.set(id, job); persistCodexHistory(job);
  const append = chunk => { const text = chunk.toString('utf8'); job.output += text; appendCodexHistory(job.id, text); };
  child.stdout.on('data', append); child.stderr.on('data', append);
  child.on('error', error => { job.output += error.message; appendCodexHistory(job.id, error.message); job.status = 'failed'; job.finishedAt = new Date().toISOString(); persistCodexHistory(job); });
  child.on('close', code => { if (job.status === 'running') job.status = code === 0 ? 'completed' : 'failed'; job.code = code ?? 1; job.finishedAt = new Date().toISOString(); job.child = null; persistCodexHistory(job); audit(session.user, projectScoped ? 'codex-project-write' : 'codex-full-access', project.id, `exit=${job.code}; prompt=${promptId}`); setTimeout(() => codexJobs.delete(id), 60 * 60_000).unref(); });
  return job;
}

function stopCodexJob(job, reason = 'Dibatalkan oleh pengguna.') {
  if (!job || job.status !== 'running') return;
  const message = `\n${reason}\n`;
  job.status = 'cancelled'; job.output += message; appendCodexHistory(job.id, message); job.finishedAt = new Date().toISOString(); persistCodexHistory(job); clearTimeout(job.timer);
  if (job.child?.pid) execFile('taskkill.exe', ['/PID', String(job.child.pid), '/T', '/F'], { windowsHide: true }, () => {});
}

function publicJob(job, offset = 0) {
  return { id: job.id, project: job.project, status: job.status, code: job.code, output: job.output.slice(offset), nextOffset: job.output.length, startedAt: job.startedAt, finishedAt: job.finishedAt, fullAccess: !job.projectScoped, projectScoped: job.projectScoped };
}

function cpuUsage() {
  const current = os.cpus(); let idle = 0; let total = 0; let oldIdle = 0; let oldTotal = 0;
  for (let i = 0; i < current.length; i++) {
    idle += current[i].times.idle; total += Object.values(current[i].times).reduce((a, b) => a + b, 0);
    oldIdle += cpuSnapshot[i].times.idle; oldTotal += Object.values(cpuSnapshot[i].times).reduce((a, b) => a + b, 0);
  }
  cpuSnapshot = current;
  const delta = total - oldTotal; return delta > 0 ? Math.max(0, Math.min(100, 100 * (1 - (idle - oldIdle) / delta))) : 0;
}

async function diskUsage() {
  if (Date.now() - diskCache.at < 10_000) return diskCache.data;
  const script = "Get-CimInstance Win32_LogicalDisk -Filter \"DriveType=3\" | Select-Object DeviceID,VolumeName,Size,FreeSpace | ConvertTo-Json -Compress";
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 5000 });
  let rows = JSON.parse(stdout || '[]'); if (!Array.isArray(rows)) rows = [rows];
  diskCache = { at: Date.now(), data: rows.map(d => ({ drive: d.DeviceID, label: d.VolumeName || '', total: Number(d.Size), free: Number(d.FreeSpace), used: Number(d.Size) - Number(d.FreeSpace), percent: d.Size ? 100 * (d.Size - d.FreeSpace) / d.Size : 0 })) };
  return diskCache.data;
}

async function systemMetrics() {
  const totalMemory = os.totalmem(); const freeMemory = os.freemem();
  const onlineProjects = (await Promise.all(projects.map(statusFor))).filter(p => p.online).length;
  return { cpu: cpuUsage(), cpuCores: os.cpus().length, memory: { total: totalMemory, free: freeMemory, used: totalMemory - freeMemory, percent: 100 * (totalMemory - freeMemory) / totalMemory }, disks: await diskUsage(), uptime: os.uptime(), onlineProjects, totalProjects: projects.length, timestamp: new Date().toISOString() };
}

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'");
}

const server = http.createServer(async (req, res) => {
  securityHeaders(res);
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, service: 'server-dashboard' });
    if (req.method === 'POST' && url.pathname === '/api/login') {
      const ip = req.socket.remoteAddress || 'unknown'; const attempt = loginAttempts.get(ip) || { count: 0, until: 0 };
      if (attempt.until > Date.now()) return json(res, 429, { error: 'Terlalu banyak percobaan. Tunggu beberapa menit.' });
      const body = await readBody(req);
      const user = authenticate(body.username, body.password || '');
      if (!user) {
        attempt.count++; if (attempt.count >= 5) { attempt.until = Date.now() + 5 * 60 * 1000; attempt.count = 0; } loginAttempts.set(ip, attempt);
        return json(res, 401, { error: 'Username atau password salah.' });
      }
      loginAttempts.delete(ip);
      const token = crypto.randomBytes(32).toString('hex'); const csrf = crypto.randomBytes(20).toString('hex');
      sessions.set(token, { user: user.username, projects: user.projects, capabilities: user.capabilities || [], csrf, expires: Date.now() + 8 * 60 * 60 * 1000 });
      res.setHeader('Set-Cookie', `server_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800`);
      return json(res, 200, { ok: true, csrf, user: user.username, capabilities: user.capabilities || [] });
    }
    if (req.method === 'POST' && url.pathname === '/api/logout') {
      const token = cookies(req).server_session; if (token) sessions.delete(token);
      res.setHeader('Set-Cookie', 'server_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0'); return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/session') {
      const session = getSession(req); return session ? json(res, 200, { authenticated: true, user: session.user, csrf: session.csrf, capabilities: session.capabilities }) : json(res, 401, { authenticated: false });
    }
    if (url.pathname === '/api/users' && req.method === 'GET') {
      const session = getSession(req); if (!session) return json(res, 401, { error: 'Unauthorized' });
      if (!requireUserManagement(res, session)) return;
      return json(res, 200, { users: configuredUsers().map(publicUser), projects: projects.map(({ id, name }) => ({ id, name })), capabilities: USER_CAPABILITIES });
    }
    if (url.pathname === '/api/users' && req.method === 'POST') {
      const session = getSession(req); if (!session) return json(res, 401, { error: 'Unauthorized' });
      if (!safeEqual(req.headers['x-csrf-token'] || '', session.csrf)) return json(res, 403, { error: 'CSRF tidak valid' });
      if (!requireUserManagement(res, session)) return;
      try {
        const body = await readBody(req); validateUserInput(body);
        const users = configuredUsers();
        if (users.some(user => user.username === body.username)) throw new Error('Username sudah digunakan.');
        if (!body.password) throw new Error('Password wajib diisi.');
        const user = { username: body.username, projects: body.projects, capabilities: body.capabilities, ...hashPassword(body.password) };
        saveUsers([...users, user]); audit(session.user, 'user-create', user.username, 'success');
        return json(res, 201, { ok: true, user: publicUser(user) });
      } catch (error) { audit(session.user, 'user-create', '', `failed: ${error.message}`); return json(res, 400, { error: error.message }); }
    }
    if (url.pathname === '/api/openai-accounts' && req.method === 'GET') {
      const session = getSession(req); if (!session) return json(res, 401, { error: 'Unauthorized' });
      if (!(hasCapability(session, 'codex-full-access') || hasCapability(session, 'codex-project-write'))) return json(res, 403, { error: 'Akses Codex tidak diizinkan.' });
      return json(res, 200, { accounts: configuredOpenAIAccounts().map(publicOpenAIAccount), canManage: hasCapability(session, 'user-management') });
    }
    if (url.pathname === '/api/openai-accounts' && req.method === 'POST') {
      const session = getSession(req); if (!session) return json(res, 401, { error: 'Unauthorized' });
      if (!safeEqual(req.headers['x-csrf-token'] || '', session.csrf)) return json(res, 403, { error: 'CSRF tidak valid' });
      if (!requireUserManagement(res, session)) return;
      try {
        const body = await readBody(req); const name = String(body.name || '').trim(); const apiKey = String(body.apiKey || '').trim();
        if (name.length < 2 || name.length > 60) throw new Error('Nama akun harus 2-60 karakter.');
        if (!/^sk-[A-Za-z0-9_\-]{20,}$/.test(apiKey)) throw new Error('Format API key OpenAI tidak valid.');
        const account = { id: crypto.randomBytes(12).toString('hex'), name, keyHint: `...${apiKey.slice(-4)}`, apiKey: encryptSecret(apiKey) };
        config.openaiAccounts = [...configuredOpenAIAccounts(), account]; saveConfig(); audit(session.user, 'openai-account-create', account.id, 'success');
        return json(res, 201, { ok: true, account: publicOpenAIAccount(account) });
      } catch (error) { return json(res, 400, { error: error.message }); }
    }
    const openAIAccountMatch = url.pathname.match(/^\/api\/openai-accounts\/([a-f0-9]{24})$/);
    if (openAIAccountMatch && req.method === 'DELETE') {
      const session = getSession(req); if (!session) return json(res, 401, { error: 'Unauthorized' });
      if (!safeEqual(req.headers['x-csrf-token'] || '', session.csrf)) return json(res, 403, { error: 'CSRF tidak valid' });
      if (!requireUserManagement(res, session)) return;
      const accounts = configuredOpenAIAccounts(); const index = accounts.findIndex(item => item.id === openAIAccountMatch[1]);
      if (index < 0) return json(res, 404, { error: 'Akun OpenAI tidak ditemukan.' });
      const [removed] = accounts.splice(index, 1); config.openaiAccounts = accounts; saveConfig(); audit(session.user, 'openai-account-delete', removed.id, 'success');
      return json(res, 200, { ok: true });
    }
    const userMatch = url.pathname.match(/^\/api\/users\/([^/]+)$/);
    if (userMatch && (req.method === 'PATCH' || req.method === 'DELETE')) {
      const session = getSession(req); if (!session) return json(res, 401, { error: 'Unauthorized' });
      if (!safeEqual(req.headers['x-csrf-token'] || '', session.csrf)) return json(res, 403, { error: 'CSRF tidak valid' });
      if (!requireUserManagement(res, session)) return;
      const username = decodeURIComponent(userMatch[1]); const users = configuredUsers(); const index = users.findIndex(user => user.username === username);
      if (index < 0) return json(res, 404, { error: 'User tidak ditemukan.' });
      if (req.method === 'DELETE') {
        if (username === session.user) return json(res, 400, { error: 'User yang sedang login tidak dapat dihapus.' });
        if (users[index].capabilities?.includes('user-management') && users.filter(user => user.capabilities?.includes('user-management')).length <= 1) return json(res, 400, { error: 'Minimal satu user management harus dipertahankan.' });
        users.splice(index, 1); saveUsers(users); audit(session.user, 'user-delete', username, 'success'); return json(res, 200, { ok: true });
      }
      try {
        const body = await readBody(req); validateUserInput(body, { partial: true });
        const updated = { ...users[index] };
        for (const key of ['projects', 'capabilities']) if (body[key] !== undefined) updated[key] = body[key];
        if (body.username !== undefined && body.username !== username) { if (users.some(user => user.username === body.username)) throw new Error('Username sudah digunakan.'); updated.username = body.username; }
        if (body.password !== undefined && body.password !== '') Object.assign(updated, hashPassword(body.password));
        users[index] = updated; saveUsers(users); audit(session.user, 'user-update', username, 'success'); return json(res, 200, { ok: true, user: publicUser(updated) });
      } catch (error) { audit(session.user, 'user-update', username, `failed: ${error.message}`); return json(res, 400, { error: error.message }); }
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      const session = getSession(req); if (!session) return json(res, 401, { error: 'Unauthorized' });
      if (!hasCapability(session, 'status')) return json(res, 403, { error: 'Akses status tidak diizinkan.' });
      const data = await Promise.all(projects.filter(p => canAccessProject(session, p)).map(statusFor));
      return json(res, 200, { projects: data, updatedAt: new Date().toISOString(), host: process.env.COMPUTERNAME || 'server' });
    }
    if (req.method === 'GET' && url.pathname === '/api/metrics') {
      const session = getSession(req); if (!session) return json(res, 401, { error: 'Unauthorized' });
      if (!hasCapability(session, 'metrics')) return json(res, 403, { error: 'Akses metrik tidak diizinkan.' });
      return json(res, 200, await systemMetrics());
    }
    const terminalMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/terminal$/);
    if (req.method === 'POST' && terminalMatch) {
      const session = getSession(req); if (!session) return json(res, 401, { error: 'Unauthorized' });
      if (!safeEqual(req.headers['x-csrf-token'] || '', session.csrf)) return json(res, 403, { error: 'CSRF tidak valid' });
      const project = projects.find(p => p.id === terminalMatch[1]); if (!requireProjectAccess(res, session, project, 'terminal')) return;
      const body = await readBody(req);
      const commandId = crypto.createHash('sha256').update(String(body.command || '')).digest('hex').slice(0, 12);
      try {
        const result = await executeCommand(project, body.command);
        audit(session.user, 'terminal', project.id, `exit=${result.code}; command=${commandId}`);
        return json(res, 200, result);
      } catch (error) {
        audit(session.user, 'terminal', project.id, `failed; command=${commandId}`);
        return json(res, 400, { error: error.message });
      }
    }
    const codexMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/codex$/);
    if (req.method === 'POST' && codexMatch) {
      const session = getSession(req); if (!session) return json(res, 401, { error: 'Unauthorized' });
      if (!safeEqual(req.headers['x-csrf-token'] || '', session.csrf)) return json(res, 403, { error: 'CSRF tidak valid' });
      const project = projects.find(p => p.id === codexMatch[1]);
      if (!project || !canAccessProject(session, project) || !(hasCapability(session, 'codex-full-access') || hasCapability(session, 'codex-project-write'))) return json(res, 403, { error: 'Akses Codex untuk proyek ini tidak diizinkan.' });
      const body = await readBody(req);
      if (body.fullAccess !== true) return json(res, 400, { error: 'Konfirmasi Full Access diperlukan.' });
      const promptId = crypto.createHash('sha256').update(String(body.prompt || '')).digest('hex').slice(0, 12);
      try { const job = startCodexJob(project, body.prompt, session, promptId, body.accountId); return json(res, 202, publicJob(job)); }
      catch (error) { audit(session.user, 'codex-full-access', project.id, `failed; prompt=${promptId}`); return json(res, 400, { error: error.message }); }
    }
    if (req.method === 'GET' && url.pathname === '/api/codex-history') {
      const session = getSession(req); if (!session) return json(res, 401, { error: 'Unauthorized' });
      if (!(hasCapability(session, 'codex-full-access') || hasCapability(session, 'codex-project-write') || hasCapability(session, 'user-management'))) return json(res, 403, { error: 'Akses history Codex tidak diizinkan.' });
      const history = listCodexHistory(session).map(item => ({ ...item, prompt: undefined, promptPreview: String(item.prompt || '').slice(0, 180) }));
      return json(res, 200, { history, retentionHours: LOG_RETENTION_MS / 3_600_000 });
    }
    const historyMatch = url.pathname.match(/^\/api\/codex-history\/([a-f0-9]{36})$/);
    if (req.method === 'GET' && historyMatch) {
      const session = getSession(req); if (!session) return json(res, 401, { error: 'Unauthorized' });
      const files = codexHistoryPaths(historyMatch[1]); const item = fs.existsSync(files.meta) ? readCodexHistoryMeta(files.meta) : null;
      if (!item || !canReadCodexHistory(session, item)) return json(res, 404, { error: 'History tidak ditemukan.' });
      return json(res, 200, { ...item, output: fs.existsSync(files.output) ? fs.readFileSync(files.output, 'utf8') : '' });
    }
    const jobMatch = url.pathname.match(/^\/api\/codex-jobs\/([a-f0-9]{36})$/);
    if (jobMatch && req.method === 'GET') {
      const session = getSession(req); if (!session) return json(res, 401, { error: 'Unauthorized' });
      const job = codexJobs.get(jobMatch[1]); if (!job || job.user !== session.user) return json(res, 404, { error: 'Job tidak ditemukan' });
      const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0); return json(res, 200, publicJob(job, offset));
    }
    if (jobMatch && req.method === 'POST') {
      const session = getSession(req); if (!session) return json(res, 401, { error: 'Unauthorized' });
      if (!safeEqual(req.headers['x-csrf-token'] || '', session.csrf)) return json(res, 403, { error: 'CSRF tidak valid' });
      const job = codexJobs.get(jobMatch[1]); if (!job || job.user !== session.user) return json(res, 404, { error: 'Job tidak ditemukan' });
      stopCodexJob(job); return json(res, 200, publicJob(job));
    }
    const match = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/(start|stop|restart)$/);
    if (req.method === 'POST' && match) {
      const session = getSession(req); if (!session) return json(res, 401, { error: 'Unauthorized' });
      if (!safeEqual(req.headers['x-csrf-token'] || '', session.csrf)) return json(res, 403, { error: 'CSRF tidak valid' });
      const project = projects.find(p => p.id === match[1]); if (!requireProjectAccess(res, session, project, 'service')) return;
      try { await actionProject(project, match[2]); audit(session.user, match[2], project.id, 'success'); return json(res, 200, { ok: true, project: await statusFor(project) }); }
      catch (error) { audit(session.user, match[2], project.id, `failed: ${error.message}`); return json(res, 500, { error: error.message }); }
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const file = path.join(ROOT, 'public', 'index.html'); res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return fs.createReadStream(file).pipe(res);
    }
    if (req.method === 'GET' && ['/app.css', '/terminal.css', '/metrics.css', '/users.css', '/history.css', '/app.js', '/metrics.js'].includes(url.pathname)) {
      const file = path.join(ROOT, 'public', url.pathname); const type = url.pathname.endsWith('.css') ? 'text/css' : 'application/javascript';
      res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-cache' }); return fs.createReadStream(file).pipe(res);
    }
    json(res, 404, { error: 'Not found' });
  } catch (error) { json(res, 500, { error: 'Terjadi kesalahan server.' }); }
});

cleanupAuditLog();
markInterruptedCodexHistory();
cleanupCodexHistory();
const auditCleanupTimer = setInterval(cleanupAuditLog, 60 * 60 * 1000);
auditCleanupTimer.unref();
const codexHistoryCleanupTimer = setInterval(cleanupCodexHistory, 60 * 60 * 1000);
codexHistoryCleanupTimer.unref();
server.listen(PORT, HOST, () => console.log(`Server dashboard listening at http://${HOST}:${PORT}`));
