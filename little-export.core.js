/*
Copyright © 2025 Leo Zhang

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the “Software”), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/
(function () {
  const CHUNK_SIZE = 4 * 1024 * 1024; // 4MB
  const ENC = new TextEncoder();
  const DEC = new TextDecoder();

  async function deriveKey(password, salt) {
    const km = await crypto.subtle.importKey(
      "raw",
      ENC.encode(password),
      { name: "PBKDF2" },
      false,
      ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: 600000, hash: "SHA-256" },
      km,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }

  function isAllowed(category, path, config) {
    if (
      config.exclude?.[category]?.some(
        (t) => path === t || path.startsWith(t + "/")
      )
    )
      return false;
    if (config.include?.[category]?.length > 0) {
      return config.include[category].some(
        (t) => path === t || path.startsWith(t + "/")
      );
    }
    return true;
  }

  async function safeBlobToArrayBuffer(blob) {
    return Promise.race([
      blob.arrayBuffer(),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error("Blob Read Timeout")), 2000)
      ),
    ]);
  }

  async function prepForCBOR(item) {
    if (item instanceof Blob) {
      try {
        const buffer = await safeBlobToArrayBuffer(item);
        return {
          __le_blob: true,
          type: item.type,
          data: new Uint8Array(buffer),
        };
      } catch (e) {
        return null;
      }
    }
    if (ArrayBuffer.isView(item))
      return new Uint8Array(
        item.buffer.slice(item.byteOffset, item.byteOffset + item.byteLength)
      );
    if (item instanceof ArrayBuffer) return new Uint8Array(item.slice(0));
    if (Array.isArray(item)) return Promise.all(item.map(prepForCBOR));
    if (item && typeof item === "object") {
      const n = {};
      for (const k in item) n[k] = await prepForCBOR(item[k]);
      return n;
    }
    return item;
  }

  function restoreFromCBOR(item) {
    if (!item || typeof item !== "object") return item;
    if (item.__le_blob) return new Blob([item.data], { type: item.type });
    if (Array.isArray(item)) return item.map(restoreFromCBOR);
    if (item.constructor === Object) {
      const n = {};
      for (const k in item) n[k] = restoreFromCBOR(item[k]);
      return n;
    }
    return item;
  }

  function createTarHeader(filename, size, isDir = false) {
    const buffer = new Uint8Array(512);
    let name = filename;
    let prefix = "";

    if (name.length > 100) {
      let splitIndex = name.lastIndexOf("/", 154);
      if (splitIndex === -1 || splitIndex < name.length - 100)
        splitIndex = Math.max(0, name.length - 100);
      prefix = name.slice(0, splitIndex);
      name = name.slice(splitIndex + (prefix ? 1 : 0));
    }

    const writeStr = (str, offset, len) => {
      const b = ENC.encode(str);
      for (let i = 0; i < Math.min(len, b.length); i++)
        buffer[offset + i] = b[i];
    };
    const writeOctal = (num, offset, len) =>
      writeStr(num.toString(8).padStart(len - 1, "0"), offset, len - 1);

    writeStr(name, 0, 100);
    writeOctal(0o664, 100, 8); // Mode
    writeOctal(0, 108, 8); // UID
    writeOctal(0, 116, 8); // GID
    writeOctal(size, 124, 12); // Size
    writeOctal(Math.floor(Date.now() / 1000), 136, 12); // Mtime
    writeStr("        ", 148, 8); // Checksum placeholder
    buffer[156] = isDir ? 53 : 48; // Type flag
    writeStr("ustar", 257, 6);
    writeStr("00", 263, 2);
    if (prefix) writeStr(prefix, 345, 155);

    let sum = 0;
    for (let i = 0; i < 512; i++) sum += buffer[i];
    writeOctal(sum, 148, 7);
    return buffer;
  }

  class TarWriter {
    constructor(writableStream) {
      this.writer = writableStream.getWriter();
      this.pos = 0;
    }
    async writeEntry(path, data) {
      let bytes = typeof data === "string" ? ENC.encode(data) : data;
      await this.write(createTarHeader(path, bytes.length));
      await this.write(bytes);
      await this.pad();
    }
    async writeStream(path, size, readableStream) {
      await this.write(createTarHeader(path, size));
      await readableStream.pipeTo(
        new WritableStream({
          write: async (chunk) => {
            await this.write(chunk);
          },
        })
      );
      await this.pad();
    }
    async write(chunk) {
      await this.writer.write(chunk);
      this.pos += chunk.byteLength;
    }
    async pad() {
      const padding = (512 - (this.pos % 512)) % 512;
      if (padding > 0) await this.write(new Uint8Array(padding));
    }
    async close() {
      await this.write(new Uint8Array(1024)); // End of archive
      await this.writer.close();
    }
  }

  class EncryptionTransformer {
    constructor(password, salt) {
      this.salt = salt;
      this.buffer = new Uint8Array(0);
      this.keyPromise = deriveKey(password, salt);
    }
    async start(controller) {
      controller.enqueue(ENC.encode("LE_ENC"));
      controller.enqueue(this.salt);
      // For encryption verification
      await this.encryptAndPush(
        new Uint8Array(0),
        controller,
        await this.keyPromise
      );
    }
    async transform(chunk, controller) {
      const key = await this.keyPromise;
      const combined = new Uint8Array(this.buffer.length + chunk.length);
      combined.set(this.buffer);
      combined.set(chunk, this.buffer.length);
      this.buffer = combined;
      while (this.buffer.length >= CHUNK_SIZE) {
        const slice = this.buffer.slice(0, CHUNK_SIZE);
        this.buffer = this.buffer.slice(CHUNK_SIZE);
        await this.encryptAndPush(slice, controller, key);
      }
    }
    async flush(controller) {
      if (this.buffer.length > 0)
        await this.encryptAndPush(
          this.buffer,
          controller,
          await this.keyPromise
        );
    }
    async encryptAndPush(data, controller, key) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        data
      );
      const lenParams = new DataView(new ArrayBuffer(4));
      lenParams.setUint32(0, ciphertext.byteLength, true);
      controller.enqueue(iv);
      controller.enqueue(new Uint8Array(lenParams.buffer));
      controller.enqueue(new Uint8Array(ciphertext));
    }
  }

  class DecryptionSource {
    constructor(readableStream, password) {
      this.stream = readableStream;
      this.password = password;
    }
    readable() {
      const self = this;
      let reader;
      let buffer = new Uint8Array(0);
      let done = false;

      async function ensure(n) {
        while (buffer.length < n && !done) {
          const res = await reader.read();
          if (res.done) done = true;
          else {
            const t = new Uint8Array(buffer.length + res.value.length);
            t.set(buffer);
            t.set(res.value, buffer.length);
            buffer = t;
          }
        }
        return buffer.length >= n;
      }
      function consume(n) {
        const v = buffer.slice(0, n);
        buffer = buffer.slice(n);
        return v;
      }

      return new ReadableStream({
        async start(controller) {
          reader = self.stream.getReader();
          try {
            if (!(await ensure(22))) throw new Error("File too small");
            const sig = new TextDecoder().decode(consume(6));
            if (sig !== "LE_ENC") throw new Error("Not an encrypted archive");
            const salt = consume(16);
            const key = await deriveKey(self.password, salt);

            while (true) {
              if (!(await ensure(16))) break; // IV (12) + Len (4)
              const iv = consume(12);
              const lenVal = new DataView(consume(4).buffer).getUint32(0, true);
              if (!(await ensure(lenVal))) throw new Error("Corrupt chunk");
              const cipher = consume(lenVal);
              try {
                const plain = await crypto.subtle.decrypt(
                  { name: "AES-GCM", iv },
                  key,
                  cipher
                );
                controller.enqueue(new Uint8Array(plain));
              } catch (e) {
                throw new Error("Incorrect Password");
              }
            }
            controller.close();
          } catch (e) {
            controller.error(e);
          }
        },
      });
    }
  }

  async function exportData(config = {}) {
    const CBOR = window.CBOR;
    const opts = {
      fileName: "archive",
      opfs: true,
      localStorage: true,
      session: true,
      cookies: true,
      idb: true,
      cache: true,
      customItems: [],
      include: {},
      exclude: {},
      dbFilter: () => true,
      ...config,
    };
    const logger = opts.logger || console.log;

    let outputStream, downloadUrl;
    if (window.showSaveFilePicker && opts.download !== false) {
      try {
        const name = opts.password
          ? `${opts.fileName}.enc`
          : `${opts.fileName}.tar.gz`;
        const handle = await window.showSaveFilePicker({ suggestedName: name });
        outputStream = await handle.createWritable();
      } catch (e) {
        if (e.name === "AbortError") return logger("Export cancelled.");
        console.warn("FS Picker failed, fallback to blob");
      }
    }

    if (!outputStream) {
      const chunks = [];
      outputStream = new WritableStream({
        write(c) {
          chunks.push(c);
        },
        close() {
          downloadUrl = URL.createObjectURL(
            new Blob(chunks, { type: "application/octet-stream" })
          );
        },
      });
    }

    let targetStream = outputStream;
    if (opts.password) {
      logger("Encrypting...");
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const encStream = new TransformStream(
        new EncryptionTransformer(opts.password, salt)
      );
      encStream.readable.pipeTo(targetStream);
      targetStream = encStream.writable;
    }

    const gzip = new CompressionStream("gzip");
    gzip.readable.pipeTo(targetStream);
    const tar = new TarWriter(gzip.writable);

    try {
      // 1. Custom Items
      for (const item of opts.customItems) {
        logger(`Archiving custom data: ${item.path}`);
        const path = `data/custom/${item.path}`;
        if (item.data instanceof Blob)
          await tar.writeStream(path, item.data.size, item.data.stream());
        else {
          const str =
            typeof item.data === "string"
              ? item.data
              : JSON.stringify(item.data);
          await tar.writeEntry(path, str);
        }
      }

      // 2. Storage & Cookies
      if (opts.localStorage) {
        const d = {};
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (isAllowed("localStorage", k, opts))
            d[k] = localStorage.getItem(k);
        }
        await tar.writeEntry("data/ls.json", JSON.stringify(d));
      }
      if (opts.session) {
        const d = {};
        for (let i = 0; i < sessionStorage.length; i++) {
          const k = sessionStorage.key(i);
          if (isAllowed("session", k, opts)) d[k] = sessionStorage.getItem(k);
        }
        await tar.writeEntry("data/ss.json", JSON.stringify(d));
      }
      if (opts.cookies) {
        const c = document.cookie.split(";").reduce((acc, v) => {
          const [key, val] = v.split("=").map((s) => s.trim());
          if (key) acc[key] = val;
          return acc;
        }, {});
        await tar.writeEntry("data/cookies.json", JSON.stringify(c));
      }

      // 3. IndexedDB (Stabilized)
      if (opts.idb && window.indexedDB && CBOR) {
        const withTimeout = (promise, ms, tag) =>
          Promise.race([
            promise,
            new Promise((_, rej) =>
              setTimeout(() => rej(new Error(`Timeout [${tag}]`)), ms)
            ),
          ]);

        const dbs = await window.indexedDB.databases();

        for (const { name, version } of dbs) {
          if (!isAllowed("idb", name, opts) || !opts.dbFilter(name)) continue;

          logger(`Exporting IndexedDB: ${name}`);
          let db;
          try {
            db = await withTimeout(
              new Promise((res, rej) => {
                const r = indexedDB.open(name);
                r.onsuccess = () => res(r.result);
                r.onerror = () => rej(r.error);
                r.onblocked = () => rej(new Error("DB Blocked"));
              }),
              2000,
              "Open"
            );

            const storeNames = Array.from(db.objectStoreNames);
            const activeStores = [];

            if (storeNames.length > 0) {
              const stores = [];
              const metaTx = db.transaction(storeNames, "readonly");

              for (const sName of storeNames) {
                const store = metaTx.objectStore(sName);
                const count = await withTimeout(
                  new Promise((res) => {
                    const req = store.count();
                    req.onsuccess = () => res(req.result);
                    req.onerror = () => res(0);
                  }),
                  1000,
                  "Count"
                );
                if (count > 0) activeStores.push(sName);

                stores.push({
                  name: sName,
                  keyPath: store.keyPath,
                  autoIncrement: store.autoIncrement,
                  indexes: Array.from(store.indexNames).map((i) => {
                    const idx = store.index(i);
                    return {
                      name: idx.name,
                      keyPath: idx.keyPath,
                      unique: idx.unique,
                      multiEntry: idx.multiEntry,
                    };
                  }),
                });
              }
              await tar.writeEntry(
                `data/idb/${name}/schema.cbor`,
                CBOR.encode({ name, version, stores })
              );
            } else {
              await tar.writeEntry(
                `data/idb/${name}/schema.cbor`,
                CBOR.encode({ name, version, stores: [] })
              );
            }

            // Data Export
            for (const sName of activeStores) {
              logger(`Exporting IndexedDB: ${name}/${sName}`);
              let hasMore = true;
              let lastKey = null;
              let chunkId = 0;

              while (hasMore) {
                await new Promise((r) => setTimeout(r, 0)); // Yield

                const batch = await withTimeout(
                  new Promise((resolve, reject) => {
                    try {
                      const tx = db.transaction(sName, "readonly");
                      const store = tx.objectStore(sName);
                      const range =
                        lastKey !== null
                          ? IDBKeyRange.lowerBound(lastKey, true)
                          : null;
                      const request = store.openCursor(range);

                      const items = [];
                      request.onsuccess = (e) => {
                        const cursor = e.target.result;
                        if (cursor) {
                          items.push({ k: cursor.key, v: cursor.value });
                          if (items.length < 50) cursor.continue();
                          else resolve(items);
                        } else resolve(items);
                      };
                      request.onerror = () => reject(tx.error);
                    } catch (err) {
                      reject(err);
                    }
                  }),
                  5000,
                  "ReadBatch"
                );

                if (batch.length > 0) {
                  lastKey = batch[batch.length - 1].k;
                  const encBatch = [];
                  for (const item of batch) {
                    // Safe Blob Prep
                    const val = await prepForCBOR(item.v);
                    if (val !== null) encBatch.push({ k: item.k, v: val });
                  }
                  await tar.writeEntry(
                    `data/idb/${name}/${sName}/${chunkId++}.cbor`,
                    CBOR.encode(encBatch)
                  );
                } else {
                  hasMore = false;
                }
              }
            }
            db.close();
          } catch (e) {
            logger(`IndexedDB error: ${name}: ${e.message}`, "err");
            if (db)
              try {
                db.close();
              } catch (z) {}
            continue;
          }
        }
      }

      // 4. Cache
      if (opts.cache && window.caches && CBOR) {
        const keys = await caches.keys();
        for (const cacheName of keys) {
          if (!isAllowed("cache", cacheName, opts)) continue;
          logger(`Archiving cache: ${cacheName}`);
          const cache = await caches.open(cacheName);
          for (const req of await cache.keys()) {
            const res = await cache.match(req);
            if (!res) continue;
            const blob = await res.blob();
            const meta = {
              url: req.url,
              status: res.status,
              headers: Object.fromEntries(res.headers),
              type: blob.type,
            };
            const safeName = encodeURIComponent(cacheName);
            const safeHash = btoa(req.url).slice(0, 50).replace(/\//g, "_");
            await tar.writeEntry(
              `data/cache/${safeName}/${safeHash}.cbor`,
              CBOR.encode({
                meta,
                data: new Uint8Array(await blob.arrayBuffer()),
              })
            );
          }
        }
      }

      // 5. OPFS
      if (opts.opfs && navigator.storage) {
        logger("Scanning OPFS...");
        const root = await navigator.storage.getDirectory();
        async function walk(dirHandle, path) {
          for await (const entry of dirHandle.values()) {
            const fullPath = path ? `${path}/${entry.name}` : entry.name;
            if (!isAllowed("opfs", fullPath, opts)) continue;
            if (entry.kind === "file") {
              logger(`Archiving OPFS: ${fullPath}`);
              const file = await entry.getFile();
              await tar.writeStream(
                `opfs/${fullPath}`,
                file.size,
                file.stream()
              );
            } else if (entry.kind === "directory") {
              await walk(entry, fullPath);
            }
          }
        }
        await walk(root, "");
      }

      await tar.close();
      if (downloadUrl) {
        const a = document.createElement("a");
        a.href = downloadUrl;
        a.download = opts.password
          ? `${opts.fileName}.enc`
          : `${opts.fileName}.tar.gz`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
      }
      logger("Export complete!", "ok");
    } catch (e) {
      logger("Export error: " + e.message, "err");
      console.error(e);
      try {
        await targetStream.abort(e);
      } catch (z) {}
    }
  }

  async function importData(file, config = {}) {
    const CBOR = window.CBOR;
    const opts = { ...config };
    const logger = opts.logger || console.log;
    const dbCache = {};
    const rootOpfs = await navigator.storage.getDirectory();

    try {
      logger("Analyzing file...");

      // Header Probe for Encryption vs GZIP vs Plain
      const probe = new Uint8Array(await file.slice(0, 8).arrayBuffer());
      const sig = DEC.decode(probe.slice(0, 6));

      let inputStream;

      if (sig === "LE_ENC") {
        const password = prompt("Enter Password:");
        if (!password) throw new Error("Password required");
        inputStream = new DecryptionSource(file.stream(), password).readable();
        // Encrypted stream is always GZIP inside
        inputStream = inputStream.pipeThrough(new DecompressionStream("gzip"));
      } else if (probe[0] === 0x1f && probe[1] === 0x8b) {
        // Standard GZIP signature
        inputStream = file
          .stream()
          .pipeThrough(new DecompressionStream("gzip"));
      } else {
        // Plain TAR (uncompressed)
        inputStream = file.stream();
      }

      const reader = inputStream.getReader();
      let buffer = new Uint8Array(0);
      let done = false;

      async function ensure(n) {
        while (buffer.length < n && !done) {
          const { value, done: d } = await reader.read();
          if (d) done = true;
          else {
            const t = new Uint8Array(buffer.length + value.length);
            t.set(buffer);
            t.set(value, buffer.length);
            buffer = t;
          }
        }
        return buffer.length >= n;
      }
      function consume(n) {
        const v = buffer.slice(0, n);
        buffer = buffer.slice(n);
        return v;
      }
      async function streamToFile(writable, bytes) {
        let remaining = bytes;
        const writer = writable.getWriter();
        if (buffer.length > 0) {
          const toWrite = Math.min(buffer.length, remaining);
          await writer.write(buffer.slice(0, toWrite));
          buffer = buffer.slice(toWrite);
          remaining -= toWrite;
        }
        while (remaining > 0) {
          const { value, done: d } = await reader.read();
          if (d) {
            done = true;
            break;
          }
          if (value.length <= remaining) {
            await writer.write(value);
            remaining -= value.length;
          } else {
            await writer.write(value.slice(0, remaining));
            buffer = value.slice(remaining);
            remaining = 0;
          }
        }
        await writer.close();
      }
      async function readToMemory(bytes) {
        if (!(await ensure(bytes)))
          throw new Error("Unexpected EOF in system file");
        return consume(bytes);
      }
      async function skipBytes(bytes) {
        let remaining = bytes;
        while (remaining > 0) {
          if (buffer.length > 0) {
            const take = Math.min(buffer.length, remaining);
            buffer = buffer.slice(take);
            remaining -= take;
          } else {
            const { value, done: d } = await reader.read();
            if (d) {
              done = true;
              break;
            }
            if (value.length <= remaining) remaining -= value.length;
            else {
              buffer = value.slice(remaining);
              remaining = 0;
            }
          }
        }
      }

      logger("Restoring data...");

      while (true) {
        if (!(await ensure(512))) break;
        const header = consume(512);
        if (header.every((b) => b === 0)) break;

        let name = DEC.decode(header.slice(0, 100)).replace(/\0.*/g, "");
        const prefix = DEC.decode(header.slice(345, 500)).replace(/\0.*/g, "");
        if (prefix) name = `${prefix}/${name}`;
        const size = parseInt(DEC.decode(header.slice(124, 136)).trim(), 8);
        if (isNaN(size)) break;
        const padding = (512 - (size % 512)) % 512;

        if (size === 0) {
          await skipBytes(padding);
          continue;
        }

        if (name.startsWith("data/")) {
          const d = await readToMemory(size);
          if (name === "data/ls.json")
            Object.assign(localStorage, JSON.parse(DEC.decode(d)));
          else if (name === "data/ss.json") {
            const s = JSON.parse(DEC.decode(d));
            for (const k in s) sessionStorage.setItem(k, s[k]);
          } else if (name === "data/cookies.json") {
            const c = JSON.parse(DEC.decode(d));
            for (const k in c)
              document.cookie = `${k}=${c[k]}; path=/; max-age=31536000`;
          } else if (name.startsWith("data/custom/") && opts.onCustomItem)
            await opts.onCustomItem(name.replace("data/custom/", ""), d);
          else if (name.startsWith("data/idb/") && CBOR && opts.idb !== false) {
            const parts = name.split("/");
            const dbName = parts[2];
            if (name.endsWith("schema.cbor")) {
              const schema = CBOR.decode(d);
              if (dbCache[dbName]) dbCache[dbName].close();
              await new Promise((resolve) => {
                const q = indexedDB.deleteDatabase(schema.name);
                q.onsuccess = resolve;
                q.onerror = resolve; // Ignore error to try continue
                q.onblocked = () => {
                  console.warn(
                    `IDB ${schema.name} is blocked. You can try closing other tabs or stopping other scripts that are also accessing this database.`
                  );
                  resolve();
                };
              });
              await new Promise((res, rej) => {
                const req = indexedDB.open(schema.name, schema.version);
                req.onupgradeneeded = (e) => {
                  const db = e.target.result;
                  schema.stores.forEach((s) => {
                    if (!db.objectStoreNames.contains(s.name)) {
                      const st = db.createObjectStore(s.name, {
                        keyPath: s.keyPath,
                        autoIncrement: s.autoIncrement,
                      });
                      s.indexes.forEach((i) =>
                        st.createIndex(i.name, i.keyPath, {
                          unique: i.unique,
                          multiEntry: i.multiEntry,
                        })
                      );
                    }
                  });
                };
                req.onsuccess = (e) => {
                  e.target.result.close();
                  res(e.target.result);
                };
                req.onerror = rej;
              });
            } else {
              // Data Entry
              const storeName = parts[3];
              const records = restoreFromCBOR(CBOR.decode(d));
              if (!dbCache[dbName]) {
                dbCache[dbName] = await new Promise((res, rej) => {
                  const r = indexedDB.open(dbName);
                  r.onsuccess = () => res(r.result);
                  r.onerror = rej;
                });
              }
              const tx = dbCache[dbName].transaction(storeName, "readwrite");
              const st = tx.objectStore(storeName);
              records.forEach((r) => st.put(r.v, st.keyPath ? undefined : r.k));
            }
          }
        } else {
          if (opts.opfs !== false) {
            const cleanName = name.startsWith("opfs/")
              ? name.replace("opfs/", "")
              : name;
            logger(`Restoring: ${cleanName}`);
            const parts = cleanName.split("/");
            const fname = parts.pop();
            let dir = rootOpfs;
            for (const p of parts)
              dir = await dir.getDirectoryHandle(p, { create: true });
            const fh = await dir.getFileHandle(fname, { create: true });
            await streamToFile(await fh.createWritable(), size);
          } else {
            await skipBytes(size);
          }
        }
        await skipBytes(padding);
      }

      Object.values(dbCache).forEach((db) => db.close());
      logger("Import complete!", "ok");
    } catch (e) {
      logger("Error: " + e.message, "err");
      console.error(e);
    }
  }

  window.LittleExport = { importData, exportData, deriveKey };
})();
