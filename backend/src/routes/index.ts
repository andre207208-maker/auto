import { Router } from 'express';
import adsterraRoutes from './adsterraRoutes.js';
import agentRoutes from './agentRoutes.js';
import aiRoutes from './aiRoutes.js';
import analyticsRoutes from './analyticsRoutes.js';
import bloggerRoutes from './bloggerRoutes.js';
import contentRoutes from './contentRoutes.js';
import notificationRoutes from './notificationRoutes.js';
import schedulerRoutes from './schedulerRoutes.js';
import seoRoutes from './seoRoutes.js';
import taskRoutes from './taskRoutes.js';
import workerRoutes from './workerRoutes.js';

const apiRouter = Router();

apiRouter.use('/agent', agentRoutes);
apiRouter.use('/ai', aiRoutes);
apiRouter.use('/content', contentRoutes);
apiRouter.use('/seo', seoRoutes);
apiRouter.use('/blogger', bloggerRoutes);
apiRouter.use('/analytics', analyticsRoutes);
apiRouter.use('/adsterra', adsterraRoutes);
apiRouter.use('/scheduler', schedulerRoutes);
apiRouter.use('/tasks', taskRoutes);
apiRouter.use('/notifications', notificationRoutes);
apiRouter.use('/workers', workerRoutes);

export default apiRouter;
