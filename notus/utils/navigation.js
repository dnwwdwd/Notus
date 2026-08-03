const BROWSER_NAV_PATTERNS = [
  /^\/files(?:[/?#]|$)/,
  /^\/knowledge(?:[/?#]|$)/,
  /^\/canvas(?:[/?#]|$)/,
  /^\/settings(?:[/?#]|$)/,
];
function shouldUseBrowserNavigation(href, options = {}) {
  if (options.mode === 'router') return false;
  if (options.mode === 'browser') return true;
  return BROWSER_NAV_PATTERNS.some((pattern) => pattern.test(String(href || '')));
}

export function navigateWithFallback(router, href, options = {}) {
  if (!href) return Promise.resolve(false);

  const target = String(href);
  const replace = Boolean(options.replace);

  if (typeof window === 'undefined') {
    if (!router) return Promise.resolve(false);
    return replace ? router.replace(target) : router.push(target);
  }

  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const routerAsPath = router?.asPath || '';
  if (current === target || routerAsPath === target) return Promise.resolve(false);

  if (shouldUseBrowserNavigation(target, options)) {
    if (replace) window.location.replace(target);
    else window.location.assign(target);
    return Promise.resolve(true);
  }

  if (!router) return Promise.resolve(false);

  try {
    const result = replace ? router.replace(target) : router.push(target);
    return Promise.resolve(result).then((resolved) => {
      if (resolved === false) {
        if (replace) window.location.replace(target);
        else window.location.assign(target);
      }
      return resolved;
    }).catch((error) => {
      if (replace) window.location.replace(target);
      else window.location.assign(target);
      throw error;
    });
  } catch (error) {
    if (replace) window.location.replace(target);
    else window.location.assign(target);
    return Promise.reject(error);
  }
}
