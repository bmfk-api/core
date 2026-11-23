import { Signal, Req } from "../signal/Signal";
import { BaseService } from "./BaseService";
import { logInfo, logError, logWarn } from "./LogService";

// EventBus / CQRS
export const REQ_TIMEFRAME_TASK_ADD = new Req<ITimeframeTask, void>(undefined, "REQ_TIMEFRAME_TASK_ADD");
export const S_TIMEFRAME_TASK_EXECUTED = new Signal<ITimeframeTask>("S_TIMEFRAME_TASK_EXECUTED");

export interface ITimeframeTask<T = any> {
    name: string;
    start: number;
    params?: T;
    repeat: number;
    callback: (params?: T) => Promise<void>;
    executed: number;
    retries?: number;
    maxRetries?: number;
    processing?: boolean; // Флаг для предотвращения параллельного запуска одной задачи
}

export class TimeframeService extends BaseService {
    TICK_INTERVAL_MS = 1000;
    RETRY_DELAY_MS = 10_000;
    GRACE_WINDOW_MS = 30_000;

    tasks: ITimeframeTask<any>[] = [];
    private intervalId: any = 0;

    // --- Утилиты ---
    static async wait(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    // ---------------

    constructor() {
        super("TimeframeService");
    }

    async init() {
        REQ_TIMEFRAME_TASK_ADD.listener = async (req) => {
            logInfo("Add task " + req.name);
            this.tasks.push({
                ...req,
                executed: 0,
                retries: 0,
                processing: false
            });
        };

        this.intervalId = setInterval(() => {
            this.loop().catch(e => logError("Timeframe loop failed:", e));
        }, this.TICK_INTERVAL_MS);
    }

    async loop() {
        const now = Date.now();

        // Итерация идет по текущей ссылке на массив. 
        // Если массив обновится через filter в runTask, текущий цикл безопасно доработает.
        for (let i = 0; i < this.tasks.length; i++) {
            const task = this.tasks[i];
            if (!task) continue;

            // 1. Нормализация времени для повторяющихся задач
            if (task.repeat && !task.processing && now > (task.start + this.GRACE_WINDOW_MS)) {
                const diff = now - task.start;
                const missedIntervals = Math.ceil(diff / task.repeat);
                task.start += missedIntervals * task.repeat;
                logInfo(`Task ${task.name} skipped and rescheduled to ${new Date(task.start).toLocaleTimeString()}`);
                continue;
            }

            // 2. Проверка условий запуска
            const isReady = now >= task.start;
            const isNotExecutedYet = !task.executed || task.executed < task.start;

            if (isReady && isNotExecutedYet && !task.processing) {
                if (now - task.start <= this.GRACE_WINDOW_MS) {
                    // Запуск асинхронно, цикл идет дальше
                    this.runTask(task);
                } else if (!task.repeat) {
                    // 3. Очистка "зомби-задач" (разовые задачи, безнадежно пропустившие свое окно)
                    logInfo(`One-off task ${task.name} missed grace window. Dropping.`);
                    task.executed = now;
                    this.tasks = this.tasks.filter(t => t !== task);
                }
            }
        }
    }

    private async runTask(task: ITimeframeTask) {
        task.processing = true;
        
        try {
            logInfo("Execute task ", task.name);
            
            await task.callback(task.params);
            
            task.executed = Date.now();
            task.retries = 0;
            logInfo("Executed task ", task.name);

            if (task.repeat) {
                // Защита от дрейфа времени: сдвигаем от планового старта
                task.start += task.repeat;
            } else {
                // Удаление успешной разовой задачи
                this.tasks = this.tasks.filter(t => t !== task);
            }
            
            S_TIMEFRAME_TASK_EXECUTED.invoke(task);
        } catch (e) {
            logError(`Task ${task.name} error:`, e);
            task.retries = (task.retries || 0) + 1;
            
            if (task.retries > (task.maxRetries ?? 0)) {
                logWarn(`Task ${task.name} failed too many times. Dropping.`);
                this.tasks = this.tasks.filter(t => t !== task);
            } else {
                // При ошибке даем фиксированную задержку перед следующим ретраем
                task.start = Date.now() + this.RETRY_DELAY_MS;
            }
        } finally {
            task.processing = false;
        }
    }

    async finishService(): Promise<void> {
        clearInterval(this.intervalId);
    }
}