import { NativeModules, Platform } from 'react-native';

type RTMWModule = {
  probeLoad: () => Promise<string>;
};

const native: RTMWModule | undefined = NativeModules.HoneyRTMWModule;

export type RTMWProbeResult =
  | { ok: true; detail: string }
  | { ok: false; detail: string };

export async function probeRTMWLoad(): Promise<RTMWProbeResult> {
  if (Platform.OS !== 'ios') {
    return { ok: false, detail: 'RTMW probe is iOS-only.' };
  }
  if (!native) {
    return { ok: false, detail: 'NativeModules.HoneyRTMWModule is undefined — native module not registered in this build.' };
  }
  try {
    const detail = await native.probeLoad();
    return { ok: true, detail };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, detail: message };
  }
}
