// eslint.config.js — flat config (ESLint 9). Run: npm run lint
import js from '@eslint/js'
import globals from 'globals'

const unused = ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }]
// The codebase uses `catch { /* reason */ }` on purpose (best-effort I/O).
const emptyCatchOk = ['error', { allowEmptyCatch: true }]
// Node 22 ships a global WebSocket client (used by the e2e tests).
const node = { ...globals.node, WebSocket: 'readonly' }

export default [
  {
    ignores: [
      'node_modules/**',
      'docs/**',            // design system source (React/JSX) and specs
      '.agent/**', '.impeccable/**', '.claude/**',
      'coverage/**', 'test-results/**', 'playwright-report/**',
    ],
  },

  js.configs.recommended,

  // Backend, tests and the games' local bridges (Node, ES modules)
  {
    files: ['src/**/*.js', 'tests/**/*.mjs', 'games/*/server.js', 'games/shared/**/*.js', 'games/*/test/**/*.mjs', '*.js', '*.mjs'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: node },
    rules: { 'no-unused-vars': unused, 'no-empty': emptyCatchOk },
  },

  // Browser ES modules: dashboard, player screens, brick-rush
  {
    files: ['public/**/*.js', 'games/brick-rush/public/**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.browser } },
    rules: { 'no-unused-vars': unused, 'no-empty': emptyCatchOk },
  },

  // Classic browser scripts (no import/export)
  {
    files: ['public/embed-assets/overlay.js', 'games/snake/public/game.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'script', globals: { ...globals.browser } },
    rules: { 'no-unused-vars': unused, 'no-empty': emptyCatchOk },
  },

  // e2e tests drive a browser page too (Playwright evaluate callbacks)
  {
    files: ['tests/ui/**/*.mjs'],
    languageOptions: { globals: { ...node, ...globals.browser } },
  },
]
