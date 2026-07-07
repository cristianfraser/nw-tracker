import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // react-hooks 7 flags pre-existing patterns across the app; keep them visible as warnings
      // until fixed so `npm run lint` gates only on hard rules (e.g. the chart-layer boundary).
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      // `_`-prefixed = intentionally unused (destructuring placeholders, unused handler args).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  // Chart boundary: recharts is chart-layer-internal. Pages and non-chart components compose the
  // App* wrappers from src/components/charts/ instead of recharts directly.
  {
    files: ['**/*.{ts,tsx}'],
    ignores: ['src/components/charts/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'recharts',
              message: 'recharts is chart-layer-internal. Use components from src/components/charts/.',
            },
          ],
        },
      ],
    },
  },
  // Inside the chart layer, chart roots/containers/tooltips are owned by the App* wrappers and
  // ChartTooltip; other chart components compose primitives (Line, Bar, XAxis, …) as children.
  {
    files: ['src/components/charts/**/*.{ts,tsx}'],
    ignores: [
      'src/components/charts/AppLineChart.tsx',
      'src/components/charts/AppComposedChart.tsx',
      'src/components/charts/AppPieChart.tsx',
      'src/components/charts/ChartTooltip.tsx',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'recharts',
              importNames: [
                'LineChart',
                'ComposedChart',
                'PieChart',
                'ResponsiveContainer',
                'Tooltip',
                'DefaultTooltipContent',
              ],
              message:
                'Chart roots, ResponsiveContainer, and Tooltip are owned by the App* wrappers and ChartTooltip.',
            },
          ],
        },
      ],
    },
  },
);
