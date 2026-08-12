export function platformCommands(platform = process.platform) {
  if (platform === 'win32') {
    return {
      npm: { command: 'cmd.exe', prefix: ['/d', '/s', '/c', 'npm.cmd'] },
      tar: 'tar.exe',
      opener: { command: 'rundll32.exe', prefix: ['url.dll,FileProtocolHandler'] },
    };
  }
  if (platform === 'darwin') {
    return {
      npm: { command: 'npm', prefix: [] },
      tar: 'tar',
      opener: { command: 'open', prefix: [] },
    };
  }
  return {
    npm: { command: 'npm', prefix: [] },
    tar: 'tar',
    opener: { command: 'xdg-open', prefix: [] },
  };
}
