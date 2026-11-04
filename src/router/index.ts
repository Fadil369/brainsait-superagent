export { Router } from './router.js';
export { BrainBase } from './brain-base.js';
export { SelfLearningSystem } from './learning.js';
export { LocalBrain } from './brains/local.js';
export { CloudBrain } from './brains/cloud.js';
export {
  classifyTask,
  createRouter,
  DEFAULT_ROUTER_CONFIG,
  type TaskComplexity,
  type BrainSelection,
  type LearningEntry,
  type LearningStats,
  type RouterConfig,
} from './types.js';
export type {
  BrainType,
  RoutingDecision,
  RoutingRequest,
  TaskResult,
} from '../shared/types.js';
