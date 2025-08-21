/** @type {import('next').NextConfig} */
const nextConfig = {
  // Bundle native modules into the serverless function
  serverExternalPackages: ['sharp', 'lightningcss'],
  outputFileTracingIncludes: {
    'src/pages/api/dtf/generate.ts': [
      'node_modules/sharp/**/*',
      'node_modules/lightningcss/**/*'
    ]
  }
};
export default nextConfig;
