module.exports = {
  root: true,
  extends: ['@react-native'],
  ignorePatterns: [
    'android/',
    'node_modules/',
    '__tests__/',
    'src/db/test.ts',
    'src/db/schemaTest.ts',
    'src/db/migrationTest.ts',
  ],
  rules: {
    '@typescript-eslint/no-unused-vars': 'warn',
    'react-hooks/exhaustive-deps': 'warn',

    // Design-system drift guard, editor-side. `__tests__/designSystem.test.ts`
    // enforces the same rules in CI with exemptions for the theme itself and
    // the two PDF generators; this gives the feedback while you type.
    'no-restricted-syntax': [
      'warn',
      {
        selector: "Literal[value=/^#(?!000$|000000$)[0-9a-fA-F]{3,8}$/]",
        message:
          'Raw hex colour. Import the token from src/theme/phcTheme instead — if the value does not exist there, add it to the theme.',
      },
      {
        selector:
          "Property[key.name=/^(padding|margin|gap)(Top|Bottom|Left|Right|Horizontal|Vertical)?$/] > Literal[raw=/^\\d+$/]",
        message: 'Off-scale spacing. Use a SPACING token from src/theme/phcTheme.',
      },
      {
        selector: "Property[key.name='borderRadius'] > Literal[raw=/^\\d+$/]",
        message: 'Off-scale radius. Use a RADIUS token from src/theme/phcTheme.',
      },
      {
        selector: "Property[key.name='fontSize'] > Literal[raw=/^\\d+$/]",
        message: 'Off-scale font size. Use a TYPE token from src/theme/phcTheme.',
      },
    ],
  },
  overrides: [
    {
      // The theme defines the values, and the PDF generators deliberately use a
      // light print palette that must not follow the dark navy app theme.
      files: ['src/theme/phcTheme.ts', 'src/utils/pdfGenerator.ts', 'src/utils/adminListPdf.ts'],
      rules: { 'no-restricted-syntax': 'off' },
    },
  ],
};
