import { Hono } from 'hono';
import { AppVariables } from '../middleware/auth.js';
import { WorkerEnv } from '../types/index.js';
import adsterraRoutes from './adsterraRoutes.js';
import agentRoutes from './agentRoutes.js';
import aiRoutes from './aiRoutes.js';
import analyticsRoutes from './analyticsRoutes.js';
import bloggerRoutes from './bloggerRoutes.js';
import contentRoutes from './contentRoutes.js';
import mediaRoutes from './mediaRoutes.js';
import notificationRoutes from './notificationRoutes.js';
import schedulerRoutes from './schedulerRoutes.js';
import seoRoutes from './seoRoutes.js';
import taskRoutes from './taskRoutes.js';
import workerRoutes from './workerRoutes.js';

const apiRouter = new Hono<{ Bindings: WorkerEnv; Variables: AppVariables }>();

apiRouter.route('/agent', agentRoutes);
apiRouter.route('/ai', aiRoutes);
apiRouter.route('/content', contentRoutes);
apiRouter.route('/seo', seoRoutes);
apiRouter.route('/blogger', bloggerRoutes);
apiRouter.route('/analytics', analyticsRoutes);
apiRouter.route('/adsterra', adsterraRoutes);
apiRouter.route('/scheduler', schedulerRoutes);
apiRouter.route('/tasks', taskRoutes);
apiRouter.route('/notifications', notificationRoutes);
apiRouter.route('/workers', workerRoutes);
apiRouter.route('/media', mediaRoutes);

export default apiRouter;
