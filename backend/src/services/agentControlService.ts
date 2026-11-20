import {
  cancelPendingTasksForEmergencyStop,
  getAgentStateRow,
  logSystemEvent,
  saveAgentStateRow,
} from '../db/repositories.js';
import { AgentControlState, AgentStatus, WorkerEnv } from '../types/index.js';
import { AppError } from '../utils/errors.js';
import { sendNotification } from './fcmService.js';

export async function getAgentState(env: WorkerEnv): Promise<AgentControlState> {
  return getAgentStateRow(env.DB);
}

export async function setAgentState(
  env: WorkerEnv,
  params: {
    status: AgentStatus;
    emergencyStop: boolean;
    reason?: string;
    updatedBy: string;
  }
): Promise<{ agent: AgentControlState; cancelledTasks: number }> {
  const nextState: AgentControlState = {
    status: params.status,
    emergencyStop: params.emergencyStop,
    reason: params.reason || null,
    updatedBy: params.updatedBy,
    updatedAt: new Date().toISOString(),
  };

  await saveAgentStateRow(env.DB, nextState);

  let cancelledTasks = 0;
  if (params.emergencyStop) {
    cancelledTasks = await cancelPendingTasksForEmergencyStop(
      env.DB,
      params.reason || 'Cancelled by Emergency Stop'
    );
  }

  await logSystemEvent(
    env.DB,
    params.emergencyStop ? 'critical' : 'info',
    'agent_control',
    `Agent state changed to ${params.status}`,
    {
      emergencyStop: params.emergencyStop,
      reason: params.reason,
      updatedBy: params.updatedBy,
      cancelledTasks,
    }
  );

  await sendNotification(env, {
    title: params.emergencyStop
      ? 'AUTOBLOGGER EMERGENCY STOP'
      : `AUTOBLOGGER Agent ${params.status.toUpperCase()}`,
    body: params.reason || `Autonomous agent is now ${params.status}.`,
    data: {
      event: 'agent_state_changed',
      status: params.status,
      emergencyStop: String(params.emergencyStop),
    },
  });

  return { agent: nextState, cancelledTasks };
}

export async function assertAgentOperational(env: WorkerEnv): Promise<AgentControlState> {
  const state = await getAgentState(env);
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
