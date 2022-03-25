import * as esbuild from 'esbuild';
import { nodeExternalsPlugin } from 'esbuild-node-externals';
import glob from 'fast-glob';
import fs from 'fs-extra';
import path from 'path';

import { executeCmd } from './executeCmd';

interface ReadUserPluginsReturnType {
  cjs: esbuild.Plugin[];
  esm: esbuild.Plugin[];
}

/**
 * Attempts to read a package-bundler.plugins.js
 * file from the path.cwd(). Tries to read the default export and, if found,
 * merges
 */
async function readUserPlugins(): Promise<Partial<ReadUserPluginsReturnType>> {
  const defaultOut: ReadUserPluginsReturnType = { cjs: [], esm: [] };
  const pluginFilePath = path.join(process.cwd(), 'package-bundler.plugins.js');
  try {
    const stat = await fs.stat(pluginFilePath);
    if (stat.isFile()) {
      const { default: plugins }: { default: Partial<ReadUserPluginsReturnType> | undefined } = await import(
        pluginFilePath
      );
      if (!plugins || (!plugins.cjs && !plugins.esm)) {
        console.warn(
          `User plugins for package-bundler found at ${pluginFilePath} are an invalid format. Expected default export object in the following shape:\n { cjs: [], esm: [] }`,
        );
        return defaultOut;
      }
      return plugins;
    }
  } catch (error) {
    console.warn(`Error reading user plugins for package-bundler from ${pluginFilePath}`);
  }
  return defaultOut;
}

export async function buildESM(srcFilesToCompile: string[], outDir: string, sourcemap: boolean, target: string[]) {
  await esbuild.build({
    sourcemap,
    target,
    bundle: false,
    entryPoints: srcFilesToCompile,
    format: 'esm',
    outdir: outDir,
    plugins: (await readUserPlugins()).esm,
  });
}

export async function buildCJS(
  packageName: string,
  cjsFilesToCompile: string[],
  outDir: string,
  sourcemap: boolean,
  packageJsonFiles: string[],
  target: string[],
) {
  const userPlugins = await readUserPlugins();
  await esbuild.build({
    sourcemap,
    target,
    bundle: true,
    entryPoints: cjsFilesToCompile,
    format: 'cjs',
    outdir: path.join(outDir, 'cjs'),
    plugins: [
      nodeExternalsPlugin({
        packagePath: packageJsonFiles,
      }),
      ...(userPlugins.cjs ?? []),
    ],
  });
  const compiledCJSFiles = glob.sync(path.join(outDir, 'cjs', '**', '*.js'), { absolute: true, onlyFiles: true });
  compiledCJSFiles.forEach(cjsFilePath => {
    fs.moveSync(cjsFilePath, cjsFilePath.replace(/\.js$/, '.cjs.js'));
  });

  executeCmd(`cp -r ${path.join(outDir, 'cjs', '*')} ${outDir}`);
  executeCmd(`rm -rf ${path.join(outDir, 'cjs')}`);
  glob
    .sync(path.join(outDir, '**', '*.cjs.js'), { absolute: true, onlyFiles: true })
    .filter(cjsFilePath => !cjsFilePath.includes('dist/index.cjs.js'))
    .forEach(cjsFilePath => {
      const mainFile = path.basename(cjsFilePath);
      const packageJsonSubPackageName = cjsFilePath
        .replace(outDir, '')
        .replace(mainFile, '')
        .replace(/(\\|\/)$/, '');
      const pJsonTemplate = {
        main: mainFile,
        module: mainFile.replace('.cjs', ''),
        name: `${packageName}/${packageJsonSubPackageName.replace(/^(\/|\\)/, '')}`,
        types: 'index.d.ts',
      };
      fs.writeFileSync(
        path.join(outDir, `.${packageJsonSubPackageName}`, 'package.json'),
        JSON.stringify(pJsonTemplate, null, 2),
        'utf8',
      );
    });
}
