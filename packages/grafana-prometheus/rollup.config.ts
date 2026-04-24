import commonjs from '@rollup/plugin-commonjs';
import dynamicImportVars from '@rollup/plugin-dynamic-import-vars';
import image from '@rollup/plugin-image';
import json from '@rollup/plugin-json';
import resolve from '@rollup/plugin-node-resolve';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import esbuild from 'rollup-plugin-esbuild';
import { nodeExternals } from 'rollup-plugin-node-externals';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const rq = createRequire(import.meta.url);
const pkg = rq('./package.json');

const legacyOutputDefaults = {
  esModule: true,
  interop: 'compat',
};

export default [
  {
    input: 'src/index.ts',
    plugins: [
      nodeExternals({ deps: true, packagePath: './package.json' }),
      resolve(),
      commonjs(),
      esbuild({
        target: 'es2018',
        tsconfig: 'tsconfig.build.json',
      }),
      image(),
      json(),
      dynamicImportVars(),
    ],
    output: [
      {
        format: 'cjs',
        sourcemap: true,
        dir: path.dirname(pkg.main),
        entryFileNames: '[name].cjs',
        preserveModules: true,
        preserveModulesRoot: path.join(__dirname, 'src'),
        ...legacyOutputDefaults,
      },
      {
        format: 'esm',
        sourcemap: true,
        dir: path.dirname(pkg.module),
        entryFileNames: '[name].mjs',
        preserveModules: true,
        preserveModulesRoot: path.join(__dirname, 'src'),
        ...legacyOutputDefaults,
      },
    ],
    treeshake: false,
  },
];
