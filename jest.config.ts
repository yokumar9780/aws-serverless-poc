import type { Config } from 'jest';

/**
 * Jest configuration for CDK assertion tests and Lambda handler unit tests.
 *
 * Key decisions:
 * - testEnvironment: 'node' — not 'jsdom'. We're testing serverless infra and
 *   backend handlers, not browser code.
 * - roots: ['<rootDir>/test'] — only look for tests under test/. Keeps jest from
 *   accidentally picking up files in src/ or lib/.
 * - transform: ts-jest — compiles TypeScript test files on the fly so we don't
 *   need a separate build step before running tests.
 *
 * Test file conventions:
 *   test/infra/*.test.ts   — CDK assertion tests (verify CloudFormation templates)
 *   test/unit/*.test.ts    — Lambda handler unit tests (mock DynamoDB, test logic)
 */
const config: Config = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': 'ts-jest',
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
};

export default config;
