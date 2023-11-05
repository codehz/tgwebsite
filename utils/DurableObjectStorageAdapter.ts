import type { DurableObjectStorage } from "https://deno.land/x/denoflare@v0.5.2/common/cloudflare_workers_types.d.ts";
import {
  KVStorage,
  MTStorage,
  StorageKind,
  serialize_storage_kind,
} from "https://deno.land/x/mtproto@v0.4.4/storage/types.ts";

class JsonKV extends Map<string, string> implements KVStorage {
  constructor(private update: () => void, source?: Iterable<[string, string]>) {
    super(source);
  }

  set(key: string, value: string) {
    super.set(key, value);
    this.update?.();
    return this;
  }
  delete(key: string) {
    const ret = super.delete(key);
    if (ret) {
      this.update?.();
    }
    return ret;
  }
  dump() {
    return Object.fromEntries(this.entries());
  }
}

export class DurableObjectStorageAdapter implements MTStorage {
  data: Map<string, JsonKV> = new Map();
  constructor(private storage: DurableObjectStorage) {}
  async populate() {
    const values = await this.storage.list({
      allowConcurrency: true,
      prefix: "settings-",
    });
    for (const [key, value] of values) {
      this.data.set(
        key.slice("settings-".length),
        new JsonKV(() => this.sync(key), JSON.parse(value.toString()))
      );
    }
  }
  readonly sync = (key: string) => {
    const db = this.data.get(key);
    if (db) {
      const text = JSON.stringify(db.dump());
      this.storage.put("settings-" + key, text, { allowUnconfirmed: true });
    } else {
      this.storage.delete("settings-" + key, { allowUnconfirmed: true });
    }
  };
  get(kind: StorageKind): KVStorage {
    const key = serialize_storage_kind(kind);
    let ret = this.data.get(key);
    if (!ret) {
      ret = new JsonKV(() => this.sync(key));
      this.data.set(key, ret);
      this.sync(key);
    }
    return ret;
  }
  reset(kind: StorageKind): void {
    const key = serialize_storage_kind(kind);
    if (this.data.has(key)) {
      this.data.delete(key);
      this.sync(key);
    }
  }
}
