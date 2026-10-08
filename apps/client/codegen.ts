import type { CodegenConfig } from '@graphql-codegen/cli';

// Reads the schema the API writes on boot (apps/api/schema.gql), so start the API once before running this.
const config: CodegenConfig = {
  schema: '../api/schema.gql',
  documents: ['src/**/*.{ts,tsx}', '!src/gql/**/*'],
  generates: {
    './src/gql/': {
      preset: 'client',
      config: { useTypeImports: true },
    },
  },
};

export default config;
