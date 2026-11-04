import type {
  BrainType,
  RoutingDecision,
  RoutingRequest,
  TaskResult,
} from '../shared/types.js';

export interface Brain {
  readonly name: BrainType;

  ping(): Promise<boolean>;
  route(req: RoutingRequest): Promise<RoutingDecision>;
  execute(req: RoutingRequest): Promise<TaskResult>;
}

export interface Router {
  register(brain: Brain): void;
  decide(req: RoutingRequest): Promise<RoutingDecision>;
  run(req: RoutingRequest): Promise<TaskResult>;
}

export abstract class AbstractBrain implements Brain {
  abstract readonly name: BrainType;

  async ping(): Promise<boolean> {
    return true;
  }

  abstract route(req: RoutingRequest): Promise<RoutingDecision>;
  abstract execute(req: RoutingRequest): Promise<TaskResult>;
}
