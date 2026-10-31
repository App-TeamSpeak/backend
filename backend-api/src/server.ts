import { app } from './app';
import { env } from './config/env';

app.listen(env.PORT, '0.0.0.0', () => {
  console.log(`TeamSpeak API escuchando en el puerto ${env.PORT}`);
});
