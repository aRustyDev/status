import eslint from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'
import { boundaryConfigs } from './eslint.boundaries.mjs'

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/dist-fallback/**',
      '**/node_modules/**',
      '**/data/**',
      'demo-output/**',
      'design/**',
      '.claude/**',
      'docs/.astro/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  // Maintenance scripts run in Node.
  { files: ['scripts/**/*.mjs', '.agents/skills/preview-browser/scripts/**/*.mjs', '.github/actions/branch-previews/**/*.mjs'], languageOptions: { globals: { ...globals.node } } },
  {
    files: ['scripts/attestation-recovery/**/*.cjs'],
    languageOptions: { globals: { ...globals.node } },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  ...boundaryConfigs(),
)
