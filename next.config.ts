/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ['sharp'],
    outputFileTracingIncludes: {
      'src/pages/api/dtf/generate.ts': ['node_modules/sharp/**/*'],
      'src/app/api/dtf/generate/route.ts': ['node_modules/sharp/**/*'] // harmless if the file doesn't exist
    }
  }
};
export default nextConfig;
