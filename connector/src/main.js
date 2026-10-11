const fs = require('fs');
const path = require('path');

const config = require('./config');
const log = require('./logger');
const {
  importFile,
  moveTo,
} = require('./importer');

async function main() {
  const files = fs
    .readdirSync(config.incoming)
    .filter((fileName) =>
      config.filePattern.test(fileName)
    )
    .map((fileName) =>
      path.join(
        config.incoming,
        fileName
      )
    );

  log.info(
    `Connector started. Found ${files.length} file(s).`
  );

  if (!config.punchCodeMapConfirmed) {
    log.warn(
      'punchCodeMap is NOT confirmed with the vendor. ' +
      'IN/OUT interpretation may be wrong.'
    );
  }

  for (const file of files) {
    const fileName = path.basename(file);

    try {
      await importFile(file);
    } catch (error) {
      if (error.retryable) {
        log.warn(
          `${fileName}: retryable failure: ` +
          `${error.message}. ` +
          'File remains in incoming.'
        );

        continue;
      }

      log.error(
        `${fileName}: permanent failure: ` +
        `${error.message}. ` +
        'Moving to failed.'
      );

      try {
        moveTo(
          file,
          config.failed,
          {
            ext: 'reason.txt',
            content: error.message,
          }
        );
      } catch (moveError) {
        log.error(
          `${fileName}: could not move to failed: ` +
          moveError.message
        );
      }
    }
  }

  log.info('Connector finished.');
}

main().catch((error) => {
  log.error(
    `Fatal error: ${error.message}`
  );

  process.exitCode = 1;
});