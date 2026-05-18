function shouldSelectCreatedFileInContext({
  navigateOnFileSelect = true,
  hasRequestAction = false,
} = {}) {
  if (hasRequestAction) return false;
  return Boolean(navigateOnFileSelect);
}

module.exports = {
  shouldSelectCreatedFileInContext,
};
