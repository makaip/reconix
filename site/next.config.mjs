/** @type {import('next').NextConfig} */
const isProd = process.env.NODE_ENV === 'production'
// Project-page deploy: makaip.github.io/reconix. Drop basePath/assetPrefix if a custom domain is added.
const repo = '/reconix'

const nextConfig = {
  output: 'export',
  basePath: isProd ? repo : '',
  assetPrefix: isProd ? repo : '',
  images: { unoptimized: true },
  reactStrictMode: true,
  // Expose base path to client code that builds asset URLs (textures, fonts in /public).
  env: { NEXT_PUBLIC_BASE_PATH: isProd ? repo : '' }
}

export default nextConfig
