const config = require('./config');

async function request(method, endpoint, body) {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, config.timeoutMs);

  let response;

  try {
    response = await fetch(
      `${config.apiUrl}${endpoint}`,
      {
        method,

        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.token}`,
        },

        body: body
          ? JSON.stringify(body)
          : undefined,

        signal: controller.signal,
      }
    );
  } catch (error) {
    throw Object.assign(
      new Error(`Network error: ${error.message}`),
      {
        retryable: true,
      }
    );
  } finally {
    clearTimeout(timer);
  }

  let data = null;

  try {
    data = await response.json();
  } catch (_) {
    // Server response was not JSON.
  }

  if (!response.ok) {
    const alreadyCompleted =
      response.status === 409 &&
      data?.message ===
        'This batch is already completed.';

    throw Object.assign(
      new Error(
        data?.message ||
        `HTTP ${response.status}`
      ),
      {
        status: response.status,

        alreadyCompleted,

        // Keep the file in incoming for:
        // - server/network problems
        // - authentication/configuration problems
        // - rate limiting
        retryable:
          response.status >= 500 ||
          [401, 403, 408, 429].includes(
            response.status
          ),
      }
    );
  }

  return data;
}

module.exports = {
  createBatch: (sourceFile, checksum) =>
    request(
      'POST',
      '/api/biometric/batches',
      {
        source_file: sourceFile,
        checksum,
      }
    ),

  sendPunches: (batchId, punches) =>
    request(
      'POST',
      '/api/biometric/punches',
      {
        batchId,
        punches,
      }
    ),

  completeBatch: (batchId, summary) =>
    request(
      'POST',
      `/api/biometric/batches/${batchId}/complete`,
      summary
    ),
};