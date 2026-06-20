// Jest config for the CDK app (TypeScript via ts-jest).
//
// Without this, jest scans the whole repo with its defaults and picks up the
// vendored Backstage app's tests (backstage/packages/app/src/*.test.tsx),
// which use Backstage's own build tooling and fail to parse under the root
// config ("Cannot use import statement outside a module"). Scope jest to the
// CDK app and ignore the vendored Backstage workspace and build output.
/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // Only look for tests in the CDK app's own source dir (no test/ dir yet —
  // add one to roots when real tests land). --passWithNoTests handles empty.
  roots: ['<rootDir>/lib'],
  testMatch: ['**/*.test.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/backstage/', '/cdk.out/'],
};
