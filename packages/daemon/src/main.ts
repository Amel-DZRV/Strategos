import { PROTOCOL } from '@strategos/shared';

export const VERSION = '0.0.0';

export function banner(): string {
  return `strategos-daemon ${VERSION} (protocol ${PROTOCOL})`;
}

if (import.meta.main) {
  console.log(banner());
}
