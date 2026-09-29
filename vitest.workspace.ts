export default [
  'packages/*',
  'apps/*',
  { test: { name: 'root', include: ['scripts/test/**/*.test.ts', 'eval/test/**/*.test.ts'], environment: 'node' } },
];
