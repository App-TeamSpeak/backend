import { createServer } from 'node:http';
import { app } from './app';
import { env } from './config/env';
import { createRealtimeServer } from './realtime/socket';

const httpServer = createServer(app);
const io = createRealtimeServer(httpServer);

if (require.main === module) {
  httpServer.listen(env.PORT, '0.0.0.0', () => {
    console.log(`TeamSpeak realtime escuchando en el puerto ${env.PORT}`);
  });
}

export { app, io, httpServer };
