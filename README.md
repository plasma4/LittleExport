# LittleExport
A tiny, customizable JS tool that scrapes specified client-side storage types and keys and converts it to a readable `.tar.gz` file, designed for complex apps like Unity and used in [RuntimeFS](https://github.com/plasma4/RuntimeFS). Supports:
- Cookies
- localStorage
- IndexedDB
- OPFS
- Cache Storage
- Session Storage

LittleExport uses streaming when available, and includes URL-Keyed Persistence prevention instructions below. You can also run a JS bookmarklet or paste LittleExport (in `main.js`) into inspector to export data from it as well.

## Usage and building
Use `little-export.min.js`. To build the minified code, use [JSCompress](https://jscompress.com/) (which uses `UglifyJS` 3 and `babel-minify`).

Example usage:
```js
// All object properties are optional. All boolean properties are assumed to be true if not specified.
await LittleExport.export({
    "download": true, // Whether to directly download to the device or not. If false, streaming will not occur and a blob will always be created instead; use in conjunction with onsuccess.
    "password": "my-password", // Optional. If included, the file export type will be .enc instead of .tar.gz.
    // What to export
    "cookies": true,
    "localStorage": true,
    "idb": true,
    "opfs": true,
    "cache": true,
    "session": true,
    "include": {
        "localStorage": ["key1", "key2"],
        "opfs": ["Content"],
        "idb": ["/idbfs", "test"]
    },
    "exclude": {
        // Same as "include" (see above), but acts as a blacklist instead of a whitelist
    },
    "dbFilter": (dbName) => dbName !== "InternalDB" // Function to filter IndexedDB databases

    "customItems": [
        { path: "config.json", data: { theme: "dark", user: "123" } }, // Objects are auto-converted to JSON
        { path: "notes.txt", data: "Hello World" },                    // Strings are saved as text files
        { path: "profile.png", data: blobObj }                         // Blobs are streamed directly
    ],

    // Functions
    "onerror": (err) => console.error("Export failed:", err),
    "onsuccess": (blobUrl) => {
        // Only called if download: false.
        // Use this to manually trigger a download or upload the blob elsewhere.
        console.log("Blob created:", blobUrl);
    }
    "logger": console.log // A function for logging. By default, an empty function is used.
})

await LittleExport.import({
    "source": "URL", // Supports blob, HTTPS link, or file system handle [?].

    // What to import/restore, if included in the .tar.gz file. All default to true.
    "cookies": true,
    "localStorage": true,
    "idb": true,
    "opfs": true,
    "cache": true,
    "session": true,
    "include": {
        "localStorage": ["key1", "key2"], // Similar to export, see other function
    },
    "exclude": {
        // Same as "include" (see above), but acts as a blacklist instead of a whitelist
    }

    // Functions
    "onerror": function () {
        // If the import fails (such as due to IndexedDB locks).
    },

    "logger": console.log, // A function for logging. By default, an empty function is used.
    "onCustomItem": async (path, data) => {
        if (path === "meta.json") { // Do custom stuff with custom data
            const str = new TextDecoder().decode(data);
            console.log(JSON.parse(str));
        }
    }
})
```

## URL Persistence & Location Spoofing
URL Persistence is an informal term that means that websites store data along with URLs. Examples include the Ruffle emulator (in `localStorage`) and Unity (in `IndexedDB`). If you export data from `example.com/v1/` and try to import it to `example.com/v2/` (or to different domains), it probably won't work.

Because of this problem, you must normalize these URL keys during exporting or importing with a mock location object (and replace `document.URL` if needed). For standardization reasons, you should make this website `https://example.com/` whenever possible (see section below for more detail).

### Basic Location Mocking
Use something like this:

```js
(function(url) {
    const internal = new URL(url);

    window.__mockLocation = {
        // Properties redirect to the internal URL object
        get href() { return internal.href; },
        set href(v) { this.assign(v); },
        get origin() { return internal.origin; },
        get protocol() { return internal.protocol; },
        get host() { return internal.host; },
        get hostname() { return internal.hostname; },
        get port() { return internal.port; },
        get pathname() { return internal.pathname; },
        get search() { return internal.search; },
        get hash() { return internal.hash; },
        
        assign: function(url) {
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
        replace: function(url) {
            const dest = new URL(url, internal.href);
            if (dest.origin === internal.origin) {
                internal.href = dest.href;
                console.log(`[Virtual Replace] ${dest.href}`);
            } else {
                window.location.replace(dest.href);
            }
        },
        reload: function() {
            console.log("[Virtual Reload]");
        },
        toString: function() { return internal.href; }
    };

    Object.defineProperty(window.__mockLocation, "hash", {
        get: () => internal.hash,
        set: (v) => {
            const oldURL = internal.href;
            internal.hash = v;
            const newURL = internal.href;
            window.dispatchEvent(new HashChangeEvent("hashchange", { oldURL, newURL }));
        }
    });
})("https://example.com/");
// Usage in RuntimeFS (similar regexes apply elsewhere, file types may need adjustment):
// *.js $$ window.location -> window.__mockLocation
// main.js $$ document.URL -> window.__mockLocation.href
// You can either inject this into your HTML file or through other methods.

// In rarer cases, applications will not use window.location, instead opting for using the location object directly, or even checking against the Location object. This will require case-by-case handling.
```

Be aware of the existence of `document.URL` (which returns the same as `location.href`).

In order to do this, it is necessary to modify code beforehand, use a proxy which dynamically replaces code, or something like RuntimeFS.

Thanks to [Scramjet's proxy code](https://github.com/MercuryWorkshop/scramjet/blob/main/src/client/location.ts) for inspiring this.

## Standardization
LittleExport aims to be the standard for full web data export. It uses 600,000 iterations for encryption using **PBKDF2 (SHA-256)** to derive a 256-bit key for **AES-GCM** encryption.

The file format specification is as follows:
1.  **Archive Format:** GZIP-compressed USTAR `.tar` (typically `.tar.gz`).
2.  **Encryption (Archive):** If enabled, file starts with signature `LE_ENC` (UTF-8) + `Salt` (16 bytes) + `AES-GCM Stream` (PBKDF2 SHA-256 derived key).
3.  **Directory Structure:**
    *   `/`: Raw files (mapped to OPFS).
    *   `data/`: Metadata.
        *   `ls.json`, `ss.json`, `cookies.json`: Storage dumps.
        *   `idb/<db>/<store>/`: CBOR encoded records.
    *   `opfs/`: Explicit OPFS mapping.
4.  **URL Persistence:** Importing tools **SHOULD** shim `window.location` to `https://example.com/` (with `pathname` as `/`) to prevent data loss across domains, unless a consistently accessible and used custom location is used instead.

## Limitations
- URL Persistence **MUST** be done by modifying the code beforehand or dynamically modifying source code with regexes (see RuntimeFS for an example).
- LittleExport is more likely to crash when streaming is not supported (no `showSaveFilePicker` support), but should be able to handle a few hundred MB of data in all browsers. All other features should have Baseline support.
- Crashes may occur with extremely large individual Blobs in IndexedDB.
- LittleExport is not fully/always ACID compliant if IndexedDB.
- Importing data effectively gives the backup file root access to your application's state, and may even control caches. Be careful!

## Future
In the future, LittleExport might include:
- More granular control for what to export
- More performance improvements
- StreamSaver support to allow GBs of export in non-Chromium browsers, and better memory handling with Blobs
- UI for reading or customizing export data (potentially beyond the scope of this project)

Give this repo a star if you're interested! :)