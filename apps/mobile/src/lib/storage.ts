import * as Arr from "effect/Array";
import { pipe } from "effect/Function";
import * as SecureStore from "expo-secure-store";

import type { SavedRemoteConnection } from "./connection";

const CONNECTIONS_KEY = "t3code.connections";
const PREFERENCES_KEY = "t3code.preferences";

export interface MobilePreferences {
  readonly terminalFontSize?: number;
}

async function readStorageItem(key: string): Promise<string | null> {
  return await SecureStore.getItemAsync(key);
}

async function writeStorageItem(key: string, value: string): Promise<void> {
  await SecureStore.setItemAsync(key, value);
}

async function readJsonStorageItem<T>(key: string): Promise<T | null> {
  const raw = (await readStorageItem(key)) ?? "";
  if (!raw.trim()) {
    return null;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function loadSavedConnections(): Promise<ReadonlyArray<SavedRemoteConnection>> {
  const parsed = await readJsonStorageItem<{
    readonly connections?: ReadonlyArray<SavedRemoteConnection>;
  }>(CONNECTIONS_KEY);
  if (!parsed) {
    return [];
  }

  return pipe(
    parsed.connections ?? [],
    Arr.filter((c) => !!c.environmentId && !!c.bearerToken?.trim()),
  );
}

export async function saveConnection(connection: SavedRemoteConnection): Promise<void> {
  const current = await loadSavedConnections();
  const next = current.some((entry) => entry.environmentId === connection.environmentId)
    ? pipe(
        current,
        Arr.map((entry) => (entry.environmentId === connection.environmentId ? connection : entry)),
      )
    : pipe(current, Arr.append(connection));

  await writeStorageItem(CONNECTIONS_KEY, JSON.stringify({ connections: next }));
}

export async function clearSavedConnection(environmentId: string): Promise<void> {
  const current = await loadSavedConnections();
  const next = pipe(
    current,
    Arr.filter((entry) => entry.environmentId !== environmentId),
  );
  await writeStorageItem(CONNECTIONS_KEY, JSON.stringify({ connections: next }));
}

export async function loadPreferences(): Promise<MobilePreferences> {
  const parsed = await readJsonStorageItem<MobilePreferences>(PREFERENCES_KEY);
  if (!parsed || typeof parsed !== "object") {
    return {};
  }

  if (typeof parsed.terminalFontSize === "number") {
    return { terminalFontSize: parsed.terminalFontSize };
  }

  return {};
}

export async function savePreferencesPatch(
  patch: Partial<MobilePreferences>,
): Promise<MobilePreferences> {
  const current = await loadPreferences();
  const next: MobilePreferences = {
    ...current,
    ...patch,
  };
  await writeStorageItem(PREFERENCES_KEY, JSON.stringify(next));
  return next;
}
