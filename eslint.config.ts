import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/',
      '**/.next/',
      '**/node_modules/',
      '.data/',
      'data-raw/',
      '**/coverage/',
      'eval/',
      '**/next-env.d.ts',
    ],
  },
  ...tseslint.configs.recommended,
);
