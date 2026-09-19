import { tryOnScopeDispose } from '@vueuse/core';
import { computed, ref, shallowRef, toValue, watch } from 'vue';

import { NamespaceManager } from '../server/index.js';
import { createDebouncedCache } from '../utils/createDebouncedCache.js';
import { clearPluginIdCache, resolvePluginId } from './resolvePluginId.js';
import { useCameraUi } from './useCameraUi.js';
import { extractCameraId } from './utils.js';

import type { Promisify, RPCClient } from '@camera.ui/rpc';
import type { FormSubmitResponse, SchemaConfig } from '@camera.ui/sdk';
import type { ComputedRef, MaybeRefOrGetter, Ref, ShallowRef } from 'vue';
import type { CameraIdentifier } from './utils.js';

export interface StorageRPC {
  getValue<T = string>(key: string, defaultValue?: T): Promise<T | undefined>;
  setValue<T = string>(key: string, newValue: T): Promise<void>;
  submitValue(key: string, newValue: unknown): Promise<FormSubmitResponse | void>;
  hasValue(key: string): boolean;
  getConfig(): Promise<SchemaConfig>;
  setConfig(newConfig: Record<string, unknown>): Promise<void>;
  getSchema<T>(key: string): T | undefined;
  hasSchema(key: string): boolean;
}

export interface ReactiveStorage {
  readonly proxy: Promisify<StorageRPC>;
  readonly client: RPCClient;
  readonly config: ShallowRef<SchemaConfig | undefined>;
  readonly isLoading: Ref<boolean>;
  readonly error: Ref<Error | undefined>;
  getConfig(): Promise<SchemaConfig | undefined>;
  setValue<T = unknown>(key: string, value: T): Promise<void>;
  setConfig(newConfig: Record<string, unknown>): Promise<void>;
  submitValue(key: string, value: unknown): Promise<FormSubmitResponse | void>;
}

export interface UseStorageReturn {
  config: ShallowRef<SchemaConfig | undefined>;
  isLoading: ComputedRef<boolean>;
  error: Ref<Error | undefined>;
  getConfig(): Promise<SchemaConfig | undefined>;
  setValue<T = unknown>(key: string, value: T): Promise<void>;
  setConfig(newConfig: Record<string, unknown>): Promise<void>;
  submitValue(key: string, value: unknown): Promise<FormSubmitResponse | void>;
  isConnected: Ref<boolean>;
}

function createReactiveStorage(proxy: Promisify<StorageRPC>, client: RPCClient): ReactiveStorage {
  const config = shallowRef<SchemaConfig | undefined>();
  const isLoading = ref(false);
  const error = ref<Error | undefined>();
  let inFlightConfig: Promise<SchemaConfig | undefined> | null = null;

  async function getConfig(): Promise<SchemaConfig | undefined> {
    if (inFlightConfig) return inFlightConfig;
    isLoading.value = true;
    error.value = undefined;

    try {
      inFlightConfig = proxy.getConfig().finally(() => {
        inFlightConfig = null;
      });
      config.value = await inFlightConfig;
      return config.value;
    } catch (err) {
      error.value = err instanceof Error ? err : new Error(String(err));
      return undefined;
    } finally {
      isLoading.value = false;
    }
  }

  async function setValue<T = unknown>(key: string, value: T): Promise<void> {
    isLoading.value = true;
    error.value = undefined;

    try {
      await proxy.setValue(key, value);
      await getConfig();
    } catch (err) {
      error.value = err instanceof Error ? err : new Error(String(err));
      throw err;
    } finally {
      isLoading.value = false;
    }
  }

  async function setConfig(newConfig: Record<string, unknown>): Promise<void> {
    isLoading.value = true;
    error.value = undefined;

    try {
      await proxy.setConfig(newConfig);
      await getConfig();
    } catch (err) {
      error.value = err instanceof Error ? err : new Error(String(err));
      throw err;
    } finally {
      isLoading.value = false;
    }
  }

  async function submitValue(key: string, value: unknown): Promise<FormSubmitResponse | void> {
    isLoading.value = true;
    error.value = undefined;

    try {
      const response = await proxy.submitValue(key, value);

      if (!response?.toast || response.toast.type !== 'error') {
        await getConfig();
      }

      return response;
    } catch (err) {
      error.value = err instanceof Error ? err : new Error(String(err));
      throw err;
    } finally {
      isLoading.value = false;
    }
  }

  return {
    proxy,
    client,
    config,
    isLoading,
    error,
    getConfig,
    setValue,
    setConfig,
    submitValue,
  };
}

const storageCache = createDebouncedCache<ReactiveStorage>({
  releaseDelay: 1000,
});

function getPluginStorageKey(pluginId: string): string {
  return `plugin:${pluginId}`;
}

function getCameraStorageKey(pluginId: string, cameraId: string): string {
  return `plugin:${pluginId}:camera:${cameraId}`;
}

function getSensorStorageKey(pluginId: string, sensorId: string): string {
  return `plugin:${pluginId}:sensor:${sensorId}`;
}

function acquireStorage(key: string, client: RPCClient, createProxy: () => Promisify<StorageRPC>): ReactiveStorage {
  // a proxy answers only on the client it was created on, an entry left over
  // from a rebuilt connection would fail every call
  const cached = storageCache.get(key);
  if (cached && cached.client !== client) storageCache.forceRelease(key);
  return storageCache.acquire(key, () => createReactiveStorage(createProxy(), client));
}

function releaseStorage(key: string): void {
  storageCache.release(key);
}

export function clearStorageCache(): void {
  storageCache.clear();
  clearPluginIdCache();
}

interface StorageComposableState {
  currentStorageKey: string | undefined;
  cachedStorage: ReactiveStorage | undefined;
}

function createStorageState(): StorageComposableState {
  return {
    currentStorageKey: undefined,
    cachedStorage: undefined,
  };
}

function cleanupStorage(state: StorageComposableState, isConnected: Ref<boolean>, config: ShallowRef<SchemaConfig | undefined>): void {
  if (state.currentStorageKey) {
    releaseStorage(state.currentStorageKey);
    state.currentStorageKey = undefined;
  }
  isConnected.value = false;
  state.cachedStorage = undefined;
  config.value = undefined;
}

function bindStorage(
  state: StorageComposableState,
  storageKey: string,
  client: RPCClient,
  config: ShallowRef<SchemaConfig | undefined>,
  createProxy: () => Promisify<StorageRPC>,
): void {
  if (state.currentStorageKey === storageKey && state.cachedStorage?.client === client) return;

  if (state.currentStorageKey && state.currentStorageKey !== storageKey) {
    releaseStorage(state.currentStorageKey);
    // the previous plugin's form must not stay on screen while the next one loads
    config.value = undefined;
  }

  state.currentStorageKey = storageKey;
  state.cachedStorage = acquireStorage(storageKey, client, createProxy);
}

const GET_CONFIG_RETRY_DELAYS = [2_000, 5_000, 10_000, 15_000, 15_000, 15_000, 15_000, 15_000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createStorageOperations(state: StorageComposableState, config: ShallowRef<SchemaConfig | undefined>, isLoading: Ref<boolean>, error: Ref<Error | undefined>) {
  let inflightGetConfig: Promise<SchemaConfig | undefined> | undefined;
  let inflightStorage: ReactiveStorage | undefined;

  function getConfig(): Promise<SchemaConfig | undefined> {
    if (!inflightGetConfig || inflightStorage !== state.cachedStorage) {
      inflightStorage = state.cachedStorage;
      const request = getConfigWithRetry().finally(() => {
        if (inflightGetConfig === request) {
          inflightGetConfig = undefined;
          inflightStorage = undefined;
        }
      });
      inflightGetConfig = request;
    }
    return inflightGetConfig;
  }

  async function getConfigWithRetry(): Promise<SchemaConfig | undefined> {
    const cached = state.cachedStorage;
    if (!cached) return undefined;

    isLoading.value = true;
    try {
      let result = await cached.getConfig();
      for (const delay of GET_CONFIG_RETRY_DELAYS) {
        if (!cached.error.value || state.cachedStorage !== cached) break;
        await sleep(delay);
        if (state.cachedStorage !== cached) break;
        result = await cached.getConfig();
      }
      if (state.cachedStorage !== cached) return result;

      config.value = cached.config.value;
      error.value = cached.error.value;
      return result;
    } finally {
      isLoading.value = false;
    }
  }

  async function setValue<T = unknown>(key: string, value: T): Promise<void> {
    const cached = state.cachedStorage;
    if (!cached) {
      throw new Error('Storage not connected');
    }

    isLoading.value = true;
    error.value = undefined;

    try {
      await cached.setValue(key, value);
      if (state.cachedStorage === cached) {
        config.value = cached.config.value;
      }
    } catch (err) {
      error.value = err instanceof Error ? err : new Error(String(err));
      throw err;
    } finally {
      isLoading.value = false;
    }
  }

  async function setConfig(newConfig: Record<string, unknown>): Promise<void> {
    const cached = state.cachedStorage;
    if (!cached) {
      throw new Error('Storage not connected');
    }

    isLoading.value = true;
    error.value = undefined;

    try {
      await cached.setConfig(newConfig);
      if (state.cachedStorage === cached) {
        config.value = cached.config.value;
      }
    } catch (err) {
      error.value = err instanceof Error ? err : new Error(String(err));
      throw err;
    } finally {
      isLoading.value = false;
    }
  }

  async function submitValue(key: string, value: unknown): Promise<FormSubmitResponse | void> {
    const cached = state.cachedStorage;
    if (!cached) {
      throw new Error('Storage not connected');
    }

    isLoading.value = true;
    error.value = undefined;

    try {
      const result = await cached.submitValue(key, value);
      if (state.cachedStorage === cached) {
        config.value = cached.config.value;
      }
      return result;
    } catch (err) {
      error.value = err instanceof Error ? err : new Error(String(err));
      throw err;
    } finally {
      isLoading.value = false;
    }
  }

  return { getConfig, setValue, setConfig, submitValue };
}

export function usePluginStorage(pluginName: MaybeRefOrGetter<string>): UseStorageReturn {
  const cameraUi = useCameraUi();
  const { rpc, isConnected: clientConnected } = cameraUi;

  const config = shallowRef<SchemaConfig | undefined>();
  const _isLoading = ref(false);
  const initialSetupDone = ref(false);
  const error = ref<Error | undefined>();
  const isConnected = ref(false);
  const state = createStorageState();

  const operations = createStorageOperations(state, config, _isLoading, error);

  async function connect(name: string): Promise<boolean> {
    const client = rpc.value;
    if (!client || !clientConnected.value) return false;

    try {
      const pluginId = await resolvePluginId(rpc, name);
      if (!pluginId) {
        throw new Error(`Plugin "${name}" not found`);
      }

      bindStorage(state, getPluginStorageKey(pluginId), client, config, () => {
        const namespaces = NamespaceManager.pluginNamespaces(pluginId);
        return client.createProxy<StorageRPC>(namespaces.pluginStorageRpc);
      });

      isConnected.value = true;
      return true;
    } catch (err) {
      error.value = err instanceof Error ? err : new Error(String(err));
      isConnected.value = false;
      return false;
    }
  }

  async function getConfig(): Promise<SchemaConfig | undefined> {
    const name = toValue(pluginName);
    if (!name) return undefined;
    const connected = await connect(name);
    if (!connected) return undefined;
    return operations.getConfig();
  }

  async function sync(): Promise<void> {
    const name = toValue(pluginName);
    if (clientConnected.value && name) {
      await connect(name);
      operations.getConfig();
    } else {
      cleanupStorage(state, isConnected, config);
    }
    initialSetupDone.value = true;
  }

  watch([clientConnected, () => toValue(pluginName)], sync, { immediate: true });

  // a short drop never flips clientConnected, the storage still needs the
  // possibly rebuilt client and a fresh config
  cameraUi.on('reconnected', sync);

  tryOnScopeDispose(() => {
    cameraUi.off('reconnected', sync);
    cleanupStorage(state, isConnected, config);
  });

  return {
    config,
    isLoading: computed(() => _isLoading.value || !initialSetupDone.value),
    error,
    isConnected,
    getConfig,
    setValue: operations.setValue,
    setConfig: operations.setConfig,
    submitValue: operations.submitValue,
  };
}

export function useCameraStorage(camera: CameraIdentifier, pluginName: MaybeRefOrGetter<string>): UseStorageReturn {
  const cameraUi = useCameraUi();
  const { rpc, isConnected: clientConnected } = cameraUi;

  const config = shallowRef<SchemaConfig | undefined>();
  const _isLoading = ref(false);
  const initialSetupDone = ref(false);
  const error = ref<Error | undefined>();
  const isConnected = ref(false);
  const state = createStorageState();

  const operations = createStorageOperations(state, config, _isLoading, error);

  async function connect(cameraId: string, name: string): Promise<boolean> {
    const client = rpc.value;
    if (!client || !clientConnected.value) return false;

    try {
      const pluginId = await resolvePluginId(rpc, name);
      if (!pluginId) {
        throw new Error(`Plugin "${name}" not found`);
      }

      bindStorage(state, getCameraStorageKey(pluginId, cameraId), client, config, () => {
        const namespaces = NamespaceManager.pluginCameraNamespaces(pluginId, cameraId);
        return client.createProxy<StorageRPC>(namespaces.cameraStorageRpc);
      });

      isConnected.value = true;
      return true;
    } catch (err) {
      error.value = err instanceof Error ? err : new Error(String(err));
      isConnected.value = false;
      return false;
    }
  }

  async function getConfig(): Promise<SchemaConfig | undefined> {
    const cameraId = extractCameraId(toValue(camera));
    const name = toValue(pluginName);

    if (!cameraId || !name) return undefined;

    const connected = await connect(cameraId, name);
    if (!connected) return undefined;

    return operations.getConfig();
  }

  async function sync(): Promise<void> {
    const cameraId = extractCameraId(toValue(camera));
    const name = toValue(pluginName);
    if (clientConnected.value && cameraId && name) {
      await connect(cameraId, name);
      operations.getConfig();
    } else {
      cleanupStorage(state, isConnected, config);
    }
    initialSetupDone.value = true;
  }

  watch([clientConnected, () => extractCameraId(toValue(camera)), () => toValue(pluginName)], sync, { immediate: true });

  cameraUi.on('reconnected', sync);

  tryOnScopeDispose(() => {
    cameraUi.off('reconnected', sync);
    cleanupStorage(state, isConnected, config);
  });

  return {
    config,
    isLoading: computed(() => _isLoading.value || !initialSetupDone.value),
    error,
    isConnected,
    getConfig,
    setValue: operations.setValue,
    setConfig: operations.setConfig,
    submitValue: operations.submitValue,
  };
}

export function useSensorStorage(sensorId: MaybeRefOrGetter<string | undefined>, pluginId: MaybeRefOrGetter<string | undefined>): UseStorageReturn {
  const cameraUi = useCameraUi();
  const { rpc, isConnected: clientConnected } = cameraUi;

  const config = shallowRef<SchemaConfig | undefined>();
  const _isLoading = ref(false);
  const initialSetupDone = ref(false);
  const error = ref<Error | undefined>();
  const isConnected = ref(false);
  const state = createStorageState();

  const operations = createStorageOperations(state, config, _isLoading, error);

  function connect(senId: string, plugId: string): boolean {
    const client = rpc.value;
    if (!client || !clientConnected.value) return false;

    try {
      bindStorage(state, getSensorStorageKey(plugId, senId), client, config, () => {
        const namespaces = NamespaceManager.pluginSensorNamespaces(plugId, senId);
        return client.createProxy<StorageRPC>(namespaces.sensorStorageRpc);
      });

      isConnected.value = true;
      return true;
    } catch (err) {
      error.value = err instanceof Error ? err : new Error(String(err));
      isConnected.value = false;
      return false;
    }
  }

  async function getConfig(): Promise<SchemaConfig | undefined> {
    const senId = toValue(sensorId);
    const plugId = toValue(pluginId);

    if (!senId || !plugId) return undefined;

    const connected = connect(senId, plugId);
    if (!connected) return undefined;

    return operations.getConfig();
  }

  function sync(): void {
    const senId = toValue(sensorId);
    const plugId = toValue(pluginId);
    if (clientConnected.value && senId && plugId) {
      connect(senId, plugId);
      operations.getConfig();
    } else {
      cleanupStorage(state, isConnected, config);
    }
    initialSetupDone.value = true;
  }

  watch([clientConnected, () => toValue(sensorId), () => toValue(pluginId)], sync, { immediate: true });

  cameraUi.on('reconnected', sync);

  tryOnScopeDispose(() => {
    cameraUi.off('reconnected', sync);
    cleanupStorage(state, isConnected, config);
  });

  return {
    config,
    isLoading: computed(() => _isLoading.value || !initialSetupDone.value),
    error,
    isConnected,
    getConfig,
    setValue: operations.setValue,
    setConfig: operations.setConfig,
    submitValue: operations.submitValue,
  };
}
