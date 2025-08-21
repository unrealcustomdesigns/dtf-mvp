/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['sharp'],
  outputFileTracingIncludes: {
    'src/pages/api/dtf/generate.ts': ['node_modules/sharp/**/*']
  }
};
export default nextConfig;
