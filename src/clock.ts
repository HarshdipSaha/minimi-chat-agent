export interface Clock {
  now(): Date;
}

/** Real clock, or, when NOW is set, a clock that starts at NOW and keeps ticking. */
export function systemClock(env: Record<string, string | undefined> = process.env, real: () => number = Date.now): Clock {
  if (!env.NOW) return { now: () => new Date(real()) };
  const fixed = Date.parse(env.NOW);
  if (Number.isNaN(fixed)) throw new Error(`NOW="${env.NOW}" is not an ISO date`);
  const offset = fixed - real();
  return { now: () => new Date(real() + offset) };
}
