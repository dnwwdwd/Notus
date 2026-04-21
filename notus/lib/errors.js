function createAppError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code || 'APP_ERROR';
  Object.entries(extra || {}).forEach(([key, value]) => {
    if (value !== undefined) error[key] = value;
  });
  return error;
}

function ensureError(error, fallbackCode = 'UNKNOWN_ERROR', fallbackMessage = '未知错误') {
  if (error instanceof Error) {
    if (!error.code) error.code = fallbackCode;
    if (!error.message) error.message = fallbackMessage;
    return error;
  }

  if (typeof error === 'string') {
    return createAppError(fallbackCode, error);
  }

  return createAppError(fallbackCode, fallbackMessage, { original: error });
}

function errorMessage(error, fallbackMessage = '未知错误') {
  return ensureError(error, 'UNKNOWN_ERROR', fallbackMessage).message || fallbackMessage;
}

module.exports = {
  createAppError,
  ensureError,
  errorMessage,
};
