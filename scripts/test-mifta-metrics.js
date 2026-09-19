'use strict';

const http = require('http');
const fs = require('fs');

function credentials(file) {
  return Object.fromEntries(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim().split(/\r?\n/).map(line => line.split(/:\s*/, 2)));
}

function request(path, method = 'GET', body = null, cookie = '', csrf = '') {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const req = http.request({
      hostname: '127.0.0.1', port: 8094, path, method,
      headers: {
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        ...(cookie ? { cookie } : {}),
        ...(csrf ? { 'x-csrf-token': csrf } : {})
      }
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

(async () => {
  const admin = credentials('D:\\server\\initial-password.txt');
  const adminLogin = await request('/api/login', 'POST', { username: admin.Username, password: admin.Password });
  if (adminLogin.status !== 200) throw new Error(`admin login ${adminLogin.status}`);
  const adminCookie = adminLogin.headers['set-cookie'][0].split(';')[0];
  const update = await request('/api/users/mifta', 'PATCH', { capabilities: ['status', 'metrics', 'codex-project-write'] }, adminCookie, adminLogin.body.csrf);
  if (update.status !== 200) throw new Error(`update ${update.status}: ${JSON.stringify(update.body)}`);

  const mifta = credentials('D:\\server\\mifta-credentials.txt');
  const login = await request('/api/login', 'POST', { username: mifta.Username, password: mifta.Password });
  if (login.status !== 200) throw new Error(`mifta login ${login.status}`);
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const metrics = await request('/api/metrics', 'GET', null, cookie);
  if (metrics.status !== 200 || !metrics.body.memory || !Array.isArray(metrics.body.disks)) throw new Error(`metrics ${metrics.status}`);
  console.log(JSON.stringify({ user: login.body.user, capabilities: login.body.capabilities, metricsEndpoint: 'ok', disks: metrics.body.disks.length }));
})().catch(error => { console.error(error.message); process.exit(1); });
