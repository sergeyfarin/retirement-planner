import type { RetirementInput, SpendingPeriod, IncomeSource, LumpSumEvent } from './retirementEngine';
import init, { run_monte_carlo } from 'rust-engine';

export interface WorkerInputMessage {
    type: 'RUN_SIMULATION';
    id: string;
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    payload: any;
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

let wasmReady = false;

self.onmessage = async (event: MessageEvent<WorkerInputMessage>) => {
    const { type, id, payload } = event.data;

    if (type === 'RUN_SIMULATION') {
        try {
            // Initialize WASM module on first use
            if (!wasmReady) {
                await init();
                wasmReady = true;
            }

            self.postMessage({
                type: 'SIMULATION_PROGRESS',
                id,
                payload: { progress: 0.05 }
            });

            // Call compiled WebAssembly module
            const result = run_monte_carlo(
                payload.input,
                payload.spendingPeriods,
                payload.incomeSources,
                payload.lumpSumEvents,
                payload.months,
                payload.retireMonth
            );

            self.postMessage({
                type: 'SIMULATION_PROGRESS',
                id,
                payload: { progress: 1.0 }
            });

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
