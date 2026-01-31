/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  transpilePackages: ['@solana/wallet-adapter-react-ui'],
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: 'http://174.138.42.117:3333/:path*',
      },
    ];
  },
}

export default nextConfig
