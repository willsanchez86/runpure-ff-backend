/** Route for GET /health. */
import { Router } from 'express';
import { getHealth } from '../controller/health.controller.js';

/** Router for GET /health. */
export const healthRoutes = Router();
healthRoutes.get('/', getHealth);
