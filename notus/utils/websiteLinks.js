// Only website addresses open outside the current workspace. Internal note
// references, app routes, anchors and non-web protocols retain their handlers.
export function isWebsiteLink(href = '') {
  const value = String(href || '').trim();
  if (!/^(https?:\/\/|\/\/)/i.test(value)) return false;
  try {
    const url = new URL(value, 'https://notus.invalid');
    return ['http:', 'https:'].includes(url.protocol);
  } catch {
    return false;
  }
}

export function websiteLinkProps(href) {
  return isWebsiteLink(href) ? { target: '_blank', rel: 'noopener noreferrer' } : {};
}
