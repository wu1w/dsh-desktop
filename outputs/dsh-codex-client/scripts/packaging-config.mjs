import path from 'node:path';

export function packagingTarget(args = process.argv.slice(2), hostPlatform = process.platform, hostArch = process.arch) {
  const values = Object.fromEntries(args.map(arg => {
    const match = /^--(platform|arch)=(.+)$/.exec(arg);
    if (!match) throw Error('Unknown packaging argument: ' + arg);
    return [match[1], match[2]];
  }));
  const platform = values.platform || hostPlatform, arch = values.arch || hostArch;
  if (!['darwin', 'win32'].includes(platform) || !['x64', 'arm64'].includes(arch) || platform === 'win32' && arch !== 'x64') throw Error('PACKAGING_UNSUPPORTED_TARGET');
  // npm optional binaries, Python wheels and native modules must match the host.
  // A Mac-built EXE is not evidence of a working Windows runtime.
  if (platform !== hostPlatform || arch !== hostArch) throw Error('PACKAGING_NATIVE_HOST_REQUIRED: build on the target OS and architecture');
  return {platform, arch};
}

export function windowsInstallerConfig(root, manifest) {
  return {
    appId: 'com.deepseek.dsh.codex', productName: 'DSH',
    electronVersion: manifest.devDependencies.electron,
    directories: {output: path.resolve(root, '../DSH-desktop/installers')},
    artifactName: 'DSH-${version}-windows-${arch}-setup.${ext}',
    asar: false, npmRebuild: false, publish: null,
    win: {target: [{target: 'nsis', arch: ['x64']}], icon: path.join(root, 'assets/icon.ico'), executableName: 'DSH'},
    nsis: {oneClick: false, perMachine: false, allowElevation: false, allowToChangeInstallationDirectory: true, createDesktopShortcut: true, createStartMenuShortcut: true, deleteAppDataOnUninstall: false, runAfterFinish: false},
  };
}
