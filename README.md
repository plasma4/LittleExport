# LittleExport

A tiny, customizable JS tool that scrapes specified client-side storage types and keys and converts it to a readable `.tar.gz` file, designed for complex apps like Unity and used in [RuntimeFS](https://github.com/plasma4/RuntimeFS). Compressed file size is under 100KB! Supports:

- Cookies
- localStorage
- IndexedDB
- OPFS
- Cache Storage
- Session Storage

LittleExport uses streaming when available, and includes URL-Keyed Persistence prevention instructions below. LittleExport supports granular export/import options and `async`, allowing advanced checks to only export certain DBs or files in OPFS, for example (see the Modes section). To support various data types (such as for IndexedDB), the `cbor-x` library is used. You can also run a JS bookmarklet or paste LittleExport (in `main.js`) into an inspector to export data from an external application as well.

LittleExport requires ES11 or later (supported by over 95% of all browsers). Note that a reload may be necessary after importing to fix issues with a website.

## Usage and Building

Use `little-export.min.js`. To build the minified code, use [JSCompress](https://jscompress.com/) (which uses `UglifyJS` 3 and `babel-minify`).

Example usage:

```js
// All object properties are optional. All boolean properties are assumed to be true if not specified. Note: any boolean that is !== false is considered "true" by LittleExport.
await LittleExport.exportData({
  download: true, // Whether to directly download to the device or not. If false, streaming will not occur and a blob will be returned if successful. The blob's object URL will not be revoked, so make sure to call URL.revokeObjectURL once complete.
  password: "my-password", // Optional. If included, the file export type will be .enc instead of .tar.gz.
  graceful: true, // Gracefully handles ALL errors by calling onerror instead of actually erroring. Note that onerror will still produce errors for issues such as IndexedDB locking, but will continue execution.
  fileName: "a", // Turns into a.tar.gz/a.enc (depending if password is provided or not), unless a "." character is in the file name already.
  cborExtensionName: "cbor", // Defaults to cbor but can be customized if you exported with a custom extension name.

  // What to export (keep in mind not specifying a property will make it be considered as true)
  cookies: true,
  localStorage: true,
  idb: true,
  opfs: true,
  cache: true,
  sessionStorage: true,
  logSpeed: 100, // Defaults to 100; meant for UI logging.
  include: {
    // Supports: localStorage, session, cookies, opfs, idb, cache
    localStorage: ["settings", "user_"], // Matches "user_" but NOT "user_name"

    // For the Origin Private File System: the path argument is the relative file path, such as "Logs/2023/error.txt"
    opfs: (path) => {
      // Only export files inside a "Saves" folder
      // Note: Filtering a folder automatically includes/excludes all its children!
      return path.startsWith("Saves/");
    },

    // IndexedDB
    // The path argument is the logical name of the DB/store, such as "DatabaseName" OR "DatabaseName/StoreName"
    idb: (path) => {
      if (path === "MyDB") return true;
      // If the DB is allowed, the function is called again for every Object Store.
      // The format is "DB/Store".

      // Example: Exclude the "Cache" store in "MyGameDB"
      if (path === "MyGameDB/Cache") return false;

      // Note how slashes are preserved
      if (path === "/idbfs") return true; // Allow the Emscripten DB
      if (path.startsWith("/idbfs/")) return true; // Allow all its stores

      return false;
    },
  },
  exclude: {
    // Same options as "include" (see above), but acts as a blacklist instead of a whitelist
  },
  encoder: new CBOR.Encoder(), // You'll want to adjust this with documentation from https://github.com/kriszyp/cbor-x/. Please also check the default CBOR.Encoder/Decoder in LittleExport settings; this is because disabling things like structuredClone/messing with certain settings might result in problems. You can provide an entirely separate encoder/decoder function if you wish (such as the unsafeObjectToReadableJS function).
  /* "cborOptions": { "bundleStrings": false } // A simpler way to customize/override encoder settings if you don't specify and need a custom encoder function. */

  customItems: [
    { path: "config.json", data: { theme: "dark", user: "123" } }, // Objects are auto-converted to JSON
    { path: "notes.txt", data: "Hello World" }, // Strings are saved as text files
    { path: "profile.png", data: blobObj }, // Blobs are streamed directly
  ],

  onerror: function (err) {
    // If the import fails (such as due to IndexedDB locks). In some cases, onerror will be called while execution continues such as IndexedDB locking; set graceful to false to prevent this.
  },
  logger: console.log, // A function for logging (exactly 1 string will always be passed in). By default, an empty function is used. It's advised to NOT use the DevTools logger as upwards of 10 logs/second can consistently be created; updating an HTML element instead is probably a better approach.
});

// All properties are optional. Boolean properties are also assumed to be true if the value is !== false with importing.
await LittleExport.importData({
  source: "URL", // Supports blob, HTTPS link, or object with a .stream() method (such as a File). Note you'll need to make sure to add https:// to the start and fully format the link. If no source is provided, LittleExport will prompt for a file.
  fetchInit: {}, // What to pass to the second argument of fetch() (optional, only used if source is a URL).
  password: "my-password", // If not included, a prompt() will be generated if the file is encrypted. Set password to null to error without prompting instead.
  graceful: true, // Gracefully handles ALL errors by calling onerror instead of actually erroring. Note that onerror will still produce errors for issues such as IndexedDB locking, but will continue execution.
  verifyFile: true, // Set to false to ignore checksum problems and EOF checks.

  // What to import/restore, if included in the .tar.gz file. All default to true.
  cookies: true,
  localStorage: true,
  idb: true,
  opfs: true,
  cache: true,
  sessionStorage: true,
  logSpeed: 100, // Defaults to 100; meant for UI logging. For importing, this also acts as the minimum amount of time between UI updates.
  include: {
    localStorage: ["key1", "key2"], // Same as exportData, see function above for more.
  },
  exclude: {
    // Same as "include", but acts as a blacklist instead of a whitelist
  },
  decoder: new CBOR.Decoder(), // See function above for more details (in the "encoder" section).
  /* "cborOptions": { "bundleStrings": false } // A simpler way to customize/override encoder settings if you don't specify and need a custom encoder function. */

  onerror: function () {
    // If the import fails (such as due to IndexedDB locks). In some cases, onerror will be called while execution continues such as IndexedDB locking; set graceful to false to prevent this.
  },

  logger: console.log, // A function for logging. By default, an empty function is used.
  onCustomItem: async (path, data) => {
    if (path === "meta.json") {
      // Do custom stuff with custom data (Uint8Array).
      const str = new TextDecoder().decode(data);
      console.log(JSON.parse(str));
    }
  },
});

LittleExport.importFromFolder({
  // All the same arguments as .importData except for "source" (LittleExport will automatically ask the user for a folder.) Check code for more argument options.
});

// Clear data. Defaults to clearing everything if an empty object or no argument is provided. (If you need a more granular method for deleting data, it's best to implement it yourself.)
// For clearing data specifically, booleans are considered booleans if they are truthy, not !== false.
await LittleExport.clearData({
  opfs: true,
  idb: true,
  localStorage: true,
  sessionStorage: true,
  cookies: true, // Note that cookie logic is not guaranteed to clear all custom paths. Check the logic in the code and use a custom implementation if necessary.
  cache: true,
});

LittleExport.warn = (text, error) => {}; // You can provide a custom warn function; this defaults to console.warn if not set. There will sometimes be an additional second argument that provides the error object.
```

## Modes

LittleExport supports two modes for importing/exporting:

- **Simple**: Use include and exclude with arrays or simple functions.
- **Recursive Crawling**: Use onVisit for high-performance, granular control with bitwise flags and live handles.

If an `onVisit` function is passed then recursive crawling will be used; simple is the default. The `include`/`exclude` parameters will be ignored with recursive crawling.

Recursive crawling requires an `onVisit` function that returns one of four possible values: `SKIP`, `PROCESS`, `TRUST`, and `ABORT`. `SKIP` means to not process an item (and its children if necessary), `PROCESS` processes the current item, `TRUST` processes the current item and everything inside it, while `ABORT` immediately aborts. The `onVisit` function can also return a promise to be async; if a promise is returned then an `await` is created. For example, it is possible to `TRUST` localStorage but add more granular options for `OPFS`.

Usage of the `await` feature can allow you to "query" the user live on if something shold be exported! Also, `onVisit` is called _before_ any exporting happens, making it possible to modify values right before being exported, or even destroy data before `SKIP`ping.

```js
// An example is worth a thousand words!
const { TYPE, DECISION } = LittleExport;

// onVisit acts the same with importData. Note that LittleExport attempts to minimize the amount of calls to onVisit; this means it will entirely skip asking for a category if importData's file doesn't include any data for said category.
await LittleExport.exportData({
  // ... include other arguments if needed such as download, password, etc.
  // Note how the onVisit function isn't async, see the comment for askUser later.
  onVisit: (type, path, meta) => {
    let DECISION = LittleExport.DECISION;
    // Possible types: OPFS (1), IDB (2), LS (4), SS (8), COOKIE (16), CACHE (32)
    if (userAborted) {
      return DECISION.ABORT; // Immediately stop exporting and clean-up. Note that onerror is not called if LittleExport is aborted by the return of ABORT. The type order in the comment above represents what order categories will be exported in, if that detail matters.
    }

    // LittleExport won't continue until either onVisit returns or the promise returned from onVisit resolves. This means you can do such tomfoolery like modifying values before exporting or prompting a user.
    if (type === TYPE.LS) {
      // On the first call to onVisit for a category, no path/meta is provided because it's asking if anything from the whole category should be considered.
      // Note that LS, SS, and COOKIES export a single array element for the path, such as ["key"].
      return DECISION.TRUST;
    } else if (type === TYPE.OPFS) {
      if (!path) {
        // Allow processing of the whole OPFS category
        return DECISION.PROCESS;
      }
      if (path[0] === "Assets") {
        return DECISION.TRUST; // Allow Assets/... folder through, including the files inside ending in .tmp
      }
      // Don't allow Content/Cache through
      if (path[0] === "Content" && path[1] === "Cache") return DECISION.SKIP;
      // If file ends with .tmp, skip!
      if (path[path.length - 1].endsWith(".tmp")) return DECISION.SKIP;
      // Keep going, allow everything elee through
      return DECISION.PROCESS;
    } else if (type & (TYPE.SS | TYPE.CACHE | TYPE.COOKIE)) {
      // If any of those types are requested, just skip entirely.
      // & and | act as bit flags; you can use either equality checking or bit flags as you wish.
      return DECISION.SKIP;
    }
    // At this point the type has to be either OPFS/IDB.

    if (type === TYPE.IDB) {
      if (path.length === 1) {
        const dbName = path[0];
        // If it's a heavy DB, ask the user.
        if (dbName === "/idbfs" || meta.database.objectStoreNames.length > 50) {
          // Note the specific lack of async in the function. This is for performance reasons; it's not advised to make onVisit async normally as this requires LittleExport to await every individual visit.
          // The actual performance penalty varies but will be most significant when you have a lot of different possible "keys" (like in localStorage/IDB), or a lot of OPFS files. If you're asking the user every single time, then it's probably fine to make the function async.
          return askUser(
            `Export DB ${dbName}?`,
            DECISION.PROCESS, // Examine the specific DB stores (below)
            DECISION.SKIP,
          );
        }
        // For other DBs, just trust them and everything inside.
        return DECISION.TRUST;
      }

      // Store-level check (Only reached if DB check returned PROCESS)
      if (path.length === 2) {
        const [dbName, storeName] = path;
        return storeName.toLowerCase().includes("cache") ||
          storeName.includes("temp")
          ? DECISION.SKIP
          : DECISION.TRUST;
      }

      // path.length won't ever go past 2 for IndexedDB.
    }

    return DECISION.PROCESS; // Allow (a default value must be returned)
    // You'd want to make sure to minimize the amount of .PROCESS returned (using TRUST/SKIP as early as possible) for optimal performance.
  },
});

// Returns a promise after prompting the user.
function askUser(what, yesCase, noCase) {
  // Note that returning a Promise does incur a small performance penalty but it is usually better than making the onVisit function async and creating a microtask every time instead of just when a prompt is necessary.
  return new Promise((resolve) => {
    // In practice you would probably want to use a custom menu.
    if (prompt(what)) {
      resolve(yesCase);
    } else {
      resolve(noCase);
    }
  });
}
```

## URL Persistence & Location Spoofing

URL Persistence is an informal term that means that websites/tools often identify data by URLs. Examples include the Ruffle emulator (in `localStorage`) and Unity (in binary `IndexedDB`), with varying levels of modification difficulty after set in stone. The use of LittleExport is intended to work across domains to make data more resilient, so it's advised to avoid this.

If you export data from `example.com/v1/` and try to import it to `example.com/v2/` (or to different domains), it probably won't work.

Because of this problem, you must normalize these URL keys during exporting or importing with a mock location object (and replace `document.URL` if needed), unless you are using a rewriter like Scramjet that can consistently produce the same faked URL. For standardization reasons, you should make this website `https://example.com/` whenever possible (see section below for more detail).

### Basic Location Mocking

Use something like this:

```js
(function (url) {
  const internal = new URL(url);

  window.__mockLocation = {
    // Properties redirect to the internal URL object
    get href() {
      return internal.href;
    },
    set href(v) {
      this.assign(v);
    },
    get origin() {
      return internal.origin;
    },
    get protocol() {
      return internal.protocol;
    },
    get host() {
      return internal.host;
    },
    get hostname() {
      return internal.hostname;
    },
    get port() {
      return internal.port;
    },
    get pathname() {
      return internal.pathname;
    },
    get search() {
      return internal.search;
    },
    get hash() {
      return internal.hash;
    },

    assign: function (url) {
      const dest = new URL(url, internal.href);
      if (dest.origin === internal.origin) {
        // Update state without reloading
        internal.href = dest.href;
        console.log(`[Virtual Nav] ${dest.href}`);
      } else {
        console.log(`[External Nav] ${dest.href}`);
        window.location.assign(dest.href);
      }
    },
    replace: function (url) {
      const dest = new URL(url, internal.href);
      if (dest.origin === internal.origin) {
        internal.href = dest.href;
        console.log(`[Virtual Replace] ${dest.href}`);
      } else {
        window.location.replace(dest.href);
      }
    },
    reload: function () {
      console.log("[Virtual Reload]");
      // you can reload here if you want
    },
    toString: function () {
      return internal.href;
    },
  };

  Object.defineProperty(window.__mockLocation, "hash", {
    get: () => internal.hash,
    set: (v) => {
      const oldURL = internal.href;
      internal.hash = v;
      const newURL = internal.href;
      window.dispatchEvent(
        new HashChangeEvent("hashchange", { oldURL, newURL }),
      );
    },
  });
})("https://example.com/"); // Change the URL to follow standardization!
// Usage in RuntimeFS (similar regexes apply elsewhere, file types may need adjustment):
// *.js $$ window.location -> window.__mockLocation
// main.js $$ document.URL -> window.__mockLocation.href
// You can inject the JS to the HTML with something like index.html $ {{SCRIPT}} -> [compressed version of code above]

// In rarer cases, applications will not use window.location, instead opting for using the location object directly, or even checking against the Location object. This will require case-by-case handling.
```

Be aware of the existence of `document.URL` (which returns the same as `location.href`).

In order to do this, it is necessary to modify code beforehand, use a proxy which dynamically replaces code, or something like RuntimeFS.

Thanks to [Scramjet's proxy code](https://github.com/MercuryWorkshop/scramjet/blob/main/src/client/location.ts) for inspiring this.

## Standardization

LittleExport aims to be the standard for full web data export.

The file format specification is as follows:

1.  **Archive Format:** GZIP-compressed POSIX.1-2001 (PAX) / USTAR.
    - **PaxHeaders:** `PaxHeaders` files or folder names will be ignored. (Normal invisible files that start with a `.` will not.)
    - **Import Requirement:** Importers MUST support the PAX `x` type flag (ASCII 120) to correctly handle filenames longer than 255 bytes and files larger than ~8.5GB.

2.  **Encryption (Optional):** LittleExport uses 600,000 iterations for encryption using **PBKDF2** (SHA-256) to derive a 256-bit key for AES-GCM encryption if a password (of truthy value) is provided. If enabled, the file starts with:
    - `LE_ENC` signature (6 bytes, UTF-8)
    - `Salt` (16 bytes, random)
    - `Verification Block`: An encrypted empty chunk used for password verification
    - `Encrypted Data Stream`: The GZIP-compressed tar data

    **Chunk Format:** Each encrypted chunk consists of:
    - `IV` (12 bytes, random per chunk)
    - `Length` (4 bytes, UInt32LE, size of ciphertext)
    - `Ciphertext` (variable, AES-GCM encrypted data with 16-byte auth tag)

    Default chunk size is hard-coded to 4MB before encryption.

3.  **Directory Structure:**
    - `opfs/`: Origin Private File System files and directories
    - `data/`: Metadata and structured storage
      - `ls.json`: localStorage key-value dump
      - `ss.json`: sessionStorage key-value dump
      - `cookies.json`: Cookie key-value dump
      - `custom/`: User-defined custom items
      - `blobs/`: Externalized Blob objects from IndexedDB
      - `idb/<db>/schema.cbor`: Database schema (version, object stores, indexes)
      - `idb/<db>/<store>/<chunk>.cbor`: CBOR-encoded records in batches
      - `cache/<cacheName>/<hash>.cbor`: Cache Storage entries with metadata

4.  **IndexedDB Blob Handling:**
    - `Blob` objects in IndexedDB are stored separately in `data/blobs/<uuid>` to prevent RAM exhaustion
    - Inside CBOR records, Blobs are replaced with reference objects:
      ```json
      {"__le_blob_ref": "<uuid>", "type": "<mime_type>", "size": <bytes>}
      ```
    - **Import Requirement:** Importers MUST extract `data/blobs/` to temporary storage (e.g., `.rfs_temp_blobs` in OPFS) before processing IDB records, then clean up after import completes

5.  **CBOR Encoding:** IndexedDB records and Cache entries use CBOR for type preservation. See the section below for differences.

6.  **Cache Storage Format:** Each cached response is stored as CBOR with:

    ```js
    {
      meta: { url, status, headers, type },
      data: Uint8Array
    }
    ```

7.  **URL Persistence:** Importing tools SHOULD shim `window.location` to `https://example.com/` (with `pathname` as `/`) to prevent data loss across domains, unless a consistently accessible custom location is used instead.

8.  **Path Encoding:** Database names, store names, and cache names are URL-encoded in file paths using `encodeURIComponent()`.

## Standardization Differences in CBOR

LittleExport uses a custom implementation of CBOR that can handle circular references, `Blobs`, and sparse arrays, along with the base `cbor-x` library. `cbor-x` itself has a few specific handling edge cases such as replacing `__proto__` with `__proto_` for security reasons.

LittleExport exposes `prepForCBOR`/`restoreFromCBOR` to let you modify these with custom functions as necessary.

You can also specify a custom encoder/decoder (see more details in the Usage and Building section), or even try `unsafeObjectToReadableJS` in objectToReadable.js for custom encoding.

## Limitations

- URL Persistence **MUST** be done by modifying the code beforehand or dynamically modifying source code with regexes (see RuntimeFS for an example).
- LittleExport is more likely to crash when streaming is not supported (no `showSaveFilePicker` support), but should be able to handle a few hundred MB of data in all browsers. All other features should have Baseline support. In the future, non-Chromium browsers might adopt parts of the File System API that allow for streamed exports.
- LittleExport is not fully/always ACID compliant. Ideally, stop anything that could influence export results before using the tool.
- Cookies do not store timestamp; they only store the `key=value` part, so metadata like `path` is ignored. `HttpOnly` cookies cannot be exported.
- LittleExport should be able to handle export sizes well above 5-10GB given enough streaming and memory; however, storing extremely object/string data like single IndexedDB records without using a `Blob` may cause issues. You can use a cbor-x `decoder` object when decoding, and customize its limits through `decoder.setSizeLimits()`, to try to prevent these problems; see [here](https://github.com/kriszyp/cbor-x/) for CBOR documentation.
- Not having enough memory on-device will result in a `QuotaExceededError`.
- Importing data effectively gives the backup file root access to your application's state, and may even control caches. Be careful!

## Future

In the future, LittleExport might include:

- StreamSaver support to allow GBs of export in non-Chromium browsers
- UI for reading or customizing export data (potentially beyond the scope of this project)

Give this repo a star if you're interested! :)
