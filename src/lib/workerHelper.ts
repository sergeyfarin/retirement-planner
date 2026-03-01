import RetirementWorker from './retirementWorker?worker';
import type { WorkerInputMessage, WorkerResultMessage, WorkerErrorMessage } from './retirementWorker';

export function createSimulationWorker() {
    return new RetirementWorker();
}

export type { WorkerInputMessage, WorkerResultMessage, WorkerErrorMessage };
