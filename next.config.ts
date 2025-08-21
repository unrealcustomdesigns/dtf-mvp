/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ['sharp'],
    outputFileTracingIncludes: {
      // Pages API route path (source path)
      'src/pages/api/dtf/generate.ts': [
        'node_modules/sharp/**/*',
        'node_modules/@img/**/*'
      ],
      // (Safety) App Router variant in case you add it back later
      'src/app/api/dtf/generate/route.ts': [
        'node_modules/sharp/**/*',
        'node_modules/@img/**/*'
      ]
    }
  }
};
export default nextConfig;
