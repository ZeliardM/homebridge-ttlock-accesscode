import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

const tsFiles = ['src/**/*.ts'];
const jsFiles = ['homebridge-ui/**/*.js'];
const lintedFiles = [...tsFiles, ...jsFiles];
const browserGlobals = {
  clearTimeout: 'readonly',
  document: 'readonly',
  setTimeout: 'readonly',
  window: 'readonly',
};
const nodeGlobals = {
  process: 'readonly',
};

const tsRecommendedConfigs = tseslint.configs.recommended.map(config => ({
  ...config,
  files: tsFiles,
}));

const sharedRules = {
  'brace-style': 'off',
  'comma-dangle': 'off',
  'comma-spacing': 'off',
  'curly': ['error', 'all'],
  'dot-notation': 'off',
  'eqeqeq': 'error',
  'indent': 'off',
  'lines-between-class-members': 'off',
  'max-len': 'off',
  'no-console': 'error',
  'no-constant-condition': 'off',
  'no-multi-spaces': 'off',
  'no-trailing-spaces': 'off',
  'prefer-arrow-callback': 'error',
  'quotes': 'off',
  'semi': 'off',
  '@stylistic/brace-style': 'error',
  '@stylistic/comma-dangle': ['error', 'always-multiline'],
  '@stylistic/comma-spacing': 'error',
  '@stylistic/indent': ['error', 2, {
    SwitchCase: 1,
  }],
  '@stylistic/lines-between-class-members': ['error', 'always', {
    exceptAfterSingleLine: true,
  }],
  '@stylistic/max-len': ['error', 140],
  '@stylistic/member-delimiter-style': ['error', {
    multiline: {
      delimiter: 'semi',
      requireLast: true,
    },
    singleline: {
      delimiter: 'semi',
      requireLast: false,
    },
  }],
  '@stylistic/no-multi-spaces': ['error', {
    ignoreEOLComments: true,
  }],
  '@stylistic/no-trailing-spaces': 'error',
  '@stylistic/quotes': ['error', 'single'],
  '@stylistic/semi': 'error',
};

export default defineConfig(
  {
    ignores: ['dist/**'],
  },
  {
    ...js.configs.recommended,
    files: lintedFiles,
  },
  ...tsRecommendedConfigs,
  {
    files: lintedFiles,

    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },

    plugins: {
      '@stylistic': stylistic,
    },

    rules: sharedRules,
  },
  {
    files: tsFiles,

    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
    },
  },
  {
    files: ['homebridge-ui/public/**/*.js'],

    languageOptions: {
      globals: browserGlobals,
      sourceType: 'script',
    },
  },
  {
    files: ['homebridge-ui/server.js'],

    languageOptions: {
      globals: nodeGlobals,
    },
  },
);
