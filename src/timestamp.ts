// Epoch microseconds, measured with the high-resolution monotonic clock.
const epoch = BigInt(Date.now()) * 1000n;
const origin = process.hrtime.bigint();
let last = 0n;
export function timestamp(): string {
  const measured = epoch + (process.hrtime.bigint() - origin) / 1000n;
  last = measured > last ? measured : last + 1n;
  return last.toString();
}
export const eventTimestamp = (event: { at: string; timestamp?: string }) => event.timestamp ?? String(Date.parse(event.at) * 1000);
