const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const readline = require('node:readline/promises');
const { Writable } = require('node:stream');
const { createHash } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

const ROOT = path.resolve(__dirname, '..');
const SERVICES = [
  { name: 'backend-web', port: 18089 },
  { name: 'websocket', port: 18090 },
  { name: 'scheduler', port: 18091 },
];
const FRONTEND_PORT = 19000;
const children = new Set();
let stopping = false;

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || ROOT,
      env: options.env || process.env,
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      windowsHide: true,
    });
    children.add(child);
    let output = '';
    if (options.capture) child.stdout.on('data', data => { output += data; });
    if (options.capture) child.stderr.resume();
    child.once('error', error => {
      children.delete(child);
      reject(new Error(`无法执行 ${path.basename(command)}：${error.message}`));
    });
    child.once('close', code => {
      children.delete(child);
      if (code === 0) resolve(output.trim());
      else reject(new Error(`${path.basename(command)} 执行失败（退出码 ${code}）。`));
    });
  });
}

function npm(args, cwd) {
  return process.platform === 'win32'
    ? run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `npm ${args.join(' ')}`], { cwd })
    : run('npm', args, { cwd });
}

function fingerprint(files, extra = '') {
  const hash = createHash('sha256').update(extra);
  for (const file of files) hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function readMarker(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '';
}

function pythonVersion(command, args = []) {
  const result = spawnSync(command, [...args, '-c', 'import sys; print(".".join(map(str, sys.version_info[:3])))'], {
    encoding: 'utf8', windowsHide: true, timeout: 10000,
  });
  const version = (result.stdout || '').trim();
  return result.status === 0 && /^3\.(?:1[1-9]|[2-9]\d)\.\d+$/.test(version) ? version : '';
}

function findPython(root = ROOT) {
  const candidates = [];
  if (process.env.PYTHON) candidates.push([process.env.PYTHON, []]);
  for (const service of SERVICES) {
    candidates.push([venvPython(path.join(root, service.name)), []]);
  }
  if (process.platform === 'win32') {
    candidates.push(['py', ['-3.11']], ['py', ['-3']]);
    for (const name of ['python', 'python3']) {
      const found = spawnSync('where.exe', [name], { encoding: 'utf8', windowsHide: true });
      for (const executable of (found.stdout || '').trim().split(/\r?\n/)) {
        if (executable && !/\\Microsoft\\WindowsApps\\/i.test(executable)) candidates.push([executable, []]);
      }
    }
    const directory = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python');
    if (fs.existsSync(directory)) {
      for (const entry of fs.readdirSync(directory)) candidates.push([path.join(directory, entry, 'python.exe'), []]);
    }
  } else {
    candidates.push(['python3', []], ['python', []]);
  }
  for (const [command, args] of candidates) {
    const version = pythonVersion(command, args);
    if (version) return { command, args, version };
  }
  throw new Error('未找到可用的 Python 3.11+。请先安装 Windows Python 并勾选 Add Python to PATH，再双击启动后端.bat。');
}

async function ensurePython() {
  try {
    return findPython();
  } catch (error) {
    if (process.platform !== 'win32' || !process.stdin.isTTY) throw error;
    const available = spawnSync('where.exe', ['winget.exe'], { stdio: 'ignore', windowsHide: true });
    if (available.status !== 0) throw error;
    const input = readline.createInterface({ input: process.stdin, output: process.stdout });
    let answer;
    try {
      answer = await input.question('未找到 Windows Python。是否使用 winget 为当前用户安装 Python 3.11？[y/N]：');
    } finally {
      input.close();
    }
    if (!/^y(?:es)?$/i.test(answer.trim())) throw error;
    await run('winget.exe', [
      'install', '--id', 'Python.Python.3.11', '--exact', '--source', 'winget',
      '--scope', 'user', '--accept-package-agreements', '--accept-source-agreements',
      '--disable-interactivity',
    ]);
    return findPython();
  }
}

function venvPython(directory) {
  return path.join(directory, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
}

function serviceEnvironment(root = ROOT) {
  return {
    ...process.env,
    ENVIRONMENT: 'development',
    HOST: '127.0.0.1',
    PYTHONUNBUFFERED: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONPATH: [root, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
    BACKEND_WEB_PORT: '18089',
    WEBSOCKET_PORT: '18090',
    SCHEDULER_PORT: '18091',
    BACKEND_WEB_SERVICE_URL: 'http://127.0.0.1:18089',
    WEBSOCKET_SERVICE_URL: 'http://127.0.0.1:18090',
    SCHEDULER_SERVICE_URL: 'http://127.0.0.1:18091',
    BACKEND_WEB_PUBLIC_URL: 'http://127.0.0.1:18089',
    FRONTEND_PUBLIC_URL: 'http://127.0.0.1:19000',
    STATIC_DIR: path.join(root, 'backend-web', 'static'),
    BACKUP_DIR: path.join(root, 'backups'),
  };
}

function createConfigurations(root, connection) {
  for (const service of SERVICES) {
    const directory = path.join(root, service.name);
    const file = path.join(directory, '.env');
    if (fs.existsSync(file)) continue;
    let content = fs.readFileSync(path.join(directory, '.env.example'), 'utf8');
    const newline = content.includes('\r\n') ? '\r\n' : '\n';
    const values = {
      ...connection,
      ENVIRONMENT: 'development',
      HOST: '127.0.0.1',
      SQL_ECHO: 'false',
      DB_POOL_SIZE: '5',
      DB_MAX_OVERFLOW: '5',
      REDIS_POOL_SIZE: '20',
      BACKEND_WEB_PORT: '18089',
      WEBSOCKET_PORT: '18090',
      SCHEDULER_PORT: '18091',
      BACKEND_WEB_SERVICE_URL: 'http://127.0.0.1:18089',
      WEBSOCKET_SERVICE_URL: 'http://127.0.0.1:18090',
      SCHEDULER_SERVICE_URL: 'http://127.0.0.1:18091',
      BACKEND_WEB_PUBLIC_URL: 'http://127.0.0.1:18089',
      FRONTEND_PUBLIC_URL: 'http://127.0.0.1:19000',
      STATIC_DIR: path.join(root, 'backend-web', 'static').replace(/\\/g, '/'),
      BACKUP_DIR: path.join(root, 'backups').replace(/\\/g, '/'),
    };
    for (const [key, value] of Object.entries(values)) {
      const line = `${key}=${JSON.stringify(String(value))}`;
      const pattern = new RegExp(`^${key}=.*$`, 'm');
      content = pattern.test(content) ? content.replace(pattern, () => line) : `${content}${newline}${line}${newline}`;
    }
    fs.writeFileSync(file, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    console.log(`[配置] 已创建 ${service.name}/.env，已有配置不会被覆盖。`);
  }
}

async function promptConnection() {
  if (!process.stdin.isTTY) throw new Error('首次启动需要填写数据库连接信息，请双击启动后端.bat，或先配置三个服务的 .env。');
  let hidden = false;
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (!hidden) process.stdout.write(chunk, encoding);
      callback();
    },
  });
  const input = readline.createInterface({ input: process.stdin, output, terminal: true });
  const ask = async (label, fallback = '', secret = false) => {
    if (secret) {
      process.stdout.write(`${label}：`);
      hidden = true;
    }
    try {
      return (await input.question(secret ? '' : `${label} [${fallback}]：`)) || fallback;
    } finally {
      if (secret) {
        hidden = false;
        process.stdout.write('\n');
      }
    }
  };
  try {
    return {
      MYSQL_HOST: await ask('MySQL 地址', '127.0.0.1'),
      MYSQL_PORT: await ask('MySQL 端口', '3306'),
      MYSQL_DATABASE: await ask('MySQL 数据库', 'xianyu_data'),
      MYSQL_USER: await ask('MySQL 用户名', 'dev'),
      MYSQL_PASSWORD: await ask('MySQL 密码', '', true),
      REDIS_HOST: await ask('Redis 地址', '127.0.0.1'),
      REDIS_PORT: await ask('Redis 端口', '6379'),
      REDIS_PASSWORD: await ask('Redis 密码（无密码直接回车）', '', true),
      REDIS_DB: '0',
    };
  } finally {
    input.close();
  }
}

function portOpen(host, port) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host, port });
    const finish = open => { socket.destroy(); resolve(open); };
    socket.setTimeout(2000, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function requireFreePorts(ports) {
  for (const port of ports) {
    if (await portOpen('127.0.0.1', port)) throw new Error(`端口 ${port} 已被占用，请先停止原服务。本脚本不会结束其他进程。`);
  }
}

async function prepareService(service, python, env) {
  const cwd = path.join(ROOT, service.name);
  const executable = venvPython(cwd);
  if (!fs.existsSync(executable)) {
    if (fs.existsSync(path.join(cwd, '.venv'))) throw new Error(`${service.name}/.venv 不完整，请先检查或重命名该目录。`);
    console.log(`[${service.name}] 创建独立虚拟环境`);
    await run(python.command, [...python.args, '-m', 'venv', '.venv'], { cwd });
  }
  const version = pythonVersion(executable);
  if (!version) throw new Error(`${service.name}/.venv 无效或 Python 版本低于 3.11。`);
  const marker = path.join(cwd, '.venv', '.dev-dependencies.sha256');
  const hash = fingerprint([path.join(cwd, 'pyproject.toml')], version);
  const checked = spawnSync(executable, ['-m', 'pip', 'check'], { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (readMarker(marker) !== hash || checked.status !== 0) {
    console.log(`[${service.name}] 安装/更新项目依赖`);
    await run(executable, ['-m', 'pip', 'install', '-e', '.'], { cwd, env });
    await run(executable, ['-m', 'pip', 'check'], { cwd, env });
  }
  const browsers = service.name === 'scheduler' ? ['playwright'] : ['playwright', 'patchright'];
  for (const browser of browsers) {
    const probe = `from ${browser}.sync_api import sync_playwright\nfrom pathlib import Path\nwith sync_playwright() as p:\n assert Path(p.chromium.executable_path).is_file()`;
    const available = spawnSync(executable, ['-c', probe], { cwd, env, windowsHide: true, timeout: 20000, stdio: 'ignore' });
    if (available.status !== 0) {
      console.log(`[${service.name}] 安装 ${browser} Chromium`);
      await run(executable, ['-m', browser, 'install', 'chromium'], { cwd, env });
    }
  }
  fs.writeFileSync(marker, hash);
  return executable;
}

function health(port) {
  return new Promise(resolve => {
    const request = http.get(`http://127.0.0.1:${port}/health`, { timeout: 3000 }, response => {
      let body = '';
      response.on('data', data => { body += data; });
      response.on('end', () => {
        try {
          const result = JSON.parse(body);
          resolve(response.statusCode === 200 && result.success === true && result.data?.database === 'connected');
        } catch { resolve(false); }
      });
      response.on('error', () => resolve(false));
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(false));
  });
}

async function stopChildren() {
  stopping = true;
  await Promise.all([...children].map(async child => {
    if (!child.pid) return;
    if (process.platform === 'win32') {
      spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
    } else {
      child.kill('SIGTERM');
    }
  }));
}

async function startBackends() {
  await requireFreePorts(SERVICES.map(service => service.port));
  const python = await ensurePython();
  console.log(`[Python] ${python.version}`);
  if (SERVICES.some(service => !fs.existsSync(path.join(ROOT, service.name, '.env')))) {
    createConfigurations(ROOT, await promptConnection());
  }
  const env = serviceEnvironment();
  fs.mkdirSync(env.STATIC_DIR, { recursive: true });
  fs.mkdirSync(env.BACKUP_DIR, { recursive: true });
  const executables = [];
  for (const service of SERVICES) executables.push(await prepareService(service, python, env));
  let wokeWsl = false;
  for (let index = 0; index < SERVICES.length; index++) {
    const service = SERVICES[index];
    const cwd = path.join(ROOT, service.name);
    const probe = 'import json; from common.core.config import get_settings; s=get_settings(); print(json.dumps([[s.mysql_host,s.mysql_port],[s.redis_host,s.redis_port]]))';
    const endpoints = JSON.parse(await run(executables[index], ['-c', probe], { cwd, env, capture: true }));
    for (const [host, port] of endpoints) {
      if (!(await portOpen(host, port)) && !wokeWsl && process.platform === 'win32' && ['127.0.0.1', 'localhost'].includes(host)) {
        console.log('[WSL] 尝试唤醒默认发行版，等待已配置自启的数据库服务');
        await run('wsl.exe', ['--exec', '/bin/true'], { capture: true });
        wokeWsl = true;
        for (let attempt = 0; attempt < 30 && !(await portOpen(host, port)); attempt++) await delay(1000);
      }
      if (!(await portOpen(host, port))) throw new Error(`无法连接 ${host}:${port}，请检查 WSL 服务和 ${service.name}/.env。`);
    }
    console.log(`[${service.name}] 启动 http://127.0.0.1:${service.port}`);
    const child = spawn(executables[index], ['main.py'], { cwd, env, stdio: 'inherit', windowsHide: true });
    children.add(child);
    let failure = '';
    child.once('error', error => { failure = error.message; children.delete(child); });
    child.once('close', code => { failure = `退出码 ${code}`; children.delete(child); });
    const deadline = Date.now() + 300000;
    while (!(await health(service.port))) {
      if (stopping || failure) throw new Error(`${service.name} 启动失败：${failure || '已停止'}`);
      if (Date.now() >= deadline) throw new Error(`${service.name} 启动超时，请检查 ${service.name}/logs。`);
      await delay(1000);
    }
    console.log(`[${service.name}] 已就绪`);
  }
  console.log('\n全部后端已启动，按 Ctrl+C 一起停止。修改 Python 代码后，请停止并重新双击启动后端.bat。');
  while (!stopping) {
    await delay(1000);
    if (children.size !== SERVICES.length) throw new Error('有后端服务已退出，请检查上方日志后重新启动。');
  }
}

async function startFrontend() {
  await requireFreePorts([FRONTEND_PORT]);
  const cwd = path.join(ROOT, 'frontend');
  const lock = path.join(cwd, 'package-lock.json');
  const files = [path.join(cwd, 'package.json'), ...(fs.existsSync(lock) ? [lock] : [])];
  const hash = fingerprint(files, process.versions.node.split('.')[0]);
  const marker = path.join(cwd, 'node_modules', '.dev-dependencies.sha256');
  if (readMarker(marker) !== hash || !fs.existsSync(path.join(cwd, 'node_modules', 'vite', 'bin', 'vite.js'))) {
    console.log('[frontend] 安装/更新前端依赖');
    await npm(fs.existsSync(lock) ? ['ci'] : ['install'], cwd);
    fs.writeFileSync(marker, hash);
  }
  console.log(`[frontend] http://127.0.0.1:${FRONTEND_PORT}，按 Ctrl+C 停止`);
  await npm(['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(FRONTEND_PORT), '--strictPort'], cwd);
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 18) throw new Error('需要 Node.js 18+。');
  if (!['frontend', 'backend'].includes(process.argv[2])) throw new Error('启动目标必须是 frontend 或 backend。');
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => { stopChildren().then(() => { process.exitCode = 0; }); });
  }
  try {
    await (process.argv[2] === 'frontend' ? startFrontend() : startBackends());
  } catch (error) {
    if (!stopping) {
      console.error(`\n[启动失败] ${error.message}`);
      process.exitCode = 1;
    }
  } finally {
    await stopChildren();
  }
}

module.exports = { SERVICES, FRONTEND_PORT, fingerprint, serviceEnvironment, createConfigurations, requireFreePorts, pythonVersion, venvPython };

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
