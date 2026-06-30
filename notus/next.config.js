/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  outputFileTracingIncludes: {
    '/*': [
      './node_modules/@llamaindex/liteparse/**/*',
      './node_modules/@llamaindex/liteparse-linux-x64-gnu/**/*',
      './node_modules/@llamaindex/liteparse-linux-x64-musl/**/*',
      './node_modules/@llamaindex/liteparse-linux-arm64-gnu/**/*',
      './node_modules/@llamaindex/liteparse-linux-arm64-musl/**/*',
      './node_modules/@llamaindex/liteparse-darwin-x64/**/*',
      './node_modules/@llamaindex/liteparse-darwin-arm64/**/*',
      './node_modules/@llamaindex/liteparse-win32-x64-msvc/**/*',
      './node_modules/@llamaindex/liteparse-win32-arm64-msvc/**/*',
    ],
  },
};

module.exports = nextConfig;
