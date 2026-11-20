import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { getAgentState, setAgentState } from '../services/agentControlService.js';

const router = Router();
router.use(requireAuth);

const reasonSchema = z.object({
  reason: z.string().max(300).optional(),
});

router.get(
  '/status',
  asyncHandler(async (_req, res) => {
    const state = await getAgentState();
    res.json({ agent: state });
  })
);

router.post(
  '/pause',
  asyncHandler(async (req, res) => {
    const body = reasonSchema.parse(req.body || {});
    const state = await setAgentState({
      status: 'paused',
      emergencyStop: false,
      reason: body.reason || 'Paused by operator',
      updatedBy: req.principal?.uid || 'unknown',
    });
    res.json({ agent: state });
  })
);

router.post(
  '/resume',
  asyncHandler(async (req, res) => {
    const body = reasonSchema.parse(req.body || {});
    const state = await setAgentState({
      status: 'running',
      emergencyStop: false,
      reason: body.reason || 'Resumed by operator',
      updatedBy: req.principal?.uid || 'unknown',
    });
    res.json({ agent: state });
  })
);

router.post(
  '/emergency-stop',
  asyncHandler(async (req, res) => {
    const body = reasonSchema.parse(req.body || {});
    const state = await setAgentState({
      status: 'stopped',
      emergencyStop: true,
      reason: body.reason || 'Emergency stop triggered',
      updatedBy: req.principal?.uid || 'unknown',
    });
    res.json({
      agent: state,
      message: 'Emergency stop activated. Pending queued tasks cancelled.',
    });
  })
);

export default router;
