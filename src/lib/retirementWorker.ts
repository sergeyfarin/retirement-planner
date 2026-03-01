import { runMonteCarloSimulation } from './retirementEngine';
import type { RetirementInput, SpendingPeriod, IncomeSource, LumpSumEvent } from './retirementEngine';

export interface WorkerInputMessage {
    type: 'RUN_SIMULATION';
    id: string; // for request tracking
    payload: {
        input: RetirementInput;
        spendingPeriods: SpendingPeriod[];
        incomeSources: IncomeSource[];
        lumpSumEvents: LumpSumEvent[];
        months: number;
        retireMonth: number;
    };
}

export interface WorkerResultMessage {
    type: 'SIMULATION_COMPLETE';
    id: string;
    payload: ReturnType<typeof runMonteCarloSimulation>;
}

export interface WorkerErrorMessage {
    type: 'SIMULATION_ERROR';
    id: string;
    payload: { message: string };
}

export interface WorkerProgressMessage {
    type: 'SIMULATION_PROGRESS';
    id: string;
    payload: { progress: number };
}

export type WorkerMessageOut = WorkerResultMessage | WorkerErrorMessage | WorkerProgressMessage;

self.onmessage = (event: MessageEvent<WorkerInputMessage>) => {
    const { type, id, payload } = event.data;

    if (type === 'RUN_SIMULATION') {
        try {
            const result = runMonteCarloSimulation(
                payload.input,
                payload.spendingPeriods,
                payload.incomeSources,
                payload.lumpSumEvents,
                payload.months,
                payload.retireMonth,
                (progress) => {
                    const progMsg: WorkerProgressMessage = {
                        type: 'SIMULATION_PROGRESS',
                        id,
                        payload: { progress }
                    };
                    self.postMessage(progMsg);
                }
            );

            const successMsg: WorkerResultMessage = {
                type: 'SIMULATION_COMPLETE',
                id,
                payload: result
            };

            self.postMessage(successMsg);
        } catch (err: unknown) {
            const errMsg: WorkerErrorMessage = {
                type: 'SIMULATION_ERROR',
                id,
                payload: { message: err instanceof Error ? err.message : String(err) }
            };
            self.postMessage(errMsg);
        }
    }
};
