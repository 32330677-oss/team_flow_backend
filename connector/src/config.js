const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

const file = JSON.parse(
  fs.readFileSync(
    path.join(root, 'config', 'config.json'),
    'utf8'
  )
);

const abs = (p) => path.resolve(root, p);

const config = {
  apiUrl: (process.env.ASIK_API_URL || '').replace(/\/+$/, ''),
  token: process.env.ASIK_CONNECTOR_TOKEN || '',

  incoming: abs(file.folders.incoming),
  processed: abs(file.folders.processed),
  failed: abs(file.folders.failed),

  logFile: abs(file.logFile),

  chunkSize: file.chunkSize || 200,

  timeoutMs: (file.requestTimeoutSeconds || 60) * 1000,

  filePattern: new RegExp(
    file.filePattern || '\\.(txt|csv|dat)$',
    'i'
  ),

  punchCodeMap: file.punchCodeMap || {},

  punchCodeMapConfirmed:
    file.punchCodeMapConfirmed === true,
};

if (
  !config.apiUrl.startsWith('http://') &&
  !config.apiUrl.startsWith('https://')
) {
  throw new Error(
    'ASIK_API_URL must start with http:// or https://'
  );
}

if (config.token.length < 32) {
  throw new Error(
    'ASIK_CONNECTOR_TOKEN is missing or too short.'
  );
}

for (const dir of [
  config.incoming,
  config.processed,
  config.failed,
  path.dirname(config.logFile),
]) {
  fs.mkdirSync(dir, { recursive: true });
}

module.exports = config;