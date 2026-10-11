const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const config = require('./config');
const log = require('./logger');
const api = require('./apiClient');
const { parseContent } = require('./parser');

function moveTo(sourcePath, destinationDir, extra = null) {
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '-');

  const destination = path.join(
    destinationDir,
    `${stamp}_${path.basename(sourcePath)}`
  );

  try {
    fs.renameSync(
      sourcePath,
      destination
    );
  } catch (error) {
    if (error.code !== 'EXDEV') {
      throw error;
    }

    fs.copyFileSync(
      sourcePath,
      destination
    );

    fs.unlinkSync(sourcePath);
  }

  if (extra) {
    fs.writeFileSync(
      `${destination}.${extra.ext}`,
      extra.content,
      'utf8'
    );
  }

  return destination;
}

async function importFile(filePath) {
  const fileName = path.basename(filePath);

  log.info(`Processing ${fileName}`);

  const buffer = fs.readFileSync(filePath);

  const checksum = crypto
    .createHash('sha256')
    .update(buffer)
    .digest('hex');

  const {
    totalRows,
    punches,
    errors,
  } = parseContent(
    buffer.toString('utf8'),
    config.punchCodeMap
  );

  log.info(
    `${fileName}: ${totalRows} rows, ` +
    `${punches.length} valid, ` +
    `${errors.length} invalid`
  );

  // No valid rows means the file cannot be imported.
  if (
    totalRows === 0 ||
    punches.length === 0
  ) {
    log.error(
      `${fileName}: no valid rows. Moving to failed.`
    );

    moveTo(
      filePath,
      config.failed,
      {
        ext: 'errors.json',
        content: JSON.stringify(
          errors,
          null,
          2
        ),
      }
    );

    return;
  }

  const batch = await api.createBatch(
    fileName,
    checksum
  );

  // The exact same file was already imported.
  if (batch.alreadyImported) {
    log.info(
      `${fileName}: already imported ` +
      `(batch #${batch.batchId}).`
    );

    moveTo(
      filePath,
      config.processed
    );

    return;
  }

  // Send punches in chunks.
for (
  let index = 0;
  index < punches.length;
  index += config.chunkSize
) {
  const chunk = punches.slice(
    index,
    index + config.chunkSize
  );

  let result;

  try {
    result = await api.sendPunches(
      batch.batchId,
      chunk
    );
  } catch (error) {
    if (error.alreadyCompleted) {
      log.info(
        `${fileName}: batch #${batch.batchId} ` +
        'is already completed. ' +
        'Moving file to processed.'
      );

      moveTo(
        filePath,
        config.processed
      );

      return;
    }

    throw error;
  }

  log.info(
    `${fileName}: chunk ` +
    `${Math.floor(index / config.chunkSize) + 1} ` +
    `-> inserted ${result.inserted}, ` +
    `duplicates ${result.duplicates}, ` +
    `errors ${result.errors}`
  );
}

 const result = await api.completeBatch(
  batch.batchId,
  {
    totalRows,
    validRows: punches.length,
    errorRows: errors.length,
    errors: errors.slice(0, 50),
  }
);
  log.info(
    `${fileName}: batch #${batch.batchId} ` +
    `${result.batchStatus} ` +
    `(total ${result.total}, ` +
    `inserted ${result.inserted}, ` +
    `duplicates ${result.duplicates}, ` +
    `errors ${result.errors})`
  );

  // Successful processing.
  // If some input lines were invalid, keep the
  // error details next to the processed file.
  moveTo(
    filePath,
    config.processed,
    errors.length > 0
      ? {
          ext: 'errors.json',
          content: JSON.stringify(
            errors,
            null,
            2
          ),
        }
      : null
  );
}

module.exports = {
  importFile,
  moveTo,
};