// Evaluated as a script inside QuickJS, never imported into the Node host.
// The host supplies JSON strings and three bridge callbacks. Capture and remove
// them before user code runs; all captured state stays inside this closure.
(() => {
  const dispatch = globalThis.__dispatch;
  const validate = globalThis.__validate;
  const notify = globalThis.__notify;
  const argsJson = globalThis.__argsJson;
  const metaJson = globalThis.__metaJson;

  delete globalThis.__dispatch;
  delete globalThis.__validate;
  delete globalThis.__notify;
  delete globalThis.__argsJson;
  delete globalThis.__metaJson;

  const stringify = JSON.stringify;
  const parse = JSON.parse;
  const getPrototypeOf = Object.getPrototypeOf;
  const objectPrototype = Object.prototype;
  const isArray = Array.isArray;

  function encode(value) {
    return stringify(value, (_key, item) => {
      const type = typeof item;
      const unsupportedType =
        type === "undefined" ||
        type === "function" ||
        type === "symbol" ||
        type === "bigint";
      const nonfiniteNumber = type === "number" && !Number.isFinite(item);
      if (unsupportedType || nonfiniteNumber) {
        throw new TypeError("Workflow values must be finite JSON values");
      }

      if (item !== null && type === "object" && !isArray(item)) {
        const prototype = getPrototypeOf(item);
        if (prototype !== objectPrototype && prototype !== null) {
          throw new TypeError(
            "Workflow values must be finite JSON values; convert collections to arrays or plain objects",
          );
        }
      }
      return item;
    });
  }

  const NativeDate = Date;
  Object.defineProperty(NativeDate, "now", {
    value() {
      throw new Error("Date.now() is nondeterministic");
    },
    writable: false,
    configurable: false,
  });
  const SafeDate = new Proxy(NativeDate, {
    apply() {
      throw new Error("Date() is nondeterministic");
    },
    construct(target, values, constructor) {
      if (!values.length) {
        throw new Error("new Date() is nondeterministic");
      }
      return Reflect.construct(target, values, constructor);
    },
  });
  Object.defineProperty(NativeDate.prototype, "constructor", {
    value: SafeDate,
  });
  globalThis.Date = SafeDate;
  Object.defineProperty(Math, "random", {
    value() {
      throw new Error("Math.random() is nondeterministic");
    },
    writable: false,
    configurable: false,
  });

  const pending = new Map();
  let sequence = 0;

  function invoke(kind, ...values) {
    const encoded = values.map(encode);
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        dispatch(encode(id), encode(kind), ...encoded);
      } catch (error) {
        pending.delete(id);
        reject(error);
      }
    });
  }

  function install(name, value) {
    Object.defineProperty(globalThis, name, {
      value,
      writable: false,
      configurable: false,
    });
  }

  install("agent", (prompt, options = {}) => {
    validate(encode(prompt), encode(options));
    return invoke("agent", prompt, options);
  });
  install("workflow", (ref, args = null, options = {}) => {
    return invoke("workflow", ref, args, options);
  });
  install("phase", (title) => notify(encode("phase"), encode(title)));
  install("log", (text) => notify(encode("log"), encode(text)));

  install("parallel", async (thunks) => {
    if (!Array.isArray(thunks) || thunks.length > 4096) {
      throw new Error("parallel requires an array of at most 4096 functions");
    }
    return Promise.all(
      thunks.map(async (thunk) => {
        try {
          return await thunk();
        } catch {
          return null;
        }
      }),
    );
  });

  install("pipeline", async (items, ...stages) => {
    if (!Array.isArray(items) || items.length > 4096) {
      throw new Error("pipeline requires an array of at most 4096 items");
    }
    return Promise.all(
      items.map(async (item, index) => {
        let result = item;
        for (const stage of stages) {
          try {
            result = await stage(result, item, index);
          } catch {
            return null;
          }
        }
        return result;
      }),
    );
  });

  install("args", parse(argsJson));
  install("meta", parse(metaJson));
  install(
    "budget",
    Object.freeze({
      total: null,
      spent: () => 0,
      remaining: () => Infinity,
    }),
  );

  function settle(encoded) {
    const [id, success, value] = parse(encoded);
    const deferred = pending.get(id);
    if (!deferred) {
      throw new Error("Unknown bridge response");
    }
    pending.delete(id);
    if (success) {
      deferred.resolve(value);
    } else {
      deferred.reject(new Error(value));
    }
  }

  function encodeResult(value) {
    return encode(value === undefined ? null : value);
  }

  // The host holds these handles privately; user code never receives them.
  return [settle, encodeResult];
})();
