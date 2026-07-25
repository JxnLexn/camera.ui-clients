import type { Kernel } from '../core/kernel.js';

export type Detach = () => void;

export interface NetworkChangeSource extends EventTarget {}

export interface NetworkChangeOptions {
  readonly kernel: Kernel;
  readonly source: NetworkChangeSource;
  readonly onChange: (kernel: Kernel, event: Event) => void;
  readonly debounceMs?: number;
}

export function attachNetworkChange(options: NetworkChangeOptions): Detach {
  const debounceMs = options.debounceMs ?? 0;
  let detached = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const handler = (event: Event): void => {
    if (detached) return;
    if (debounceMs <= 0) {
      options.onChange(options.kernel, event);
      return;
    }
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (!detached) options.onChange(options.kernel, event);
    }, debounceMs);
  };

  options.source.addEventListener('change', handler);

  return () => {
    detached = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    options.source.removeEventListener('change', handler);
  };
}
