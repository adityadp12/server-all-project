'use strict';
const https = require('https');
const fs = require('fs');
const credentials = Object.fromEntries(fs.readFileSync('D:\\server\\initial-password.txt', 'utf8').replace(/^\uFEFF/, '').trim().split(/\r?\n/).map(line => line.split(/:\s*/, 2)));
function request(path, method = 'GET', body = null, cookie = '', extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const req = https.request({ hostname: 'server.ruangiman.my.id', port: 443, path, method, lookup: (_h, options, cb) => options.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4), headers: { ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}), ...(cookie ? { cookie } : {}), ...extraHeaders } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    req.setTimeout(15000, () => req.destroy(new Error('timeout'))); req.on('error', reject); if (payload) req.write(payload); req.end();
  });
}
(async () => {
  const login = await request('/api/login', 'POST', { username: credentials.Username, password: credentials.Password });
  if (login.status !== 200) throw new Error(`login ${login.status}`);
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const status = await request('/api/status', 'GET', null, cookie);
  if (status.status !== 200 || status.body.projects.length !== 7) throw new Error(`status ${status.status}`);
  const headers = { 'x-csrf-token': login.body.csrf };
  const terminal = await request('/api/projects/cloudtrade/terminal', 'POST', { command: '(Get-Location).Path' }, cookie, headers);
  if (terminal.status !== 200 || !terminal.body.stdout.includes('CloudTrade')) throw new Error(`terminal ${terminal.status}`);
  const codexGuard = await request('/api/projects/cloudtrade/codex', 'POST', { prompt: 'test', fullAccess: false }, cookie, headers);
  if (codexGuard.status !== 400) throw new Error(`codex guard ${codexGuard.status}`);
  if (process.env.CODEX_TEST === '1') {
    const started = await request('/api/projects/cloudtrade/codex', 'POST', { prompt: 'Reply with DASHBOARD_READY only. Do not inspect or change files.', fullAccess: true }, cookie, headers);
    if (started.status !== 202 || !started.body.id) throw new Error(`codex start ${started.status}`);
    let job;
    for (let i = 0; i < 90; i++) { await new Promise(r => setTimeout(r, 1000)); job = await request(`/api/codex-jobs/${started.body.id}`, 'GET', null, cookie); if (job.body.status !== 'running') break; }
    if (!job || job.body.status !== 'completed' || !job.body.output.includes('DASHBOARD_READY')) throw new Error(`codex job ${job?.body?.status || 'timeout'}`);
  }
  const metrics = await request('/api/metrics', 'GET', null, cookie);
  if (metrics.status !== 200 || !Array.isArray(metrics.body.disks) || !metrics.body.memory) throw new Error(`metrics ${metrics.status}`);
  if (process.env.CONTROL_TEST === '1') {
    const stopped = await request('/api/projects/music/stop', 'POST', {}, cookie, headers);
    if (stopped.status !== 200 || !stopped.body.project.disabled) throw new Error('stop control failed');
    const started = await request('/api/projects/music/start', 'POST', {}, cookie, headers);
    if (started.status !== 200 || !started.body.project.online) throw new Error('start control failed');
  }
  if (process.env.FMT_TEST === '1') {
    const stopped = await request('/api/projects/fmt/stop', 'POST', {}, cookie, headers);
    if (stopped.status !== 200 || !stopped.body.project.disabled) throw new Error('fmt stop failed');
    const started = await request('/api/projects/fmt/start', 'POST', {}, cookie, headers);
    if (started.status !== 200 || !started.body.project.online) throw new Error(`fmt start ${started.status}: ${JSON.stringify(started.body)}`);
  }
  console.log(JSON.stringify({ domain: 'server.ruangiman.my.id', tls: true, login: true, terminal: true, metrics: true, disks: metrics.body.disks.map(d => d.drive), cpu: metrics.body.cpu, ram: metrics.body.memory.percent, projects: status.body.projects.length, online: status.body.projects.filter(p => p.online).length, domains: status.body.projects.flatMap(p => p.domains).length }));
})().catch(error => { console.error(error.message); process.exit(1); });
