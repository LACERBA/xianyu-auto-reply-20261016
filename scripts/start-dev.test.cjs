const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { once } = require('node:events');
const {
  SERVICES, FRONTEND_PORT, fingerprint, serviceEnvironment,
  createConfigurations, requireFreePorts, pythonVersion,
} = require('./start-dev.cjs');

const ROOT = path.resolve(__dirname, '..');

function temporaryProject(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xianyu-dev-test-'));
  for (const service of SERVICES) {
    fs.mkdirSync(path.join(directory, service.name));
    fs.copyFileSync(path.join(ROOT, service.name, '.env.example'), path.join(directory, service.name, '.env.example'));
  }
  context.after(() => fs.rmSync(directory, { recursive: true }));
  return directory;
}

function configuration(file) {
  return Object.fromEntries(fs.readFileSync(file, 'utf8').split(/\r?\n/)
    .filter(line => /^[A-Z_]+="/.test(line))
    .map(line => {
      const separator = line.indexOf('=');
      return [line.slice(0, separator), JSON.parse(line.slice(separator + 1))];
    }));
}

test('主系统端口统一加前缀，数据库端口不变', () => {
  assert.equal(FRONTEND_PORT, 19000);
  assert.deepEqual(SERVICES.map(service => service.port), [18089, 18090, 18091]);
  for (const service of SERVICES) {
    const config = fs.readFileSync(path.join(ROOT, service.name, 'app/core/config.py'), 'utf8');
    assert.match(config, new RegExp(`service_port: int = Field\\(default=${service.port},`));
    const example = fs.readFileSync(path.join(ROOT, service.name, '.env.example'), 'utf8');
    assert.match(example, /^MYSQL_PORT=3306$/m);
    assert.match(example, /^REDIS_PORT=6379$/m);
  }
  const vite = fs.readFileSync(path.join(ROOT, 'frontend/vite.config.ts'), 'utf8');
  assert.match(vite, /port: 19000,/);
  assert.equal(vite.match(/target: 'http:\/\/127\.0\.0\.1:18089'/g).length, 2);
});

test('三个后端继承相同的共享目录和互调地址', () => {
  const root = path.join(os.tmpdir(), '包含 空格的项目');
  const env = serviceEnvironment(root);
  assert.equal(env.HOST, '127.0.0.1');
  assert.equal(env.ENVIRONMENT, 'development');
  assert.equal(env.STATIC_DIR, path.join(root, 'backend-web', 'static'));
  assert.equal(env.BACKUP_DIR, path.join(root, 'backups'));
  assert.equal(env.BACKEND_WEB_SERVICE_URL, 'http://127.0.0.1:18089');
  assert.equal(env.WEBSOCKET_SERVICE_URL, 'http://127.0.0.1:18090');
  assert.equal(env.SCHEDULER_SERVICE_URL, 'http://127.0.0.1:18091');
  assert.equal(env.FRONTEND_PUBLIC_URL, 'http://127.0.0.1:19000');
});

test('首次生成配置安全转义密码并使用小连接池', context => {
  const root = temporaryProject(context);
  const password = 'test$&"\\password';
  createConfigurations(root, {
    MYSQL_HOST: '127.0.0.1', MYSQL_PORT: '3306', MYSQL_USER: 'dev',
    MYSQL_PASSWORD: password, MYSQL_DATABASE: 'xianyu_data',
    REDIS_HOST: '127.0.0.1', REDIS_PORT: '6379', REDIS_PASSWORD: '', REDIS_DB: '0',
  });
  for (const service of SERVICES) {
    const file = path.join(root, service.name, '.env');
    const values = configuration(file);
    assert.equal(values.MYSQL_PASSWORD, password);
    assert.equal(values.MYSQL_USER, 'dev');
    assert.equal(values.REDIS_PASSWORD, '');
    assert.equal(values.MYSQL_PORT, '3306');
    assert.equal(values.REDIS_PORT, '6379');
    assert.equal(values.DB_POOL_SIZE, '5');
    assert.equal(values.DB_MAX_OVERFLOW, '5');
    assert.equal(values.REDIS_POOL_SIZE, '20');
    assert.equal(values.SQL_ECHO, 'false');
    assert.equal(values.STATIC_DIR, path.join(root, 'backend-web', 'static').replace(/\\/g, '/'));
    const contents = fs.readFileSync(file, 'utf8');
    assert.equal(contents.includes('your_mysql_password'), false);
    assert.equal(contents.replace(/\r\n/g, '').includes('\n'), false);
  }
});

test('再次启动不覆盖已有环境配置', context => {
  const root = temporaryProject(context);
  const existing = 'MYSQL_USER=existing\r\nMYSQL_PASSWORD=keep-this-value\r\n';
  const file = path.join(root, SERVICES[0].name, '.env');
  fs.writeFileSync(file, existing);
  createConfigurations(root, { MYSQL_USER: 'another' });
  assert.equal(fs.readFileSync(file, 'utf8'), existing);
});

test('依赖指纹只随依赖内容或解释器版本改变', context => {
  const root = temporaryProject(context);
  const file = path.join(root, 'requirements.txt');
  fs.writeFileSync(file, 'first');
  const initial = fingerprint([file], '3.11.9');
  assert.equal(fingerprint([file], '3.11.9'), initial);
  assert.notEqual(fingerprint([file], '3.12.0'), initial);
  fs.writeFileSync(file, 'second');
  assert.notEqual(fingerprint([file], '3.11.9'), initial);
});

test('端口已占用时拒绝启动且不会停止占用者', async () => {
  const server = net.createServer(socket => socket.end());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  try {
    await assert.rejects(requireFreePorts([port]), /已被占用/);
    assert.equal(server.listening, true);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
  await requireFreePorts([port]);
});

test('Python 不存在时不误判为有效虚拟环境', () => {
  assert.equal(pythonVersion(path.join(os.tmpdir(), 'does-not-exist-python.exe')), '');
});

test('配置校验允许低资源部署使用小连接池', () => {
  const config = fs.readFileSync(path.join(ROOT, 'common/core/config.py'), 'utf8');
  assert.match(config, /db_pool_size: int = Field\(default=800, ge=1\)/);
  assert.match(config, /redis_pool_size: int = Field\(default=800, alias="REDIS_POOL_SIZE", ge=1\)/);
});
