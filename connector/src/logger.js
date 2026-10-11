const fs = require('fs');
const config = require('./config');

function write(level, msg) {
  const line = `${new Date().toISOString()} [${level}] ${msg}`;

  console.log(line);

  try {
    fs.appendFileSync(config.logFile, line + '\n');
  } catch (_) {
    // Logging failure must not stop the connector.
  }
}

module.exports = {
  info: (message) => write('INFO', message),
  warn: (message) => write('WARN', message),
  error: (message) => write('ERROR', message),
};