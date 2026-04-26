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

const HTTP_ERROR_MESSAGES = {
  400: '请求参数有误，请检查输入',
  401: 'API Key 无效，请前往设置检查密钥配置',
  403: 'API Key 无权限，请确认 Key 的访问权限',
  429: '请求过于频繁，请稍后再试',
  500: '服务端出错，请检查日志或稍后重试',
  502: '上游服务暂时不可用，请稍后再试',
  503: '服务暂时不可用，请稍后再试',
};

function httpErrorMessage(status, fallback) {
  return HTTP_ERROR_MESSAGES[status] || fallback || '请求失败，请重试';
}

module.exports = {
  createAppError,
  ensureError,
  errorMessage,
  httpErrorMessage,
};
