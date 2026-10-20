/** @type {import('next').NextConfig} */
// Served from the custom domain root (reconix.makaip.com): no basePath/assetPrefix.
const nextConfig = {
  output: 'export',
  images: { unoptimized: true },
  reactStrictMode: true
}

export default nextConfig
