import path from 'node:path';

export const CHANNEL_PYTHON_VERSION = '3.12.14';
export function channelPythonArchitecture(machine) {
  const value=String(machine).trim().toLowerCase();
  return ['x86_64','amd64','x64'].includes(value)?'x64':['arm64','aarch64'].includes(value)?'arm64':null;
}
export function channelPythonPath(root, platform = process.platform) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  return paths.join(root, 'python', 'runtime', ...(platform === 'win32' ? ['python.exe'] : ['bin', 'python3']));
}

// Do not inherit model credentials or Python import paths. Windows needs its
// system directories for native DLL loading; all writable homes stay isolated.
export function channelEnvironment(home, locale, platform = process.platform, source = process.env) {
  const env = {HOME: home, TMPDIR: home, DSH_CHANNEL_HOME: home, DSH_LOCALE: locale};
  if (platform === 'win32') {
    const systemRoot = Object.entries(source).find(([key]) => key.toLowerCase() === 'systemroot')?.[1] || 'C:\\Windows';
    Object.assign(env, {SystemRoot: systemRoot, WINDIR: systemRoot, PATH: [path.win32.join(systemRoot, 'System32'), systemRoot].join(';'), USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, TEMP: home, TMP: home});
  } else env.PATH = '/usr/bin:/bin';
  for (const key of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy','SSL_CERT_FILE','SSL_CERT_DIR']) if (source[key]) env[key] = source[key];
  return env;
}
