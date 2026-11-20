import { getDb, getFirebaseStatus } from '../config/firebase.js';
import { AppError } from '../middleware/errorHandler.js';
import { AgentControlState, AgentStatus } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { sendNotification } from './fcmService.js';
import { COLLECTIONS, logSystemEvent } from './firestoreService.js';

const AGENT_DOC_ID = 'agent';

const DEFAULT_AGENT_STATE: AgentControlState = {
  status: 'running',
  emergencyStop: false,
  updatedAt: new Date().toISOString(),
};

export async function getAgentState(): Promise<AgentControlState> {
  const fb = getFirebaseStatus();
  if (!fb.initialized) {
    return DEFAULT_AGENT_STATE;
  }

  const db = getDb();
  const docRef = db.collection(COLLECTIONS.SYSTEM_STATE).doc(AGENT_DOC_ID);
  const snap = await docRef.get();

  if (!snap.exists) {
    const initial: AgentControlState = {
      status: 'running',
      emergencyStop: false,
      updatedAt: new Date().toISOString(),
    };
    await docRef.set(initial);
    return initial;
  }

  return snap.data() as AgentControlState;
}

export async function setAgentState(params: {
  status: AgentStatus;
  emergencyStop: boolean;
  reason?: string;
  updatedBy: string;
}): Promise<AgentControlState> {
  const db = getDb();
  const nextState: AgentControlState = {
    status: params.status,
    emergencyStop: params.emergencyStop,
    reason: params.reason,
    updatedBy: params.updatedBy,
    updatedAt: new Date().toISOString(),
  };

  await db.collection(COLLECTIONS.SYSTEM_STATE).doc(AGENT_DOC_ID).set(nextState);

  if (params.emergencyStop) {
    // Mark queued or retrying tasks as cancelled so pending work halts immediately
    const pendingSnap = await db
      .collection(COLLECTIONS.TASK_QUEUE)
      .where('status', 'in', ['queued', 'retrying'])
      .limit(200)
      .get();

    if (!pendingSnap.empty) {
      const batch = db.batch();
      const now = new Date().toISOString();
      for (const doc of pendingSnap.docs) {
        batch.update(doc.ref, {
          status: 'cancelled',
          lastError: params.reason || 'Cancelled by Emergency Stop',
          updatedAt: now,
        });
      }
      await batch.commit();
    }
  }

  await logSystemEvent(
    params.emergencyStop ? 'critical' : 'info',
    'agent_control',
    `Agent state changed to ${params.status}`,
    {
      emergencyStop: params.emergencyStop,
      reason: params.reason,
      updatedBy: params.updatedBy,
    }
  );

  try {
    await sendNotification({
      title: params.emergencyStop
        ? 'AUTOBLOGGER EMERGENCY STOP'
        : `AUTOBLOGGER Agent ${params.status.toUpperCase()}`,
      body: params.reason || `Autonomous publishing agent is now ${params.status}.`,
      data: {
        event: 'agent_state_changed',
        status: params.status,
        emergencyStop: String(params.emergencyStop),
      },
    });
  } catch (err) {
    logger.warn('Could not send FCM notification on agent state change', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return nextState;
}

export async function assertAgentOperational(): Promise<AgentControlState> {
  const state = await getAgentState();
  if (state.emergencyStop || state.status === 'stopped') {
    throw new AppError(
      `Autonomous agent is halted by emergency stop${state.reason ? `: ${state.reason}` : ''}`,
      423,
      'AGENT_EMERGENCY_STOPPED'
    );
  }
  if (state.status === 'paused') {
    throw new AppError(
      `Autonomous agent is currently paused${state.reason ? `: ${state.reason}` : ''}`,
      423,
      'AGENT_PAUSED'
    );
  }
  return state;
}
