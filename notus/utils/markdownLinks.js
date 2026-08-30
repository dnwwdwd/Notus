const BARE_URL_WITH_CJK_SUFFIX = /^(https?:\/\/[^，。；：！？、（）【】《》“”‘’]+)([，。；：！？、（）【】《》“”‘’][\s\S]*)$/i;

export function splitBareUrlLabel(value = '') {
  const text = String(value || '');
  const match = text.match(BARE_URL_WITH_CJK_SUFFIX);
  if (!match) return null;
  return { url: match[1], suffix: match[2] };
}
