import express from 'express';
import { requestLog } from './middleware/request-log.js';
import { errorHandler, notFound } from './middleware/error-handler.js';
import { mountRoutes } from './routes/index.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(requestLog);
  mountRoutes(app);
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
