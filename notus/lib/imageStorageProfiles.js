const IMAGE_STORAGE_PROVIDERS = ['cos', 'oss', 'r2'];

const PROFILE_FIELDS = {
  bucket: 'bucket',
  region: 'region',
  endpoint: 'endpoint',
  prefix: 'prefix',
  public_base_url: 'publicBaseUrl',
  access_key_id: 'accessKeyId',
  secret_access_key: 'secretAccessKey',
};

function isImageStorageProvider(provider) {
  return IMAGE_STORAGE_PROVIDERS.includes(String(provider || '').trim().toLowerCase());
}

function imageStorageProfileKey(provider, field) {
  return `object_storage_${provider}_${field}`;
}

function hasStoredImageStorageProfile(stored = {}, provider) {
  const normalizedProvider = String(provider || '').trim().toLowerCase();
  return Object.keys(PROFILE_FIELDS).some((field) => Object.prototype.hasOwnProperty.call(stored, imageStorageProfileKey(normalizedProvider, field)));
}

function readImageStorageProfile(stored = {}, provider, fallback = {}) {
  const normalizedProvider = String(provider || '').trim().toLowerCase();
  const fallbackMatches = !hasStoredImageStorageProfile(stored, normalizedProvider)
    && String(fallback.provider || '').trim().toLowerCase() === normalizedProvider;
  const profile = {};

  Object.entries(PROFILE_FIELDS).forEach(([field, fallbackField]) => {
    const key = imageStorageProfileKey(normalizedProvider, field);
    profile[field] = stored[key] !== undefined
      ? String(stored[key] || '').trim()
      : fallbackMatches
        ? String(fallback[fallbackField] || '').trim()
        : '';
  });

  return {
    provider: normalizedProvider,
    ...profile,
    access_key_id_set: Boolean(profile.access_key_id),
    secret_access_key_set: Boolean(profile.secret_access_key),
  };
}

function isImageStorageProfileConfigured(profile = {}) {
  const provider = String(profile.provider || '').trim().toLowerCase();
  if (!isImageStorageProvider(provider)) return false;
  if (!String(profile.bucket || '').trim() || !String(profile.public_base_url || '').trim()) return false;
  if (!String(profile.access_key_id || '').trim() || !String(profile.secret_access_key || '').trim()) return false;
  if (['cos', 'oss'].includes(provider) && !String(profile.region || '').trim()) return false;
  if (provider === 'r2' && !String(profile.endpoint || '').trim()) return false;
  return true;
}

function profileToObjectStorage(profile = {}) {
  return {
    provider: profile.provider,
    bucket: profile.bucket,
    region: profile.region,
    endpoint: profile.endpoint,
    prefix: profile.prefix,
    publicBaseUrl: profile.public_base_url,
    accessKeyId: profile.access_key_id,
    secretAccessKey: profile.secret_access_key,
  };
}

module.exports = {
  IMAGE_STORAGE_PROVIDERS,
  PROFILE_FIELDS,
  isImageStorageProvider,
  imageStorageProfileKey,
  hasStoredImageStorageProfile,
  readImageStorageProfile,
  isImageStorageProfileConfigured,
  profileToObjectStorage,
};
