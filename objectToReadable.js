// Meant as a testing replacement for .cbor to instead get human-readable JS data. You may want to use something more battle-tested instead, like https://github.com/yahoo/serialize-javascript. (Note that serialize-javascript doesn't support things like binary data, blobs, or circular references.)
/**
 * Serializes an object into a string of executable JavaScript (IIFE).
 * Handles circular references, sparse arrays, and typed arrays. (Works on `globalThis`!) May have security issues when the result is eval-ed; meant for readability and not necessarily robust.
 */
async function unsafeObjectToReadableJS(obj, variablePrefix = "r") {
  const MAX_INLINE_DEPTH = 200;
  const counts = new Map();
  const idMap = new Map();
  const blobs = new Map();

  // Queue for iterative population to avoid stack overflow
  const populationQueue = [];

  // detect native code
  const knownGlobals = new Map();
  const ignoreList = new Set([
    "window",
    "self",
    "globalThis",
    "frames",
    "parent",
    "top",
  ]);

  try {
    const descriptors = Object.getOwnPropertyDescriptors(globalThis);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string" || ignoreList.has(key)) continue;
      if (descriptors[key].enumerable) continue;

      // Wrap in try-catch because accessing .value on some descriptors
      // (like 'external' in older IE/Edge or specific host objects) can throw.
      try {
        if ("value" in descriptors[key]) {
          const val = descriptors[key].value;
          if (
            typeof val === "function" ||
            (typeof val === "object" && val !== null)
          ) {
            if (!knownGlobals.has(val)) knownGlobals.set(val, key);
          }
        }
      } catch (e) {}
    }
  } catch (e) {}

  const knownSymbols = new Map();
  try {
    for (const key of Reflect.ownKeys(Symbol)) {
      if (typeof Symbol[key] === "symbol") {
        knownSymbols.set(Symbol[key], `Symbol.${key}`);
      }
    }
  } catch (e) {}

  const declarations = [];
  const updates = [];
  let refCounter = 0;

  const getTypeTag = (v) => Object.prototype.toString.call(v);
  const isReferenceType = (v) =>
    v !== null &&
    (typeof v === "object" || typeof v === "function" || typeof v === "symbol");

  const bufferToBase64 = (buffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const len = bytes.byteLength;
    const chunkSize = 0x8000; // Process in 32KB chunks

    for (let i = 0; i < len; i += chunkSize) {
      binary += String.fromCharCode.apply(
        null,
        bytes.subarray(i, i + chunkSize),
      );
    }
    // btoa is available in modern Node.js and Browsers
    return typeof btoa !== "undefined"
      ? btoa(binary)
      : Buffer.from(binary, "binary").toString("base64");
  };

  const getSymbolExpression = (sym) => {
    if (knownSymbols.has(sym)) return knownSymbols.get(sym);
    if (idMap.has(sym)) return idMap.get(sym);

    const globalKey = Symbol.keyFor(sym);
    if (globalKey) return `Symbol.for(${JSON.stringify(globalKey)})`;

    const desc = sym.description ? JSON.stringify(sym.description) : "";
    return `Symbol(${desc})`;
  };

  // Stack for initial reference counting
  const stack = [obj];
  const blobPromises = [];

  while (stack.length > 0) {
    const curr = stack.pop();
    if (!isReferenceType(curr)) continue;
    if (knownGlobals.has(curr)) continue; // Don't traverse globals

    if (counts.has(curr)) {
      counts.set(curr, counts.get(curr) + 1);
      continue;
    }
    counts.set(curr, 1);

    const tag = getTypeTag(curr);

    if (
      (tag === "[object Blob]" || tag === "[object File]") &&
      !blobs.has(curr)
    ) {
      blobPromises.push(
        (async () => {
          try {
            if (typeof FileReader !== "undefined") {
              // Browser environment
              await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => {
                  blobs.set(curr, reader.result.split(",")[1]);
                  resolve();
                };
                reader.onerror = reject;
                reader.readAsDataURL(curr);
              });
            } else if (typeof curr.arrayBuffer === "function") {
              // Node.js or environment without FileReader
              const buf = await curr.arrayBuffer();
              blobs.set(curr, bufferToBase64(buf));
            }
          } catch (e) {
            blobs.set(curr, ""); // Fallback
          }
        })(),
      );
    }

    try {
      if (Array.isArray(curr)) {
        const keys = Reflect.ownKeys(curr);
        for (const k of keys) {
          if (k !== "length") stack.push(curr[k]);
        }
      } else if (curr instanceof Map) {
        for (const [k, v] of curr) {
          stack.push(v);
          stack.push(k);
        }
      } else if (curr instanceof Set) {
        for (const v of curr) stack.push(v);
      } else if (
        tag === "[object Object]" ||
        (curr && typeof curr === "object")
      ) {
        const keys = Reflect.ownKeys(curr);
        for (const k of keys) {
          try {
            stack.push(curr[k]);
          } catch (e) {}
        }
      } else if (ArrayBuffer.isView(curr)) {
        stack.push(curr.buffer);
      }
    } catch (e) {}
  }

  await Promise.all(blobPromises);

  const getID = (val) => {
    if (idMap.has(val)) return idMap.get(val);
    const id = variablePrefix + refCounter++;
    idMap.set(val, id);
    return id;
  };

  function gen(val, depth) {
    if (val === null) return "null";
    if (val === undefined) return "undefined";
    if (Object.is(val, -0)) return "-0";
    if (Object.is(val, NaN)) return "NaN";
    if (val === Infinity) return "Infinity";
    if (val === -Infinity) return "-Infinity";

    const type = typeof val;
    if (type === "number" || type === "boolean") return String(val);
    if (type === "string") return JSON.stringify(val);
    if (type === "bigint") return `${val}n`;

    const tag = getTypeTag(val);

    if (
      tag === "[object ArrayBuffer]" ||
      tag === "[object SharedArrayBuffer]"
    ) {
      return createVariable(val, tag);
    }

    if (type === "symbol" && (!counts.has(val) || counts.get(val) <= 1)) {
      return getSymbolExpression(val);
    }

    if (knownGlobals.has(val)) return knownGlobals.get(val);
    if (idMap.has(val)) return idMap.get(val);

    const count = counts.get(val) || 0;
    const isShared = count > 1;
    const isTooDeep = depth >= MAX_INLINE_DEPTH;

    const forceVariable =
      isShared ||
      isTooDeep ||
      type === "symbol" ||
      (tag !== "[object Array]" &&
        tag !== "[object Object]" &&
        Object.getPrototypeOf(val) !== null);

    if (forceVariable) return createVariable(val, tag);

    if (Array.isArray(val)) {
      const keys = Reflect.ownKeys(val);
      const isDense =
        keys.length === val.length + 1 &&
        keys.every(
          (k) => k === "length" || (typeof k === "string" && /^\d+$/.test(k)),
        );

      if (!isDense) return createVariable(val, tag);

      const items = val.map((v) => gen(v, depth + 1));
      return `[${items.join(", ")}]`;
    }

    if (tag === "[object Object]" || Object.getPrototypeOf(val) === null) {
      const props = [];
      const keys = Reflect.ownKeys(val);
      for (const k of keys) {
        let keyStr;
        if (typeof k === "symbol") {
          keyStr = `[${getSymbolExpression(k)}]`;
        } else {
          keyStr = JSON.stringify(k);
        }
        // Safely access property for inline generation
        try {
          props.push(`${keyStr}: ${gen(val[k], depth + 1)}`);
        } catch (e) {
          props.push(`${keyStr}: undefined /* access failed */`);
        }
      }
      return Object.getPrototypeOf(val) === null
        ? `Object.assign(Object.create(null), {${props.join(", ")}})`
        : `{ ${props.join(", ")} }`;
    }

    return createVariable(val, tag);
  }

  function createVariable(val, tag) {
    const id = getID(val);
    let expr = "";
    let needsPopulation = false;
    const hasExtraProps =
      tag !== "[object Array]" &&
      tag !== "[object Error]" &&
      tag !== "[object Set]" &&
      tag !== "[object Map]" &&
      Reflect.ownKeys(val).length > 0;

    if (typeof val === "symbol") {
      expr = getSymbolExpression(val);
    } else if (tag === "[object Number]") {
      expr = `new Number(${val.valueOf()})`;
      if (hasExtraProps) needsPopulation = true;
    } else if (tag === "[object String]") {
      expr = `new String(${JSON.stringify(val.valueOf())})`;
      if (hasExtraProps) needsPopulation = true;
    } else if (tag === "[object Boolean]") {
      expr = `new Boolean(${val.valueOf()})`;
      if (hasExtraProps) needsPopulation = true;
    } else if (tag === "[object Error]" || val instanceof Error) {
      let errName = val.name;
      if (!globalThis[errName] || typeof globalThis[errName] !== "function") {
        errName = "Error";
      }
      expr = `new ${errName}(${JSON.stringify(val.message)})`;
      needsPopulation = true;
    } else if (tag === "[object Date]") {
      expr = `new Date(${val.getTime()})`;
      if (hasExtraProps) needsPopulation = true;
    } else if (tag === "[object RegExp]") {
      expr = `new RegExp(${JSON.stringify(val.source)}, "${val.flags}")`;
      needsPopulation = true;
    } else if (tag === "[object Function]") {
      const src = Function.prototype.toString.call(val);
      const isNative = /\{\s*\[native code\]\s*\}\s*$/.test(src);

      expr = isNative
        ? "function() { throw new Error('Serialized Native Code cannot be called'); }"
        : src;
      if (Reflect.ownKeys(val).length > (val.prototype ? 2 : 1)) {
        needsPopulation = true;
      }
    } else if (tag === "[object Blob]" || tag === "[object File]") {
      const mime = val.type || "application/octet-stream";
      const b64 = blobs.get(val) || "";
      expr = `await (await fetch("data:${mime};base64,${b64}")).blob()`;
      if (tag === "[object File]") {
        expr = `new File([${expr}], ${JSON.stringify(val.name)}, { type: "${mime}", lastModified: ${val.lastModified} })`;
      }
    } else if (ArrayBuffer.isView(val)) {
      const typeName = tag.slice(8, -1);
      const bufferID = gen(val.buffer, 0);
      expr = `new ${typeName}(${bufferID}, ${val.byteOffset}, ${val.length})`;
    }
    if (tag === "[object ArrayBuffer]") {
      const b64 = bufferToBase64(val);
      expr = `Uint8Array.from(atob("${b64}"), c => c.charCodeAt(0)).buffer`;
    } else if (Array.isArray(val)) {
      expr = `new Array(${val.length})`;
      needsPopulation = true;
    } else if (tag === "[object Set]") {
      expr = "new Set()";
      needsPopulation = true;
    } else if (tag === "[object Map]") {
      expr = "new Map()";
      needsPopulation = true;
    } else {
      expr = Object.getPrototypeOf(val) === null ? "Object.create(null)" : "{}";
      needsPopulation = true;
    }

    declarations.push(`const ${id} = ${expr};`);

    if (needsPopulation) {
      populationQueue.push({ val, id, tag });
    }
    return id;
  }

  function populate(val, id, tag) {
    const nextDepth = 0;

    if (tag === "[object RegExp]" && val.lastIndex !== 0) {
      updates.push(`${id}.lastIndex = ${val.lastIndex};`);
    }

    // Try-catch for prototype access, as some objects/proxies throw
    let proto = null;
    try {
      proto = Object.getPrototypeOf(val);
    } catch (e) {}

    const isStandardProto =
      proto === Object.prototype ||
      proto === Array.prototype ||
      proto === null ||
      (tag === "[object Error]" && proto === Error.prototype) ||
      (tag === "[object Set]" && proto === Set.prototype) ||
      (tag === "[object Map]" && proto === Map.prototype);

    if (!isStandardProto && typeof val === "object" && proto) {
      updates.push(`Object.setPrototypeOf(${id}, ${gen(proto, nextDepth)});`);
    }

    if (tag === "[object Set]") {
      for (const item of val)
        updates.push(`${id}.add(${gen(item, nextDepth)});`);
    } else if (tag === "[object Map]") {
      for (const [k, v] of val)
        updates.push(`${id}.set(${gen(k, nextDepth)}, ${gen(v, nextDepth)});`);
    }

    const keys = Reflect.ownKeys(val);
    for (const k of keys) {
      if (tag === "[object Array]" && k === "length") continue;
      if (tag === "[object Error]" && (k === "message" || k === "name"))
        continue;
      if (k === "prototype" && tag === "[object Function]") continue;
      let propValue;
      try {
        propValue = val[k];
      } catch (e) {
        continue; // Skip inaccessible properties
      }
      assignProp(id, k, propValue, nextDepth);
    }
  }

  function assignProp(objId, key, value, depth) {
    if (key === "__proto__") {
      updates.push(`Object.setPrototypeOf(${objId}, ${gen(value, depth)});`);
    } else {
      let keyExpr;
      if (typeof key === "symbol") {
        keyExpr = `[${getSymbolExpression(key)}]`;
      } else {
        keyExpr = `[${JSON.stringify(key)}]`;
      }
      updates.push(`${objId}${keyExpr} = ${gen(value, depth)};`);
    }
  }

  const rootResult = gen(obj, 0);
  for (let i = 0; i < populationQueue.length; i++) {
    const task = populationQueue[i];
    populate(task.val, task.id, task.tag);
  }

  return `(async () => {
  ${[declarations.join("\n  "), updates.join("\n  "), `return ${rootResult};`]
    .filter((block) => block.trim() !== "")
    .join("\n  ")}
})()`;
}
