module.exports = {
    parser: '@typescript-eslint/parser',
    parserOptions: {
        project: 'tsconfig.json',
        sourceType: 'module',
    },
    plugins: ['@typescript-eslint/eslint-plugin'],
    extends: ['plugin:@typescript-eslint/recommended', 'plugin:prettier/recommended'],
    root: true,
    env: {
        node: true,
        jest: true,
    },
    ignorePatterns: ['.eslintrc.js'],
    rules: {
        '@typescript-eslint/interface-name-prefix': 'off',
        '@typescript-eslint/explicit-function-return-type': 'off',
        '@typescript-eslint/explicit-module-boundary-types': 'off',
        '@typescript-eslint/no-explicit-any': 'off',
        '@typescript-eslint/no-empty-interface': 'off',
        '@typescript-eslint/no-inferrable-types': 'off',
        '@typescript-eslint/no-empty-interface': 'off',
        '@typescript-eslint/no-namespace': 'off',

        '@typescript-eslint/switch-exhaustiveness-check': 'error',
        '@typescript-eslint/no-for-in-array': 'error',
        '@typescript-eslint/no-unused-vars': [
            'error',
            {
                args: 'none',
                varsIgnorePattern: '^(Markup|logger)$',
            },
        ],
    },
    overrides: [
        {
            files: ['*.entity.ts'],
            rules: {
                '@typescript-eslint/no-unused-vars': 'off',
            },
        },
    ],
}