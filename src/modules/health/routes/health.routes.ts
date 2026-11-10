import { Router } from 'express';
import { getHealth } from '../controller/health.controller.js';

export const healthRoutes = Router();
healthRoutes.get('/', getHealth);
