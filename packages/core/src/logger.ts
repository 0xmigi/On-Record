import { pino } from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: undefined,
});

/** Per-stage child logger: logs duration + outcome per event (spec §8). */
export function stageLogger(stage: string) {
  return logger.child({ stage });
}
