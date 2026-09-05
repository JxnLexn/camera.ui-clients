import { NamespaceManager } from '../server/index.js';
import { rpcCall } from './useRpc.js';

import type { RPCClient } from '@camera.ui/rpc';
import type { ShallowRef } from 'vue';
import type { CoreManagerInterface } from '../server/index.js';

const pluginIdCache = new Map<string, string>();
const pendingResolves = new Map<string, Promise<string | undefined>>();

export function clearPluginIdCache(): void {
  pluginIdCache.clear();
}

export async function resolvePluginId(rpcRef: Readonly<ShallowRef<RPCClient | undefined>>, pluginName: string): Promise<string | undefined> {
  const cached = pluginIdCache.get(pluginName);
  if (cached) return cached;

  const pending = pendingResolves.get(pluginName);
  if (pending) return pending;

  const promise = (async (): Promise<string | undefined> => {
    const namespaces = NamespaceManager.coreManagerNamespaces();
    const pluginInfo = await rpcCall(rpcRef, (rpc) => rpc.createProxy<CoreManagerInterface>(namespaces.coreManagerRpc).getPlugin(pluginName));

    if (pluginInfo) {
      pluginIdCache.set(pluginName, pluginInfo.id);
      return pluginInfo.id;
    }
    return undefined;
  })().finally(() => pendingResolves.delete(pluginName));

  pendingResolves.set(pluginName, promise);
  return promise;
}
