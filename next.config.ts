/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingIncludes: {
    'src/pages/api/dtf/generate.ts': [
      'node_modules/sharp/**/*',
      'node_modules/@img/sharp-linux-x64/**/*',
      'node_modules/@img/sharp-libvips-linux-x64/**/*',
      'node_modules/@img/sharp-linuxmusl-x64/**/*',
      'node_modules/@img/sharp-libvips-linuxmusl-x64/**/*'
    ]
  }
};
export default nextConfig;
