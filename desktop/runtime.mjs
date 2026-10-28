import { startServer } from '../scripts/server.mjs';

export async function startDesktopRuntime(options = {}) {
  const server = await startServer({
    host: '127.0.0.1',
    port: options.port ?? 0,
    manager: options.manager,
    uiRoot: options.uiRoot,
  });
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/`;
  return {
    url,
    server,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
