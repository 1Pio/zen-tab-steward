import { acquireExclusiveFileControl } from "./exclusive-control.js";

import type { ExclusiveFileControl } from "./exclusive-control.js";

const historyControlBrand = Symbol("ApplyReceiptHistoryControl");
const activeHistoryControls = new WeakMap<object, ExclusiveFileControl>();

export interface ApplyReceiptHistoryControl {
  readonly path: string;
  readonly [historyControlBrand]: true;
}

export async function acquireApplyReceiptHistoryControl(
  path: string,
  label: string
): Promise<{
  readonly capability: ApplyReceiptHistoryControl;
  release(): Promise<void>;
}> {
  const kernel = await acquireExclusiveFileControl(path, label);
  const capability: ApplyReceiptHistoryControl = Object.freeze({
    path,
    [historyControlBrand]: true as const
  });
  activeHistoryControls.set(capability, kernel);
  let released = false;
  return {
    capability,
    async release() {
      if (released) throw new Error(`${label} has already been released`);
      activeHistoryControls.delete(capability);
      released = true;
      await kernel.release();
    }
  };
}

export function requireActiveApplyReceiptHistoryKernel(
  control: ApplyReceiptHistoryControl,
  expectedPath?: string
): ExclusiveFileControl {
  const kernel = activeHistoryControls.get(control);
  if (!kernel
    || control[historyControlBrand] !== true
    || (expectedPath !== undefined && control.path !== expectedPath)) {
    throw new Error("Apply Receipt history control capability is inactive or belongs to another store");
  }
  return kernel;
}

export async function assertApplyReceiptHistoryControlHeld(
  control: ApplyReceiptHistoryControl,
  expectedPath?: string
): Promise<void> {
  await requireActiveApplyReceiptHistoryKernel(control, expectedPath).assertHeld();
}
