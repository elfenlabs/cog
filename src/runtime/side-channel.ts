/**
 * SideChannel — typed key-value store for inter-node communication
 * without polluting the context chain.
 */

// ---------------------------------------------------------------------------
// Branded Key
// ---------------------------------------------------------------------------

export type SideChannelKey<T> = string & { __type?: T }

export function key<T>(name: string): SideChannelKey<T> {
  return name as SideChannelKey<T>
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

export interface SerializedSideChannel {
  schemaVersion: number
  entries: [string, unknown][]
}

const SCHEMA_VERSION = 1

// ---------------------------------------------------------------------------
// SideChannel
// ---------------------------------------------------------------------------

export class SideChannel {
  private data: Map<string, unknown> = new Map()

  get<T>(key: SideChannelKey<T>): T | undefined {
    return this.data.get(key) as T | undefined
  }

  set<T>(key: SideChannelKey<T>, value: T): void {
    this.data.set(key, value)
  }

  has(key: SideChannelKey<unknown>): boolean {
    return this.data.has(key)
  }

  delete(key: SideChannelKey<unknown>): void {
    this.data.delete(key)
  }

  entries(): Iterable<[string, unknown]> {
    return this.data.entries()
  }

  serialize(): SerializedSideChannel {
    return {
      schemaVersion: SCHEMA_VERSION,
      entries: [...this.data.entries()],
    }
  }

  static deserialize(data: SerializedSideChannel): SideChannel {
    if (data.schemaVersion !== SCHEMA_VERSION) {
      throw new Error(`Unsupported SideChannel schema version: ${data.schemaVersion}`)
    }
    const sc = new SideChannel()
    for (const [k, v] of data.entries) {
      sc.data.set(k, v)
    }
    return sc
  }
}
