#!/usr/bin/env node
var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/index.ts
import { access, mkdir as mkdir4, readFile as readFile4, readdir as readdir3, realpath, stat as stat3, writeFile as writeFile2 } from "node:fs/promises";
import { existsSync as existsSync3, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, isAbsolute as isAbsolute2, join as join4, relative as relative3, resolve as resolve3 } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";

// ../../node_modules/.pnpm/@noble+hashes@1.8.0/node_modules/@noble/hashes/esm/utils.js
function isBytes(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array";
}
function abytes(b, ...lengths) {
  if (!isBytes(b))
    throw new Error("Uint8Array expected");
  if (lengths.length > 0 && !lengths.includes(b.length))
    throw new Error("Uint8Array expected of length " + lengths + ", got length=" + b.length);
}
function aexists(instance, checkFinished = true) {
  if (instance.destroyed)
    throw new Error("Hash instance has been destroyed");
  if (checkFinished && instance.finished)
    throw new Error("Hash#digest() has already been called");
}
function aoutput(out, instance) {
  abytes(out);
  const min = instance.outputLen;
  if (out.length < min) {
    throw new Error("digestInto() expects output buffer of length at least " + min);
  }
}
function clean(...arrays) {
  for (let i = 0; i < arrays.length; i++) {
    arrays[i].fill(0);
  }
}
function createView(arr) {
  return new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
}
function rotr(word, shift) {
  return word << 32 - shift | word >>> shift;
}
var hasHexBuiltin = /* @__PURE__ */ (() => (
  // @ts-ignore
  typeof Uint8Array.from([]).toHex === "function" && typeof Uint8Array.fromHex === "function"
))();
var hexes = /* @__PURE__ */ Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
function bytesToHex(bytes) {
  abytes(bytes);
  if (hasHexBuiltin)
    return bytes.toHex();
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += hexes[bytes[i]];
  }
  return hex;
}
function utf8ToBytes(str) {
  if (typeof str !== "string")
    throw new Error("string expected");
  return new Uint8Array(new TextEncoder().encode(str));
}
function toBytes(data) {
  if (typeof data === "string")
    data = utf8ToBytes(data);
  abytes(data);
  return data;
}
var Hash = class {
};
function createHasher(hashCons) {
  const hashC = (msg) => hashCons().update(toBytes(msg)).digest();
  const tmp = hashCons();
  hashC.outputLen = tmp.outputLen;
  hashC.blockLen = tmp.blockLen;
  hashC.create = () => hashCons();
  return hashC;
}

// ../../node_modules/.pnpm/@noble+hashes@1.8.0/node_modules/@noble/hashes/esm/_md.js
function setBigUint64(view, byteOffset, value, isLE) {
  if (typeof view.setBigUint64 === "function")
    return view.setBigUint64(byteOffset, value, isLE);
  const _32n = BigInt(32);
  const _u32_max = BigInt(4294967295);
  const wh = Number(value >> _32n & _u32_max);
  const wl = Number(value & _u32_max);
  const h = isLE ? 4 : 0;
  const l = isLE ? 0 : 4;
  view.setUint32(byteOffset + h, wh, isLE);
  view.setUint32(byteOffset + l, wl, isLE);
}
function Chi(a, b, c) {
  return a & b ^ ~a & c;
}
function Maj(a, b, c) {
  return a & b ^ a & c ^ b & c;
}
var HashMD = class extends Hash {
  constructor(blockLen, outputLen, padOffset, isLE) {
    super();
    this.finished = false;
    this.length = 0;
    this.pos = 0;
    this.destroyed = false;
    this.blockLen = blockLen;
    this.outputLen = outputLen;
    this.padOffset = padOffset;
    this.isLE = isLE;
    this.buffer = new Uint8Array(blockLen);
    this.view = createView(this.buffer);
  }
  update(data) {
    aexists(this);
    data = toBytes(data);
    abytes(data);
    const { view, buffer, blockLen } = this;
    const len = data.length;
    for (let pos = 0; pos < len; ) {
      const take = Math.min(blockLen - this.pos, len - pos);
      if (take === blockLen) {
        const dataView = createView(data);
        for (; blockLen <= len - pos; pos += blockLen)
          this.process(dataView, pos);
        continue;
      }
      buffer.set(data.subarray(pos, pos + take), this.pos);
      this.pos += take;
      pos += take;
      if (this.pos === blockLen) {
        this.process(view, 0);
        this.pos = 0;
      }
    }
    this.length += data.length;
    this.roundClean();
    return this;
  }
  digestInto(out) {
    aexists(this);
    aoutput(out, this);
    this.finished = true;
    const { buffer, view, blockLen, isLE } = this;
    let { pos } = this;
    buffer[pos++] = 128;
    clean(this.buffer.subarray(pos));
    if (this.padOffset > blockLen - pos) {
      this.process(view, 0);
      pos = 0;
    }
    for (let i = pos; i < blockLen; i++)
      buffer[i] = 0;
    setBigUint64(view, blockLen - 8, BigInt(this.length * 8), isLE);
    this.process(view, 0);
    const oview = createView(out);
    const len = this.outputLen;
    if (len % 4)
      throw new Error("_sha2: outputLen should be aligned to 32bit");
    const outLen = len / 4;
    const state = this.get();
    if (outLen > state.length)
      throw new Error("_sha2: outputLen bigger than state");
    for (let i = 0; i < outLen; i++)
      oview.setUint32(4 * i, state[i], isLE);
  }
  digest() {
    const { buffer, outputLen } = this;
    this.digestInto(buffer);
    const res = buffer.slice(0, outputLen);
    this.destroy();
    return res;
  }
  _cloneInto(to) {
    to || (to = new this.constructor());
    to.set(...this.get());
    const { blockLen, buffer, length, finished, destroyed, pos } = this;
    to.destroyed = destroyed;
    to.finished = finished;
    to.length = length;
    to.pos = pos;
    if (length % blockLen)
      to.buffer.set(buffer);
    return to;
  }
  clone() {
    return this._cloneInto();
  }
};
var SHA256_IV = /* @__PURE__ */ Uint32Array.from([
  1779033703,
  3144134277,
  1013904242,
  2773480762,
  1359893119,
  2600822924,
  528734635,
  1541459225
]);

// ../../node_modules/.pnpm/@noble+hashes@1.8.0/node_modules/@noble/hashes/esm/sha2.js
var SHA256_K = /* @__PURE__ */ Uint32Array.from([
  1116352408,
  1899447441,
  3049323471,
  3921009573,
  961987163,
  1508970993,
  2453635748,
  2870763221,
  3624381080,
  310598401,
  607225278,
  1426881987,
  1925078388,
  2162078206,
  2614888103,
  3248222580,
  3835390401,
  4022224774,
  264347078,
  604807628,
  770255983,
  1249150122,
  1555081692,
  1996064986,
  2554220882,
  2821834349,
  2952996808,
  3210313671,
  3336571891,
  3584528711,
  113926993,
  338241895,
  666307205,
  773529912,
  1294757372,
  1396182291,
  1695183700,
  1986661051,
  2177026350,
  2456956037,
  2730485921,
  2820302411,
  3259730800,
  3345764771,
  3516065817,
  3600352804,
  4094571909,
  275423344,
  430227734,
  506948616,
  659060556,
  883997877,
  958139571,
  1322822218,
  1537002063,
  1747873779,
  1955562222,
  2024104815,
  2227730452,
  2361852424,
  2428436474,
  2756734187,
  3204031479,
  3329325298
]);
var SHA256_W = /* @__PURE__ */ new Uint32Array(64);
var SHA256 = class extends HashMD {
  constructor(outputLen = 32) {
    super(64, outputLen, 8, false);
    this.A = SHA256_IV[0] | 0;
    this.B = SHA256_IV[1] | 0;
    this.C = SHA256_IV[2] | 0;
    this.D = SHA256_IV[3] | 0;
    this.E = SHA256_IV[4] | 0;
    this.F = SHA256_IV[5] | 0;
    this.G = SHA256_IV[6] | 0;
    this.H = SHA256_IV[7] | 0;
  }
  get() {
    const { A, B, C, D, E, F, G, H } = this;
    return [A, B, C, D, E, F, G, H];
  }
  // prettier-ignore
  set(A, B, C, D, E, F, G, H) {
    this.A = A | 0;
    this.B = B | 0;
    this.C = C | 0;
    this.D = D | 0;
    this.E = E | 0;
    this.F = F | 0;
    this.G = G | 0;
    this.H = H | 0;
  }
  process(view, offset) {
    for (let i = 0; i < 16; i++, offset += 4)
      SHA256_W[i] = view.getUint32(offset, false);
    for (let i = 16; i < 64; i++) {
      const W15 = SHA256_W[i - 15];
      const W2 = SHA256_W[i - 2];
      const s0 = rotr(W15, 7) ^ rotr(W15, 18) ^ W15 >>> 3;
      const s1 = rotr(W2, 17) ^ rotr(W2, 19) ^ W2 >>> 10;
      SHA256_W[i] = s1 + SHA256_W[i - 7] + s0 + SHA256_W[i - 16] | 0;
    }
    let { A, B, C, D, E, F, G, H } = this;
    for (let i = 0; i < 64; i++) {
      const sigma1 = rotr(E, 6) ^ rotr(E, 11) ^ rotr(E, 25);
      const T1 = H + sigma1 + Chi(E, F, G) + SHA256_K[i] + SHA256_W[i] | 0;
      const sigma0 = rotr(A, 2) ^ rotr(A, 13) ^ rotr(A, 22);
      const T2 = sigma0 + Maj(A, B, C) | 0;
      H = G;
      G = F;
      F = E;
      E = D + T1 | 0;
      D = C;
      C = B;
      B = A;
      A = T1 + T2 | 0;
    }
    A = A + this.A | 0;
    B = B + this.B | 0;
    C = C + this.C | 0;
    D = D + this.D | 0;
    E = E + this.E | 0;
    F = F + this.F | 0;
    G = G + this.G | 0;
    H = H + this.H | 0;
    this.set(A, B, C, D, E, F, G, H);
  }
  roundClean() {
    clean(SHA256_W);
  }
  destroy() {
    this.set(0, 0, 0, 0, 0, 0, 0, 0);
    clean(this.buffer);
  }
};
var sha256 = /* @__PURE__ */ createHasher(() => new SHA256());

// ../../node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/external.js
var external_exports = {};
__export(external_exports, {
  BRAND: () => BRAND,
  DIRTY: () => DIRTY,
  EMPTY_PATH: () => EMPTY_PATH,
  INVALID: () => INVALID,
  NEVER: () => NEVER,
  OK: () => OK,
  ParseStatus: () => ParseStatus,
  Schema: () => ZodType,
  ZodAny: () => ZodAny,
  ZodArray: () => ZodArray,
  ZodBigInt: () => ZodBigInt,
  ZodBoolean: () => ZodBoolean,
  ZodBranded: () => ZodBranded,
  ZodCatch: () => ZodCatch,
  ZodDate: () => ZodDate,
  ZodDefault: () => ZodDefault,
  ZodDiscriminatedUnion: () => ZodDiscriminatedUnion,
  ZodEffects: () => ZodEffects,
  ZodEnum: () => ZodEnum,
  ZodError: () => ZodError,
  ZodFirstPartyTypeKind: () => ZodFirstPartyTypeKind,
  ZodFunction: () => ZodFunction,
  ZodIntersection: () => ZodIntersection,
  ZodIssueCode: () => ZodIssueCode,
  ZodLazy: () => ZodLazy,
  ZodLiteral: () => ZodLiteral,
  ZodMap: () => ZodMap,
  ZodNaN: () => ZodNaN,
  ZodNativeEnum: () => ZodNativeEnum,
  ZodNever: () => ZodNever,
  ZodNull: () => ZodNull,
  ZodNullable: () => ZodNullable,
  ZodNumber: () => ZodNumber,
  ZodObject: () => ZodObject,
  ZodOptional: () => ZodOptional,
  ZodParsedType: () => ZodParsedType,
  ZodPipeline: () => ZodPipeline,
  ZodPromise: () => ZodPromise,
  ZodReadonly: () => ZodReadonly,
  ZodRecord: () => ZodRecord,
  ZodSchema: () => ZodType,
  ZodSet: () => ZodSet,
  ZodString: () => ZodString,
  ZodSymbol: () => ZodSymbol,
  ZodTransformer: () => ZodEffects,
  ZodTuple: () => ZodTuple,
  ZodType: () => ZodType,
  ZodUndefined: () => ZodUndefined,
  ZodUnion: () => ZodUnion,
  ZodUnknown: () => ZodUnknown,
  ZodVoid: () => ZodVoid,
  addIssueToContext: () => addIssueToContext,
  any: () => anyType,
  array: () => arrayType,
  bigint: () => bigIntType,
  boolean: () => booleanType,
  coerce: () => coerce,
  custom: () => custom,
  date: () => dateType,
  datetimeRegex: () => datetimeRegex,
  defaultErrorMap: () => en_default,
  discriminatedUnion: () => discriminatedUnionType,
  effect: () => effectsType,
  enum: () => enumType,
  function: () => functionType,
  getErrorMap: () => getErrorMap,
  getParsedType: () => getParsedType,
  instanceof: () => instanceOfType,
  intersection: () => intersectionType,
  isAborted: () => isAborted,
  isAsync: () => isAsync,
  isDirty: () => isDirty,
  isValid: () => isValid,
  late: () => late,
  lazy: () => lazyType,
  literal: () => literalType,
  makeIssue: () => makeIssue,
  map: () => mapType,
  nan: () => nanType,
  nativeEnum: () => nativeEnumType,
  never: () => neverType,
  null: () => nullType,
  nullable: () => nullableType,
  number: () => numberType,
  object: () => objectType,
  objectUtil: () => objectUtil,
  oboolean: () => oboolean,
  onumber: () => onumber,
  optional: () => optionalType,
  ostring: () => ostring,
  pipeline: () => pipelineType,
  preprocess: () => preprocessType,
  promise: () => promiseType,
  quotelessJson: () => quotelessJson,
  record: () => recordType,
  set: () => setType,
  setErrorMap: () => setErrorMap,
  strictObject: () => strictObjectType,
  string: () => stringType,
  symbol: () => symbolType,
  transformer: () => effectsType,
  tuple: () => tupleType,
  undefined: () => undefinedType,
  union: () => unionType,
  unknown: () => unknownType,
  util: () => util,
  void: () => voidType
});

// ../../node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/helpers/util.js
var util;
(function(util2) {
  util2.assertEqual = (_) => {
  };
  function assertIs(_arg) {
  }
  util2.assertIs = assertIs;
  function assertNever(_x) {
    throw new Error();
  }
  util2.assertNever = assertNever;
  util2.arrayToEnum = (items) => {
    const obj = {};
    for (const item of items) {
      obj[item] = item;
    }
    return obj;
  };
  util2.getValidEnumValues = (obj) => {
    const validKeys = util2.objectKeys(obj).filter((k) => typeof obj[obj[k]] !== "number");
    const filtered = {};
    for (const k of validKeys) {
      filtered[k] = obj[k];
    }
    return util2.objectValues(filtered);
  };
  util2.objectValues = (obj) => {
    return util2.objectKeys(obj).map(function(e) {
      return obj[e];
    });
  };
  util2.objectKeys = typeof Object.keys === "function" ? (obj) => Object.keys(obj) : (object) => {
    const keys = [];
    for (const key in object) {
      if (Object.prototype.hasOwnProperty.call(object, key)) {
        keys.push(key);
      }
    }
    return keys;
  };
  util2.find = (arr, checker) => {
    for (const item of arr) {
      if (checker(item))
        return item;
    }
    return void 0;
  };
  util2.isInteger = typeof Number.isInteger === "function" ? (val) => Number.isInteger(val) : (val) => typeof val === "number" && Number.isFinite(val) && Math.floor(val) === val;
  function joinValues(array, separator = " | ") {
    return array.map((val) => typeof val === "string" ? `'${val}'` : val).join(separator);
  }
  util2.joinValues = joinValues;
  util2.jsonStringifyReplacer = (_, value) => {
    if (typeof value === "bigint") {
      return value.toString();
    }
    return value;
  };
})(util || (util = {}));
var objectUtil;
(function(objectUtil2) {
  objectUtil2.mergeShapes = (first, second) => {
    return {
      ...first,
      ...second
      // second overwrites first
    };
  };
})(objectUtil || (objectUtil = {}));
var ZodParsedType = util.arrayToEnum([
  "string",
  "nan",
  "number",
  "integer",
  "float",
  "boolean",
  "date",
  "bigint",
  "symbol",
  "function",
  "undefined",
  "null",
  "array",
  "object",
  "unknown",
  "promise",
  "void",
  "never",
  "map",
  "set"
]);
var getParsedType = (data) => {
  const t = typeof data;
  switch (t) {
    case "undefined":
      return ZodParsedType.undefined;
    case "string":
      return ZodParsedType.string;
    case "number":
      return Number.isNaN(data) ? ZodParsedType.nan : ZodParsedType.number;
    case "boolean":
      return ZodParsedType.boolean;
    case "function":
      return ZodParsedType.function;
    case "bigint":
      return ZodParsedType.bigint;
    case "symbol":
      return ZodParsedType.symbol;
    case "object":
      if (Array.isArray(data)) {
        return ZodParsedType.array;
      }
      if (data === null) {
        return ZodParsedType.null;
      }
      if (data.then && typeof data.then === "function" && data.catch && typeof data.catch === "function") {
        return ZodParsedType.promise;
      }
      if (typeof Map !== "undefined" && data instanceof Map) {
        return ZodParsedType.map;
      }
      if (typeof Set !== "undefined" && data instanceof Set) {
        return ZodParsedType.set;
      }
      if (typeof Date !== "undefined" && data instanceof Date) {
        return ZodParsedType.date;
      }
      return ZodParsedType.object;
    default:
      return ZodParsedType.unknown;
  }
};

// ../../node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/ZodError.js
var ZodIssueCode = util.arrayToEnum([
  "invalid_type",
  "invalid_literal",
  "custom",
  "invalid_union",
  "invalid_union_discriminator",
  "invalid_enum_value",
  "unrecognized_keys",
  "invalid_arguments",
  "invalid_return_type",
  "invalid_date",
  "invalid_string",
  "too_small",
  "too_big",
  "invalid_intersection_types",
  "not_multiple_of",
  "not_finite"
]);
var quotelessJson = (obj) => {
  const json = JSON.stringify(obj, null, 2);
  return json.replace(/"([^"]+)":/g, "$1:");
};
var ZodError = class _ZodError extends Error {
  get errors() {
    return this.issues;
  }
  constructor(issues) {
    super();
    this.issues = [];
    this.addIssue = (sub) => {
      this.issues = [...this.issues, sub];
    };
    this.addIssues = (subs = []) => {
      this.issues = [...this.issues, ...subs];
    };
    const actualProto = new.target.prototype;
    if (Object.setPrototypeOf) {
      Object.setPrototypeOf(this, actualProto);
    } else {
      this.__proto__ = actualProto;
    }
    this.name = "ZodError";
    this.issues = issues;
  }
  format(_mapper) {
    const mapper = _mapper || function(issue) {
      return issue.message;
    };
    const fieldErrors = { _errors: [] };
    const processError = (error) => {
      for (const issue of error.issues) {
        if (issue.code === "invalid_union") {
          issue.unionErrors.map(processError);
        } else if (issue.code === "invalid_return_type") {
          processError(issue.returnTypeError);
        } else if (issue.code === "invalid_arguments") {
          processError(issue.argumentsError);
        } else if (issue.path.length === 0) {
          fieldErrors._errors.push(mapper(issue));
        } else {
          let curr = fieldErrors;
          let i = 0;
          while (i < issue.path.length) {
            const el = issue.path[i];
            const terminal = i === issue.path.length - 1;
            if (!terminal) {
              curr[el] = curr[el] || { _errors: [] };
            } else {
              curr[el] = curr[el] || { _errors: [] };
              curr[el]._errors.push(mapper(issue));
            }
            curr = curr[el];
            i++;
          }
        }
      }
    };
    processError(this);
    return fieldErrors;
  }
  static assert(value) {
    if (!(value instanceof _ZodError)) {
      throw new Error(`Not a ZodError: ${value}`);
    }
  }
  toString() {
    return this.message;
  }
  get message() {
    return JSON.stringify(this.issues, util.jsonStringifyReplacer, 2);
  }
  get isEmpty() {
    return this.issues.length === 0;
  }
  flatten(mapper = (issue) => issue.message) {
    const fieldErrors = {};
    const formErrors = [];
    for (const sub of this.issues) {
      if (sub.path.length > 0) {
        const firstEl = sub.path[0];
        fieldErrors[firstEl] = fieldErrors[firstEl] || [];
        fieldErrors[firstEl].push(mapper(sub));
      } else {
        formErrors.push(mapper(sub));
      }
    }
    return { formErrors, fieldErrors };
  }
  get formErrors() {
    return this.flatten();
  }
};
ZodError.create = (issues) => {
  const error = new ZodError(issues);
  return error;
};

// ../../node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/locales/en.js
var errorMap = (issue, _ctx) => {
  let message;
  switch (issue.code) {
    case ZodIssueCode.invalid_type:
      if (issue.received === ZodParsedType.undefined) {
        message = "Required";
      } else {
        message = `Expected ${issue.expected}, received ${issue.received}`;
      }
      break;
    case ZodIssueCode.invalid_literal:
      message = `Invalid literal value, expected ${JSON.stringify(issue.expected, util.jsonStringifyReplacer)}`;
      break;
    case ZodIssueCode.unrecognized_keys:
      message = `Unrecognized key(s) in object: ${util.joinValues(issue.keys, ", ")}`;
      break;
    case ZodIssueCode.invalid_union:
      message = `Invalid input`;
      break;
    case ZodIssueCode.invalid_union_discriminator:
      message = `Invalid discriminator value. Expected ${util.joinValues(issue.options)}`;
      break;
    case ZodIssueCode.invalid_enum_value:
      message = `Invalid enum value. Expected ${util.joinValues(issue.options)}, received '${issue.received}'`;
      break;
    case ZodIssueCode.invalid_arguments:
      message = `Invalid function arguments`;
      break;
    case ZodIssueCode.invalid_return_type:
      message = `Invalid function return type`;
      break;
    case ZodIssueCode.invalid_date:
      message = `Invalid date`;
      break;
    case ZodIssueCode.invalid_string:
      if (typeof issue.validation === "object") {
        if ("includes" in issue.validation) {
          message = `Invalid input: must include "${issue.validation.includes}"`;
          if (typeof issue.validation.position === "number") {
            message = `${message} at one or more positions greater than or equal to ${issue.validation.position}`;
          }
        } else if ("startsWith" in issue.validation) {
          message = `Invalid input: must start with "${issue.validation.startsWith}"`;
        } else if ("endsWith" in issue.validation) {
          message = `Invalid input: must end with "${issue.validation.endsWith}"`;
        } else {
          util.assertNever(issue.validation);
        }
      } else if (issue.validation !== "regex") {
        message = `Invalid ${issue.validation}`;
      } else {
        message = "Invalid";
      }
      break;
    case ZodIssueCode.too_small:
      if (issue.type === "array")
        message = `Array must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `more than`} ${issue.minimum} element(s)`;
      else if (issue.type === "string")
        message = `String must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `over`} ${issue.minimum} character(s)`;
      else if (issue.type === "number")
        message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
      else if (issue.type === "bigint")
        message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
      else if (issue.type === "date")
        message = `Date must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${new Date(Number(issue.minimum))}`;
      else
        message = "Invalid input";
      break;
    case ZodIssueCode.too_big:
      if (issue.type === "array")
        message = `Array must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `less than`} ${issue.maximum} element(s)`;
      else if (issue.type === "string")
        message = `String must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `under`} ${issue.maximum} character(s)`;
      else if (issue.type === "number")
        message = `Number must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
      else if (issue.type === "bigint")
        message = `BigInt must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
      else if (issue.type === "date")
        message = `Date must be ${issue.exact ? `exactly` : issue.inclusive ? `smaller than or equal to` : `smaller than`} ${new Date(Number(issue.maximum))}`;
      else
        message = "Invalid input";
      break;
    case ZodIssueCode.custom:
      message = `Invalid input`;
      break;
    case ZodIssueCode.invalid_intersection_types:
      message = `Intersection results could not be merged`;
      break;
    case ZodIssueCode.not_multiple_of:
      message = `Number must be a multiple of ${issue.multipleOf}`;
      break;
    case ZodIssueCode.not_finite:
      message = "Number must be finite";
      break;
    default:
      message = _ctx.defaultError;
      util.assertNever(issue);
  }
  return { message };
};
var en_default = errorMap;

// ../../node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/errors.js
var overrideErrorMap = en_default;
function setErrorMap(map) {
  overrideErrorMap = map;
}
function getErrorMap() {
  return overrideErrorMap;
}

// ../../node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/helpers/parseUtil.js
var makeIssue = (params) => {
  const { data, path, errorMaps, issueData } = params;
  const fullPath = [...path, ...issueData.path || []];
  const fullIssue = {
    ...issueData,
    path: fullPath
  };
  if (issueData.message !== void 0) {
    return {
      ...issueData,
      path: fullPath,
      message: issueData.message
    };
  }
  let errorMessage = "";
  const maps = errorMaps.filter((m) => !!m).slice().reverse();
  for (const map of maps) {
    errorMessage = map(fullIssue, { data, defaultError: errorMessage }).message;
  }
  return {
    ...issueData,
    path: fullPath,
    message: errorMessage
  };
};
var EMPTY_PATH = [];
function addIssueToContext(ctx, issueData) {
  const overrideMap = getErrorMap();
  const issue = makeIssue({
    issueData,
    data: ctx.data,
    path: ctx.path,
    errorMaps: [
      ctx.common.contextualErrorMap,
      // contextual error map is first priority
      ctx.schemaErrorMap,
      // then schema-bound map if available
      overrideMap,
      // then global override map
      overrideMap === en_default ? void 0 : en_default
      // then global default map
    ].filter((x) => !!x)
  });
  ctx.common.issues.push(issue);
}
var ParseStatus = class _ParseStatus {
  constructor() {
    this.value = "valid";
  }
  dirty() {
    if (this.value === "valid")
      this.value = "dirty";
  }
  abort() {
    if (this.value !== "aborted")
      this.value = "aborted";
  }
  static mergeArray(status, results) {
    const arrayValue = [];
    for (const s of results) {
      if (s.status === "aborted")
        return INVALID;
      if (s.status === "dirty")
        status.dirty();
      arrayValue.push(s.value);
    }
    return { status: status.value, value: arrayValue };
  }
  static async mergeObjectAsync(status, pairs) {
    const syncPairs = [];
    for (const pair of pairs) {
      const key = await pair.key;
      const value = await pair.value;
      syncPairs.push({
        key,
        value
      });
    }
    return _ParseStatus.mergeObjectSync(status, syncPairs);
  }
  static mergeObjectSync(status, pairs) {
    const finalObject = {};
    for (const pair of pairs) {
      const { key, value } = pair;
      if (key.status === "aborted")
        return INVALID;
      if (value.status === "aborted")
        return INVALID;
      if (key.status === "dirty")
        status.dirty();
      if (value.status === "dirty")
        status.dirty();
      if (key.value !== "__proto__" && (typeof value.value !== "undefined" || pair.alwaysSet)) {
        finalObject[key.value] = value.value;
      }
    }
    return { status: status.value, value: finalObject };
  }
};
var INVALID = Object.freeze({
  status: "aborted"
});
var DIRTY = (value) => ({ status: "dirty", value });
var OK = (value) => ({ status: "valid", value });
var isAborted = (x) => x.status === "aborted";
var isDirty = (x) => x.status === "dirty";
var isValid = (x) => x.status === "valid";
var isAsync = (x) => typeof Promise !== "undefined" && x instanceof Promise;

// ../../node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/helpers/errorUtil.js
var errorUtil;
(function(errorUtil2) {
  errorUtil2.errToObj = (message) => typeof message === "string" ? { message } : message || {};
  errorUtil2.toString = (message) => typeof message === "string" ? message : message?.message;
})(errorUtil || (errorUtil = {}));

// ../../node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/types.js
var ParseInputLazyPath = class {
  constructor(parent, value, path, key) {
    this._cachedPath = [];
    this.parent = parent;
    this.data = value;
    this._path = path;
    this._key = key;
  }
  get path() {
    if (!this._cachedPath.length) {
      if (Array.isArray(this._key)) {
        this._cachedPath.push(...this._path, ...this._key);
      } else {
        this._cachedPath.push(...this._path, this._key);
      }
    }
    return this._cachedPath;
  }
};
var handleResult = (ctx, result) => {
  if (isValid(result)) {
    return { success: true, data: result.value };
  } else {
    if (!ctx.common.issues.length) {
      throw new Error("Validation failed but no issues detected.");
    }
    return {
      success: false,
      get error() {
        if (this._error)
          return this._error;
        const error = new ZodError(ctx.common.issues);
        this._error = error;
        return this._error;
      }
    };
  }
};
function processCreateParams(params) {
  if (!params)
    return {};
  const { errorMap: errorMap2, invalid_type_error, required_error, description } = params;
  if (errorMap2 && (invalid_type_error || required_error)) {
    throw new Error(`Can't use "invalid_type_error" or "required_error" in conjunction with custom error map.`);
  }
  if (errorMap2)
    return { errorMap: errorMap2, description };
  const customMap = (iss, ctx) => {
    const { message } = params;
    if (iss.code === "invalid_enum_value") {
      return { message: message ?? ctx.defaultError };
    }
    if (typeof ctx.data === "undefined") {
      return { message: message ?? required_error ?? ctx.defaultError };
    }
    if (iss.code !== "invalid_type")
      return { message: ctx.defaultError };
    return { message: message ?? invalid_type_error ?? ctx.defaultError };
  };
  return { errorMap: customMap, description };
}
var ZodType = class {
  get description() {
    return this._def.description;
  }
  _getType(input) {
    return getParsedType(input.data);
  }
  _getOrReturnCtx(input, ctx) {
    return ctx || {
      common: input.parent.common,
      data: input.data,
      parsedType: getParsedType(input.data),
      schemaErrorMap: this._def.errorMap,
      path: input.path,
      parent: input.parent
    };
  }
  _processInputParams(input) {
    return {
      status: new ParseStatus(),
      ctx: {
        common: input.parent.common,
        data: input.data,
        parsedType: getParsedType(input.data),
        schemaErrorMap: this._def.errorMap,
        path: input.path,
        parent: input.parent
      }
    };
  }
  _parseSync(input) {
    const result = this._parse(input);
    if (isAsync(result)) {
      throw new Error("Synchronous parse encountered promise.");
    }
    return result;
  }
  _parseAsync(input) {
    const result = this._parse(input);
    return Promise.resolve(result);
  }
  parse(data, params) {
    const result = this.safeParse(data, params);
    if (result.success)
      return result.data;
    throw result.error;
  }
  safeParse(data, params) {
    const ctx = {
      common: {
        issues: [],
        async: params?.async ?? false,
        contextualErrorMap: params?.errorMap
      },
      path: params?.path || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    const result = this._parseSync({ data, path: ctx.path, parent: ctx });
    return handleResult(ctx, result);
  }
  "~validate"(data) {
    const ctx = {
      common: {
        issues: [],
        async: !!this["~standard"].async
      },
      path: [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    if (!this["~standard"].async) {
      try {
        const result = this._parseSync({ data, path: [], parent: ctx });
        return isValid(result) ? {
          value: result.value
        } : {
          issues: ctx.common.issues
        };
      } catch (err) {
        if (err?.message?.toLowerCase()?.includes("encountered")) {
          this["~standard"].async = true;
        }
        ctx.common = {
          issues: [],
          async: true
        };
      }
    }
    return this._parseAsync({ data, path: [], parent: ctx }).then((result) => isValid(result) ? {
      value: result.value
    } : {
      issues: ctx.common.issues
    });
  }
  async parseAsync(data, params) {
    const result = await this.safeParseAsync(data, params);
    if (result.success)
      return result.data;
    throw result.error;
  }
  async safeParseAsync(data, params) {
    const ctx = {
      common: {
        issues: [],
        contextualErrorMap: params?.errorMap,
        async: true
      },
      path: params?.path || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    const maybeAsyncResult = this._parse({ data, path: ctx.path, parent: ctx });
    const result = await (isAsync(maybeAsyncResult) ? maybeAsyncResult : Promise.resolve(maybeAsyncResult));
    return handleResult(ctx, result);
  }
  refine(check, message) {
    const getIssueProperties = (val) => {
      if (typeof message === "string" || typeof message === "undefined") {
        return { message };
      } else if (typeof message === "function") {
        return message(val);
      } else {
        return message;
      }
    };
    return this._refinement((val, ctx) => {
      const result = check(val);
      const setError = () => ctx.addIssue({
        code: ZodIssueCode.custom,
        ...getIssueProperties(val)
      });
      if (typeof Promise !== "undefined" && result instanceof Promise) {
        return result.then((data) => {
          if (!data) {
            setError();
            return false;
          } else {
            return true;
          }
        });
      }
      if (!result) {
        setError();
        return false;
      } else {
        return true;
      }
    });
  }
  refinement(check, refinementData) {
    return this._refinement((val, ctx) => {
      if (!check(val)) {
        ctx.addIssue(typeof refinementData === "function" ? refinementData(val, ctx) : refinementData);
        return false;
      } else {
        return true;
      }
    });
  }
  _refinement(refinement) {
    return new ZodEffects({
      schema: this,
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      effect: { type: "refinement", refinement }
    });
  }
  superRefine(refinement) {
    return this._refinement(refinement);
  }
  constructor(def) {
    this.spa = this.safeParseAsync;
    this._def = def;
    this.parse = this.parse.bind(this);
    this.safeParse = this.safeParse.bind(this);
    this.parseAsync = this.parseAsync.bind(this);
    this.safeParseAsync = this.safeParseAsync.bind(this);
    this.spa = this.spa.bind(this);
    this.refine = this.refine.bind(this);
    this.refinement = this.refinement.bind(this);
    this.superRefine = this.superRefine.bind(this);
    this.optional = this.optional.bind(this);
    this.nullable = this.nullable.bind(this);
    this.nullish = this.nullish.bind(this);
    this.array = this.array.bind(this);
    this.promise = this.promise.bind(this);
    this.or = this.or.bind(this);
    this.and = this.and.bind(this);
    this.transform = this.transform.bind(this);
    this.brand = this.brand.bind(this);
    this.default = this.default.bind(this);
    this.catch = this.catch.bind(this);
    this.describe = this.describe.bind(this);
    this.pipe = this.pipe.bind(this);
    this.readonly = this.readonly.bind(this);
    this.isNullable = this.isNullable.bind(this);
    this.isOptional = this.isOptional.bind(this);
    this["~standard"] = {
      version: 1,
      vendor: "zod",
      validate: (data) => this["~validate"](data)
    };
  }
  optional() {
    return ZodOptional.create(this, this._def);
  }
  nullable() {
    return ZodNullable.create(this, this._def);
  }
  nullish() {
    return this.nullable().optional();
  }
  array() {
    return ZodArray.create(this);
  }
  promise() {
    return ZodPromise.create(this, this._def);
  }
  or(option) {
    return ZodUnion.create([this, option], this._def);
  }
  and(incoming) {
    return ZodIntersection.create(this, incoming, this._def);
  }
  transform(transform) {
    return new ZodEffects({
      ...processCreateParams(this._def),
      schema: this,
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      effect: { type: "transform", transform }
    });
  }
  default(def) {
    const defaultValueFunc = typeof def === "function" ? def : () => def;
    return new ZodDefault({
      ...processCreateParams(this._def),
      innerType: this,
      defaultValue: defaultValueFunc,
      typeName: ZodFirstPartyTypeKind.ZodDefault
    });
  }
  brand() {
    return new ZodBranded({
      typeName: ZodFirstPartyTypeKind.ZodBranded,
      type: this,
      ...processCreateParams(this._def)
    });
  }
  catch(def) {
    const catchValueFunc = typeof def === "function" ? def : () => def;
    return new ZodCatch({
      ...processCreateParams(this._def),
      innerType: this,
      catchValue: catchValueFunc,
      typeName: ZodFirstPartyTypeKind.ZodCatch
    });
  }
  describe(description) {
    const This = this.constructor;
    return new This({
      ...this._def,
      description
    });
  }
  pipe(target) {
    return ZodPipeline.create(this, target);
  }
  readonly() {
    return ZodReadonly.create(this);
  }
  isOptional() {
    return this.safeParse(void 0).success;
  }
  isNullable() {
    return this.safeParse(null).success;
  }
};
var cuidRegex = /^c[^\s-]{8,}$/i;
var cuid2Regex = /^[0-9a-z]+$/;
var ulidRegex = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
var uuidRegex = /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/i;
var nanoidRegex = /^[a-z0-9_-]{21}$/i;
var jwtRegex = /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]*$/;
var durationRegex = /^[-+]?P(?!$)(?:(?:[-+]?\d+Y)|(?:[-+]?\d+[.,]\d+Y$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:(?:[-+]?\d+W)|(?:[-+]?\d+[.,]\d+W$))?(?:(?:[-+]?\d+D)|(?:[-+]?\d+[.,]\d+D$))?(?:T(?=[\d+-])(?:(?:[-+]?\d+H)|(?:[-+]?\d+[.,]\d+H$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:[-+]?\d+(?:[.,]\d+)?S)?)??$/;
var emailRegex = /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$/i;
var _emojiRegex = `^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$`;
var emojiRegex;
var ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
var ipv4CidrRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/(3[0-2]|[12]?[0-9])$/;
var ipv6Regex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;
var ipv6CidrRegex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
var base64Regex = /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/;
var base64urlRegex = /^([0-9a-zA-Z-_]{4})*(([0-9a-zA-Z-_]{2}(==)?)|([0-9a-zA-Z-_]{3}(=)?))?$/;
var dateRegexSource = `((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|(02)-(0[1-9]|1\\d|2[0-8])))`;
var dateRegex = new RegExp(`^${dateRegexSource}$`);
function timeRegexSource(args) {
  let secondsRegexSource = `[0-5]\\d`;
  if (args.precision) {
    secondsRegexSource = `${secondsRegexSource}\\.\\d{${args.precision}}`;
  } else if (args.precision == null) {
    secondsRegexSource = `${secondsRegexSource}(\\.\\d+)?`;
  }
  const secondsQuantifier = args.precision ? "+" : "?";
  return `([01]\\d|2[0-3]):[0-5]\\d(:${secondsRegexSource})${secondsQuantifier}`;
}
function timeRegex(args) {
  return new RegExp(`^${timeRegexSource(args)}$`);
}
function datetimeRegex(args) {
  let regex = `${dateRegexSource}T${timeRegexSource(args)}`;
  const opts = [];
  opts.push(args.local ? `Z?` : `Z`);
  if (args.offset)
    opts.push(`([+-]\\d{2}:?\\d{2})`);
  regex = `${regex}(${opts.join("|")})`;
  return new RegExp(`^${regex}$`);
}
function isValidIP(ip, version) {
  if ((version === "v4" || !version) && ipv4Regex.test(ip)) {
    return true;
  }
  if ((version === "v6" || !version) && ipv6Regex.test(ip)) {
    return true;
  }
  return false;
}
function isValidJWT(jwt, alg) {
  if (!jwtRegex.test(jwt))
    return false;
  try {
    const [header] = jwt.split(".");
    if (!header)
      return false;
    const base64 = header.replace(/-/g, "+").replace(/_/g, "/").padEnd(header.length + (4 - header.length % 4) % 4, "=");
    const decoded = JSON.parse(atob(base64));
    if (typeof decoded !== "object" || decoded === null)
      return false;
    if ("typ" in decoded && decoded?.typ !== "JWT")
      return false;
    if (!decoded.alg)
      return false;
    if (alg && decoded.alg !== alg)
      return false;
    return true;
  } catch {
    return false;
  }
}
function isValidCidr(ip, version) {
  if ((version === "v4" || !version) && ipv4CidrRegex.test(ip)) {
    return true;
  }
  if ((version === "v6" || !version) && ipv6CidrRegex.test(ip)) {
    return true;
  }
  return false;
}
var ZodString = class _ZodString extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = String(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.string) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.string,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    const status = new ParseStatus();
    let ctx = void 0;
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        if (input.data.length < check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: check.value,
            type: "string",
            inclusive: true,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        if (input.data.length > check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: check.value,
            type: "string",
            inclusive: true,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "length") {
        const tooBig = input.data.length > check.value;
        const tooSmall = input.data.length < check.value;
        if (tooBig || tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          if (tooBig) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_big,
              maximum: check.value,
              type: "string",
              inclusive: true,
              exact: true,
              message: check.message
            });
          } else if (tooSmall) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_small,
              minimum: check.value,
              type: "string",
              inclusive: true,
              exact: true,
              message: check.message
            });
          }
          status.dirty();
        }
      } else if (check.kind === "email") {
        if (!emailRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "email",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "emoji") {
        if (!emojiRegex) {
          emojiRegex = new RegExp(_emojiRegex, "u");
        }
        if (!emojiRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "emoji",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "uuid") {
        if (!uuidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "uuid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "nanoid") {
        if (!nanoidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "nanoid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cuid") {
        if (!cuidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cuid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cuid2") {
        if (!cuid2Regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cuid2",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "ulid") {
        if (!ulidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "ulid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "url") {
        try {
          new URL(input.data);
        } catch {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "url",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "regex") {
        check.regex.lastIndex = 0;
        const testResult = check.regex.test(input.data);
        if (!testResult) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "regex",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "trim") {
        input.data = input.data.trim();
      } else if (check.kind === "includes") {
        if (!input.data.includes(check.value, check.position)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { includes: check.value, position: check.position },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "toLowerCase") {
        input.data = input.data.toLowerCase();
      } else if (check.kind === "toUpperCase") {
        input.data = input.data.toUpperCase();
      } else if (check.kind === "startsWith") {
        if (!input.data.startsWith(check.value)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { startsWith: check.value },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "endsWith") {
        if (!input.data.endsWith(check.value)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { endsWith: check.value },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "datetime") {
        const regex = datetimeRegex(check);
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "datetime",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "date") {
        const regex = dateRegex;
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "date",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "time") {
        const regex = timeRegex(check);
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "time",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "duration") {
        if (!durationRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "duration",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "ip") {
        if (!isValidIP(input.data, check.version)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "ip",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "jwt") {
        if (!isValidJWT(input.data, check.alg)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "jwt",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cidr") {
        if (!isValidCidr(input.data, check.version)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cidr",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "base64") {
        if (!base64Regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "base64",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "base64url") {
        if (!base64urlRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "base64url",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  _regex(regex, validation, message) {
    return this.refinement((data) => regex.test(data), {
      validation,
      code: ZodIssueCode.invalid_string,
      ...errorUtil.errToObj(message)
    });
  }
  _addCheck(check) {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  email(message) {
    return this._addCheck({ kind: "email", ...errorUtil.errToObj(message) });
  }
  url(message) {
    return this._addCheck({ kind: "url", ...errorUtil.errToObj(message) });
  }
  emoji(message) {
    return this._addCheck({ kind: "emoji", ...errorUtil.errToObj(message) });
  }
  uuid(message) {
    return this._addCheck({ kind: "uuid", ...errorUtil.errToObj(message) });
  }
  nanoid(message) {
    return this._addCheck({ kind: "nanoid", ...errorUtil.errToObj(message) });
  }
  cuid(message) {
    return this._addCheck({ kind: "cuid", ...errorUtil.errToObj(message) });
  }
  cuid2(message) {
    return this._addCheck({ kind: "cuid2", ...errorUtil.errToObj(message) });
  }
  ulid(message) {
    return this._addCheck({ kind: "ulid", ...errorUtil.errToObj(message) });
  }
  base64(message) {
    return this._addCheck({ kind: "base64", ...errorUtil.errToObj(message) });
  }
  base64url(message) {
    return this._addCheck({
      kind: "base64url",
      ...errorUtil.errToObj(message)
    });
  }
  jwt(options) {
    return this._addCheck({ kind: "jwt", ...errorUtil.errToObj(options) });
  }
  ip(options) {
    return this._addCheck({ kind: "ip", ...errorUtil.errToObj(options) });
  }
  cidr(options) {
    return this._addCheck({ kind: "cidr", ...errorUtil.errToObj(options) });
  }
  datetime(options) {
    if (typeof options === "string") {
      return this._addCheck({
        kind: "datetime",
        precision: null,
        offset: false,
        local: false,
        message: options
      });
    }
    return this._addCheck({
      kind: "datetime",
      precision: typeof options?.precision === "undefined" ? null : options?.precision,
      offset: options?.offset ?? false,
      local: options?.local ?? false,
      ...errorUtil.errToObj(options?.message)
    });
  }
  date(message) {
    return this._addCheck({ kind: "date", message });
  }
  time(options) {
    if (typeof options === "string") {
      return this._addCheck({
        kind: "time",
        precision: null,
        message: options
      });
    }
    return this._addCheck({
      kind: "time",
      precision: typeof options?.precision === "undefined" ? null : options?.precision,
      ...errorUtil.errToObj(options?.message)
    });
  }
  duration(message) {
    return this._addCheck({ kind: "duration", ...errorUtil.errToObj(message) });
  }
  regex(regex, message) {
    return this._addCheck({
      kind: "regex",
      regex,
      ...errorUtil.errToObj(message)
    });
  }
  includes(value, options) {
    return this._addCheck({
      kind: "includes",
      value,
      position: options?.position,
      ...errorUtil.errToObj(options?.message)
    });
  }
  startsWith(value, message) {
    return this._addCheck({
      kind: "startsWith",
      value,
      ...errorUtil.errToObj(message)
    });
  }
  endsWith(value, message) {
    return this._addCheck({
      kind: "endsWith",
      value,
      ...errorUtil.errToObj(message)
    });
  }
  min(minLength, message) {
    return this._addCheck({
      kind: "min",
      value: minLength,
      ...errorUtil.errToObj(message)
    });
  }
  max(maxLength, message) {
    return this._addCheck({
      kind: "max",
      value: maxLength,
      ...errorUtil.errToObj(message)
    });
  }
  length(len, message) {
    return this._addCheck({
      kind: "length",
      value: len,
      ...errorUtil.errToObj(message)
    });
  }
  /**
   * Equivalent to `.min(1)`
   */
  nonempty(message) {
    return this.min(1, errorUtil.errToObj(message));
  }
  trim() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "trim" }]
    });
  }
  toLowerCase() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "toLowerCase" }]
    });
  }
  toUpperCase() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "toUpperCase" }]
    });
  }
  get isDatetime() {
    return !!this._def.checks.find((ch) => ch.kind === "datetime");
  }
  get isDate() {
    return !!this._def.checks.find((ch) => ch.kind === "date");
  }
  get isTime() {
    return !!this._def.checks.find((ch) => ch.kind === "time");
  }
  get isDuration() {
    return !!this._def.checks.find((ch) => ch.kind === "duration");
  }
  get isEmail() {
    return !!this._def.checks.find((ch) => ch.kind === "email");
  }
  get isURL() {
    return !!this._def.checks.find((ch) => ch.kind === "url");
  }
  get isEmoji() {
    return !!this._def.checks.find((ch) => ch.kind === "emoji");
  }
  get isUUID() {
    return !!this._def.checks.find((ch) => ch.kind === "uuid");
  }
  get isNANOID() {
    return !!this._def.checks.find((ch) => ch.kind === "nanoid");
  }
  get isCUID() {
    return !!this._def.checks.find((ch) => ch.kind === "cuid");
  }
  get isCUID2() {
    return !!this._def.checks.find((ch) => ch.kind === "cuid2");
  }
  get isULID() {
    return !!this._def.checks.find((ch) => ch.kind === "ulid");
  }
  get isIP() {
    return !!this._def.checks.find((ch) => ch.kind === "ip");
  }
  get isCIDR() {
    return !!this._def.checks.find((ch) => ch.kind === "cidr");
  }
  get isBase64() {
    return !!this._def.checks.find((ch) => ch.kind === "base64");
  }
  get isBase64url() {
    return !!this._def.checks.find((ch) => ch.kind === "base64url");
  }
  get minLength() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxLength() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
};
ZodString.create = (params) => {
  return new ZodString({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodString,
    coerce: params?.coerce ?? false,
    ...processCreateParams(params)
  });
};
function floatSafeRemainder(val, step) {
  const valDecCount = (val.toString().split(".")[1] || "").length;
  const stepDecCount = (step.toString().split(".")[1] || "").length;
  const decCount = valDecCount > stepDecCount ? valDecCount : stepDecCount;
  const valInt = Number.parseInt(val.toFixed(decCount).replace(".", ""));
  const stepInt = Number.parseInt(step.toFixed(decCount).replace(".", ""));
  return valInt % stepInt / 10 ** decCount;
}
var ZodNumber = class _ZodNumber extends ZodType {
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
    this.step = this.multipleOf;
  }
  _parse(input) {
    if (this._def.coerce) {
      input.data = Number(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.number) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.number,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    let ctx = void 0;
    const status = new ParseStatus();
    for (const check of this._def.checks) {
      if (check.kind === "int") {
        if (!util.isInteger(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_type,
            expected: "integer",
            received: "float",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "min") {
        const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
        if (tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: check.value,
            type: "number",
            inclusive: check.inclusive,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
        if (tooBig) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: check.value,
            type: "number",
            inclusive: check.inclusive,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "multipleOf") {
        if (floatSafeRemainder(input.data, check.value) !== 0) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_multiple_of,
            multipleOf: check.value,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "finite") {
        if (!Number.isFinite(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_finite,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  gte(value, message) {
    return this.setLimit("min", value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit("min", value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit("max", value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit("max", value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new _ZodNumber({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message)
        }
      ]
    });
  }
  _addCheck(check) {
    return new _ZodNumber({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  int(message) {
    return this._addCheck({
      kind: "int",
      message: errorUtil.toString(message)
    });
  }
  positive(message) {
    return this._addCheck({
      kind: "min",
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  negative(message) {
    return this._addCheck({
      kind: "max",
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: "max",
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: "min",
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: "multipleOf",
      value,
      message: errorUtil.toString(message)
    });
  }
  finite(message) {
    return this._addCheck({
      kind: "finite",
      message: errorUtil.toString(message)
    });
  }
  safe(message) {
    return this._addCheck({
      kind: "min",
      inclusive: true,
      value: Number.MIN_SAFE_INTEGER,
      message: errorUtil.toString(message)
    })._addCheck({
      kind: "max",
      inclusive: true,
      value: Number.MAX_SAFE_INTEGER,
      message: errorUtil.toString(message)
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
  get isInt() {
    return !!this._def.checks.find((ch) => ch.kind === "int" || ch.kind === "multipleOf" && util.isInteger(ch.value));
  }
  get isFinite() {
    let max = null;
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "finite" || ch.kind === "int" || ch.kind === "multipleOf") {
        return true;
      } else if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      } else if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return Number.isFinite(min) && Number.isFinite(max);
  }
};
ZodNumber.create = (params) => {
  return new ZodNumber({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodNumber,
    coerce: params?.coerce || false,
    ...processCreateParams(params)
  });
};
var ZodBigInt = class _ZodBigInt extends ZodType {
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
  }
  _parse(input) {
    if (this._def.coerce) {
      try {
        input.data = BigInt(input.data);
      } catch {
        return this._getInvalidInput(input);
      }
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.bigint) {
      return this._getInvalidInput(input);
    }
    let ctx = void 0;
    const status = new ParseStatus();
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
        if (tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            type: "bigint",
            minimum: check.value,
            inclusive: check.inclusive,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
        if (tooBig) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            type: "bigint",
            maximum: check.value,
            inclusive: check.inclusive,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "multipleOf") {
        if (input.data % check.value !== BigInt(0)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_multiple_of,
            multipleOf: check.value,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  _getInvalidInput(input) {
    const ctx = this._getOrReturnCtx(input);
    addIssueToContext(ctx, {
      code: ZodIssueCode.invalid_type,
      expected: ZodParsedType.bigint,
      received: ctx.parsedType
    });
    return INVALID;
  }
  gte(value, message) {
    return this.setLimit("min", value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit("min", value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit("max", value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit("max", value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new _ZodBigInt({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message)
        }
      ]
    });
  }
  _addCheck(check) {
    return new _ZodBigInt({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  positive(message) {
    return this._addCheck({
      kind: "min",
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  negative(message) {
    return this._addCheck({
      kind: "max",
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: "max",
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: "min",
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: "multipleOf",
      value,
      message: errorUtil.toString(message)
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
};
ZodBigInt.create = (params) => {
  return new ZodBigInt({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodBigInt,
    coerce: params?.coerce ?? false,
    ...processCreateParams(params)
  });
};
var ZodBoolean = class extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = Boolean(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.boolean) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.boolean,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodBoolean.create = (params) => {
  return new ZodBoolean({
    typeName: ZodFirstPartyTypeKind.ZodBoolean,
    coerce: params?.coerce || false,
    ...processCreateParams(params)
  });
};
var ZodDate = class _ZodDate extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = new Date(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.date) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.date,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    if (Number.isNaN(input.data.getTime())) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_date
      });
      return INVALID;
    }
    const status = new ParseStatus();
    let ctx = void 0;
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        if (input.data.getTime() < check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            message: check.message,
            inclusive: true,
            exact: false,
            minimum: check.value,
            type: "date"
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        if (input.data.getTime() > check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            message: check.message,
            inclusive: true,
            exact: false,
            maximum: check.value,
            type: "date"
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return {
      status: status.value,
      value: new Date(input.data.getTime())
    };
  }
  _addCheck(check) {
    return new _ZodDate({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  min(minDate, message) {
    return this._addCheck({
      kind: "min",
      value: minDate.getTime(),
      message: errorUtil.toString(message)
    });
  }
  max(maxDate, message) {
    return this._addCheck({
      kind: "max",
      value: maxDate.getTime(),
      message: errorUtil.toString(message)
    });
  }
  get minDate() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min != null ? new Date(min) : null;
  }
  get maxDate() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max != null ? new Date(max) : null;
  }
};
ZodDate.create = (params) => {
  return new ZodDate({
    checks: [],
    coerce: params?.coerce || false,
    typeName: ZodFirstPartyTypeKind.ZodDate,
    ...processCreateParams(params)
  });
};
var ZodSymbol = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.symbol) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.symbol,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodSymbol.create = (params) => {
  return new ZodSymbol({
    typeName: ZodFirstPartyTypeKind.ZodSymbol,
    ...processCreateParams(params)
  });
};
var ZodUndefined = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.undefined) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.undefined,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodUndefined.create = (params) => {
  return new ZodUndefined({
    typeName: ZodFirstPartyTypeKind.ZodUndefined,
    ...processCreateParams(params)
  });
};
var ZodNull = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.null) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.null,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodNull.create = (params) => {
  return new ZodNull({
    typeName: ZodFirstPartyTypeKind.ZodNull,
    ...processCreateParams(params)
  });
};
var ZodAny = class extends ZodType {
  constructor() {
    super(...arguments);
    this._any = true;
  }
  _parse(input) {
    return OK(input.data);
  }
};
ZodAny.create = (params) => {
  return new ZodAny({
    typeName: ZodFirstPartyTypeKind.ZodAny,
    ...processCreateParams(params)
  });
};
var ZodUnknown = class extends ZodType {
  constructor() {
    super(...arguments);
    this._unknown = true;
  }
  _parse(input) {
    return OK(input.data);
  }
};
ZodUnknown.create = (params) => {
  return new ZodUnknown({
    typeName: ZodFirstPartyTypeKind.ZodUnknown,
    ...processCreateParams(params)
  });
};
var ZodNever = class extends ZodType {
  _parse(input) {
    const ctx = this._getOrReturnCtx(input);
    addIssueToContext(ctx, {
      code: ZodIssueCode.invalid_type,
      expected: ZodParsedType.never,
      received: ctx.parsedType
    });
    return INVALID;
  }
};
ZodNever.create = (params) => {
  return new ZodNever({
    typeName: ZodFirstPartyTypeKind.ZodNever,
    ...processCreateParams(params)
  });
};
var ZodVoid = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.undefined) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.void,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodVoid.create = (params) => {
  return new ZodVoid({
    typeName: ZodFirstPartyTypeKind.ZodVoid,
    ...processCreateParams(params)
  });
};
var ZodArray = class _ZodArray extends ZodType {
  _parse(input) {
    const { ctx, status } = this._processInputParams(input);
    const def = this._def;
    if (ctx.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.array,
        received: ctx.parsedType
      });
      return INVALID;
    }
    if (def.exactLength !== null) {
      const tooBig = ctx.data.length > def.exactLength.value;
      const tooSmall = ctx.data.length < def.exactLength.value;
      if (tooBig || tooSmall) {
        addIssueToContext(ctx, {
          code: tooBig ? ZodIssueCode.too_big : ZodIssueCode.too_small,
          minimum: tooSmall ? def.exactLength.value : void 0,
          maximum: tooBig ? def.exactLength.value : void 0,
          type: "array",
          inclusive: true,
          exact: true,
          message: def.exactLength.message
        });
        status.dirty();
      }
    }
    if (def.minLength !== null) {
      if (ctx.data.length < def.minLength.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_small,
          minimum: def.minLength.value,
          type: "array",
          inclusive: true,
          exact: false,
          message: def.minLength.message
        });
        status.dirty();
      }
    }
    if (def.maxLength !== null) {
      if (ctx.data.length > def.maxLength.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_big,
          maximum: def.maxLength.value,
          type: "array",
          inclusive: true,
          exact: false,
          message: def.maxLength.message
        });
        status.dirty();
      }
    }
    if (ctx.common.async) {
      return Promise.all([...ctx.data].map((item, i) => {
        return def.type._parseAsync(new ParseInputLazyPath(ctx, item, ctx.path, i));
      })).then((result2) => {
        return ParseStatus.mergeArray(status, result2);
      });
    }
    const result = [...ctx.data].map((item, i) => {
      return def.type._parseSync(new ParseInputLazyPath(ctx, item, ctx.path, i));
    });
    return ParseStatus.mergeArray(status, result);
  }
  get element() {
    return this._def.type;
  }
  min(minLength, message) {
    return new _ZodArray({
      ...this._def,
      minLength: { value: minLength, message: errorUtil.toString(message) }
    });
  }
  max(maxLength, message) {
    return new _ZodArray({
      ...this._def,
      maxLength: { value: maxLength, message: errorUtil.toString(message) }
    });
  }
  length(len, message) {
    return new _ZodArray({
      ...this._def,
      exactLength: { value: len, message: errorUtil.toString(message) }
    });
  }
  nonempty(message) {
    return this.min(1, message);
  }
};
ZodArray.create = (schema, params) => {
  return new ZodArray({
    type: schema,
    minLength: null,
    maxLength: null,
    exactLength: null,
    typeName: ZodFirstPartyTypeKind.ZodArray,
    ...processCreateParams(params)
  });
};
function deepPartialify(schema) {
  if (schema instanceof ZodObject) {
    const newShape = {};
    for (const key in schema.shape) {
      const fieldSchema = schema.shape[key];
      newShape[key] = ZodOptional.create(deepPartialify(fieldSchema));
    }
    return new ZodObject({
      ...schema._def,
      shape: () => newShape
    });
  } else if (schema instanceof ZodArray) {
    return new ZodArray({
      ...schema._def,
      type: deepPartialify(schema.element)
    });
  } else if (schema instanceof ZodOptional) {
    return ZodOptional.create(deepPartialify(schema.unwrap()));
  } else if (schema instanceof ZodNullable) {
    return ZodNullable.create(deepPartialify(schema.unwrap()));
  } else if (schema instanceof ZodTuple) {
    return ZodTuple.create(schema.items.map((item) => deepPartialify(item)));
  } else {
    return schema;
  }
}
var ZodObject = class _ZodObject extends ZodType {
  constructor() {
    super(...arguments);
    this._cached = null;
    this.nonstrict = this.passthrough;
    this.augment = this.extend;
  }
  _getCached() {
    if (this._cached !== null)
      return this._cached;
    const shape = this._def.shape();
    const keys = util.objectKeys(shape);
    this._cached = { shape, keys };
    return this._cached;
  }
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.object) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    const { status, ctx } = this._processInputParams(input);
    const { shape, keys: shapeKeys } = this._getCached();
    const extraKeys = [];
    if (!(this._def.catchall instanceof ZodNever && this._def.unknownKeys === "strip")) {
      for (const key in ctx.data) {
        if (!shapeKeys.includes(key)) {
          extraKeys.push(key);
        }
      }
    }
    const pairs = [];
    for (const key of shapeKeys) {
      const keyValidator = shape[key];
      const value = ctx.data[key];
      pairs.push({
        key: { status: "valid", value: key },
        value: keyValidator._parse(new ParseInputLazyPath(ctx, value, ctx.path, key)),
        alwaysSet: key in ctx.data
      });
    }
    if (this._def.catchall instanceof ZodNever) {
      const unknownKeys = this._def.unknownKeys;
      if (unknownKeys === "passthrough") {
        for (const key of extraKeys) {
          pairs.push({
            key: { status: "valid", value: key },
            value: { status: "valid", value: ctx.data[key] }
          });
        }
      } else if (unknownKeys === "strict") {
        if (extraKeys.length > 0) {
          addIssueToContext(ctx, {
            code: ZodIssueCode.unrecognized_keys,
            keys: extraKeys
          });
          status.dirty();
        }
      } else if (unknownKeys === "strip") {
      } else {
        throw new Error(`Internal ZodObject error: invalid unknownKeys value.`);
      }
    } else {
      const catchall = this._def.catchall;
      for (const key of extraKeys) {
        const value = ctx.data[key];
        pairs.push({
          key: { status: "valid", value: key },
          value: catchall._parse(
            new ParseInputLazyPath(ctx, value, ctx.path, key)
            //, ctx.child(key), value, getParsedType(value)
          ),
          alwaysSet: key in ctx.data
        });
      }
    }
    if (ctx.common.async) {
      return Promise.resolve().then(async () => {
        const syncPairs = [];
        for (const pair of pairs) {
          const key = await pair.key;
          const value = await pair.value;
          syncPairs.push({
            key,
            value,
            alwaysSet: pair.alwaysSet
          });
        }
        return syncPairs;
      }).then((syncPairs) => {
        return ParseStatus.mergeObjectSync(status, syncPairs);
      });
    } else {
      return ParseStatus.mergeObjectSync(status, pairs);
    }
  }
  get shape() {
    return this._def.shape();
  }
  strict(message) {
    errorUtil.errToObj;
    return new _ZodObject({
      ...this._def,
      unknownKeys: "strict",
      ...message !== void 0 ? {
        errorMap: (issue, ctx) => {
          const defaultError = this._def.errorMap?.(issue, ctx).message ?? ctx.defaultError;
          if (issue.code === "unrecognized_keys")
            return {
              message: errorUtil.errToObj(message).message ?? defaultError
            };
          return {
            message: defaultError
          };
        }
      } : {}
    });
  }
  strip() {
    return new _ZodObject({
      ...this._def,
      unknownKeys: "strip"
    });
  }
  passthrough() {
    return new _ZodObject({
      ...this._def,
      unknownKeys: "passthrough"
    });
  }
  // const AugmentFactory =
  //   <Def extends ZodObjectDef>(def: Def) =>
  //   <Augmentation extends ZodRawShape>(
  //     augmentation: Augmentation
  //   ): ZodObject<
  //     extendShape<ReturnType<Def["shape"]>, Augmentation>,
  //     Def["unknownKeys"],
  //     Def["catchall"]
  //   > => {
  //     return new ZodObject({
  //       ...def,
  //       shape: () => ({
  //         ...def.shape(),
  //         ...augmentation,
  //       }),
  //     }) as any;
  //   };
  extend(augmentation) {
    return new _ZodObject({
      ...this._def,
      shape: () => ({
        ...this._def.shape(),
        ...augmentation
      })
    });
  }
  /**
   * Prior to zod@1.0.12 there was a bug in the
   * inferred type of merged objects. Please
   * upgrade if you are experiencing issues.
   */
  merge(merging) {
    const merged = new _ZodObject({
      unknownKeys: merging._def.unknownKeys,
      catchall: merging._def.catchall,
      shape: () => ({
        ...this._def.shape(),
        ...merging._def.shape()
      }),
      typeName: ZodFirstPartyTypeKind.ZodObject
    });
    return merged;
  }
  // merge<
  //   Incoming extends AnyZodObject,
  //   Augmentation extends Incoming["shape"],
  //   NewOutput extends {
  //     [k in keyof Augmentation | keyof Output]: k extends keyof Augmentation
  //       ? Augmentation[k]["_output"]
  //       : k extends keyof Output
  //       ? Output[k]
  //       : never;
  //   },
  //   NewInput extends {
  //     [k in keyof Augmentation | keyof Input]: k extends keyof Augmentation
  //       ? Augmentation[k]["_input"]
  //       : k extends keyof Input
  //       ? Input[k]
  //       : never;
  //   }
  // >(
  //   merging: Incoming
  // ): ZodObject<
  //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
  //   Incoming["_def"]["unknownKeys"],
  //   Incoming["_def"]["catchall"],
  //   NewOutput,
  //   NewInput
  // > {
  //   const merged: any = new ZodObject({
  //     unknownKeys: merging._def.unknownKeys,
  //     catchall: merging._def.catchall,
  //     shape: () =>
  //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
  //     typeName: ZodFirstPartyTypeKind.ZodObject,
  //   }) as any;
  //   return merged;
  // }
  setKey(key, schema) {
    return this.augment({ [key]: schema });
  }
  // merge<Incoming extends AnyZodObject>(
  //   merging: Incoming
  // ): //ZodObject<T & Incoming["_shape"], UnknownKeys, Catchall> = (merging) => {
  // ZodObject<
  //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
  //   Incoming["_def"]["unknownKeys"],
  //   Incoming["_def"]["catchall"]
  // > {
  //   // const mergedShape = objectUtil.mergeShapes(
  //   //   this._def.shape(),
  //   //   merging._def.shape()
  //   // );
  //   const merged: any = new ZodObject({
  //     unknownKeys: merging._def.unknownKeys,
  //     catchall: merging._def.catchall,
  //     shape: () =>
  //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
  //     typeName: ZodFirstPartyTypeKind.ZodObject,
  //   }) as any;
  //   return merged;
  // }
  catchall(index) {
    return new _ZodObject({
      ...this._def,
      catchall: index
    });
  }
  pick(mask) {
    const shape = {};
    for (const key of util.objectKeys(mask)) {
      if (mask[key] && this.shape[key]) {
        shape[key] = this.shape[key];
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => shape
    });
  }
  omit(mask) {
    const shape = {};
    for (const key of util.objectKeys(this.shape)) {
      if (!mask[key]) {
        shape[key] = this.shape[key];
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => shape
    });
  }
  /**
   * @deprecated
   */
  deepPartial() {
    return deepPartialify(this);
  }
  partial(mask) {
    const newShape = {};
    for (const key of util.objectKeys(this.shape)) {
      const fieldSchema = this.shape[key];
      if (mask && !mask[key]) {
        newShape[key] = fieldSchema;
      } else {
        newShape[key] = fieldSchema.optional();
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => newShape
    });
  }
  required(mask) {
    const newShape = {};
    for (const key of util.objectKeys(this.shape)) {
      if (mask && !mask[key]) {
        newShape[key] = this.shape[key];
      } else {
        const fieldSchema = this.shape[key];
        let newField = fieldSchema;
        while (newField instanceof ZodOptional) {
          newField = newField._def.innerType;
        }
        newShape[key] = newField;
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => newShape
    });
  }
  keyof() {
    return createZodEnum(util.objectKeys(this.shape));
  }
};
ZodObject.create = (shape, params) => {
  return new ZodObject({
    shape: () => shape,
    unknownKeys: "strip",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
ZodObject.strictCreate = (shape, params) => {
  return new ZodObject({
    shape: () => shape,
    unknownKeys: "strict",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
ZodObject.lazycreate = (shape, params) => {
  return new ZodObject({
    shape,
    unknownKeys: "strip",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
var ZodUnion = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const options = this._def.options;
    function handleResults(results) {
      for (const result of results) {
        if (result.result.status === "valid") {
          return result.result;
        }
      }
      for (const result of results) {
        if (result.result.status === "dirty") {
          ctx.common.issues.push(...result.ctx.common.issues);
          return result.result;
        }
      }
      const unionErrors = results.map((result) => new ZodError(result.ctx.common.issues));
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union,
        unionErrors
      });
      return INVALID;
    }
    if (ctx.common.async) {
      return Promise.all(options.map(async (option) => {
        const childCtx = {
          ...ctx,
          common: {
            ...ctx.common,
            issues: []
          },
          parent: null
        };
        return {
          result: await option._parseAsync({
            data: ctx.data,
            path: ctx.path,
            parent: childCtx
          }),
          ctx: childCtx
        };
      })).then(handleResults);
    } else {
      let dirty = void 0;
      const issues = [];
      for (const option of options) {
        const childCtx = {
          ...ctx,
          common: {
            ...ctx.common,
            issues: []
          },
          parent: null
        };
        const result = option._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: childCtx
        });
        if (result.status === "valid") {
          return result;
        } else if (result.status === "dirty" && !dirty) {
          dirty = { result, ctx: childCtx };
        }
        if (childCtx.common.issues.length) {
          issues.push(childCtx.common.issues);
        }
      }
      if (dirty) {
        ctx.common.issues.push(...dirty.ctx.common.issues);
        return dirty.result;
      }
      const unionErrors = issues.map((issues2) => new ZodError(issues2));
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union,
        unionErrors
      });
      return INVALID;
    }
  }
  get options() {
    return this._def.options;
  }
};
ZodUnion.create = (types, params) => {
  return new ZodUnion({
    options: types,
    typeName: ZodFirstPartyTypeKind.ZodUnion,
    ...processCreateParams(params)
  });
};
var getDiscriminator = (type) => {
  if (type instanceof ZodLazy) {
    return getDiscriminator(type.schema);
  } else if (type instanceof ZodEffects) {
    return getDiscriminator(type.innerType());
  } else if (type instanceof ZodLiteral) {
    return [type.value];
  } else if (type instanceof ZodEnum) {
    return type.options;
  } else if (type instanceof ZodNativeEnum) {
    return util.objectValues(type.enum);
  } else if (type instanceof ZodDefault) {
    return getDiscriminator(type._def.innerType);
  } else if (type instanceof ZodUndefined) {
    return [void 0];
  } else if (type instanceof ZodNull) {
    return [null];
  } else if (type instanceof ZodOptional) {
    return [void 0, ...getDiscriminator(type.unwrap())];
  } else if (type instanceof ZodNullable) {
    return [null, ...getDiscriminator(type.unwrap())];
  } else if (type instanceof ZodBranded) {
    return getDiscriminator(type.unwrap());
  } else if (type instanceof ZodReadonly) {
    return getDiscriminator(type.unwrap());
  } else if (type instanceof ZodCatch) {
    return getDiscriminator(type._def.innerType);
  } else {
    return [];
  }
};
var ZodDiscriminatedUnion = class _ZodDiscriminatedUnion extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.object) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const discriminator = this.discriminator;
    const discriminatorValue = ctx.data[discriminator];
    const option = this.optionsMap.get(discriminatorValue);
    if (!option) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union_discriminator,
        options: Array.from(this.optionsMap.keys()),
        path: [discriminator]
      });
      return INVALID;
    }
    if (ctx.common.async) {
      return option._parseAsync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
    } else {
      return option._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
    }
  }
  get discriminator() {
    return this._def.discriminator;
  }
  get options() {
    return this._def.options;
  }
  get optionsMap() {
    return this._def.optionsMap;
  }
  /**
   * The constructor of the discriminated union schema. Its behaviour is very similar to that of the normal z.union() constructor.
   * However, it only allows a union of objects, all of which need to share a discriminator property. This property must
   * have a different value for each object in the union.
   * @param discriminator the name of the discriminator property
   * @param types an array of object schemas
   * @param params
   */
  static create(discriminator, options, params) {
    const optionsMap = /* @__PURE__ */ new Map();
    for (const type of options) {
      const discriminatorValues = getDiscriminator(type.shape[discriminator]);
      if (!discriminatorValues.length) {
        throw new Error(`A discriminator value for key \`${discriminator}\` could not be extracted from all schema options`);
      }
      for (const value of discriminatorValues) {
        if (optionsMap.has(value)) {
          throw new Error(`Discriminator property ${String(discriminator)} has duplicate value ${String(value)}`);
        }
        optionsMap.set(value, type);
      }
    }
    return new _ZodDiscriminatedUnion({
      typeName: ZodFirstPartyTypeKind.ZodDiscriminatedUnion,
      discriminator,
      options,
      optionsMap,
      ...processCreateParams(params)
    });
  }
};
function mergeValues(a, b) {
  const aType = getParsedType(a);
  const bType = getParsedType(b);
  if (a === b) {
    return { valid: true, data: a };
  } else if (aType === ZodParsedType.object && bType === ZodParsedType.object) {
    const bKeys = util.objectKeys(b);
    const sharedKeys = util.objectKeys(a).filter((key) => bKeys.indexOf(key) !== -1);
    const newObj = { ...a, ...b };
    for (const key of sharedKeys) {
      const sharedValue = mergeValues(a[key], b[key]);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newObj[key] = sharedValue.data;
    }
    return { valid: true, data: newObj };
  } else if (aType === ZodParsedType.array && bType === ZodParsedType.array) {
    if (a.length !== b.length) {
      return { valid: false };
    }
    const newArray = [];
    for (let index = 0; index < a.length; index++) {
      const itemA = a[index];
      const itemB = b[index];
      const sharedValue = mergeValues(itemA, itemB);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newArray.push(sharedValue.data);
    }
    return { valid: true, data: newArray };
  } else if (aType === ZodParsedType.date && bType === ZodParsedType.date && +a === +b) {
    return { valid: true, data: a };
  } else {
    return { valid: false };
  }
}
var ZodIntersection = class extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    const handleParsed = (parsedLeft, parsedRight) => {
      if (isAborted(parsedLeft) || isAborted(parsedRight)) {
        return INVALID;
      }
      const merged = mergeValues(parsedLeft.value, parsedRight.value);
      if (!merged.valid) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.invalid_intersection_types
        });
        return INVALID;
      }
      if (isDirty(parsedLeft) || isDirty(parsedRight)) {
        status.dirty();
      }
      return { status: status.value, value: merged.data };
    };
    if (ctx.common.async) {
      return Promise.all([
        this._def.left._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        }),
        this._def.right._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        })
      ]).then(([left, right]) => handleParsed(left, right));
    } else {
      return handleParsed(this._def.left._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      }), this._def.right._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      }));
    }
  }
};
ZodIntersection.create = (left, right, params) => {
  return new ZodIntersection({
    left,
    right,
    typeName: ZodFirstPartyTypeKind.ZodIntersection,
    ...processCreateParams(params)
  });
};
var ZodTuple = class _ZodTuple extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.array,
        received: ctx.parsedType
      });
      return INVALID;
    }
    if (ctx.data.length < this._def.items.length) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.too_small,
        minimum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: "array"
      });
      return INVALID;
    }
    const rest = this._def.rest;
    if (!rest && ctx.data.length > this._def.items.length) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.too_big,
        maximum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: "array"
      });
      status.dirty();
    }
    const items = [...ctx.data].map((item, itemIndex) => {
      const schema = this._def.items[itemIndex] || this._def.rest;
      if (!schema)
        return null;
      return schema._parse(new ParseInputLazyPath(ctx, item, ctx.path, itemIndex));
    }).filter((x) => !!x);
    if (ctx.common.async) {
      return Promise.all(items).then((results) => {
        return ParseStatus.mergeArray(status, results);
      });
    } else {
      return ParseStatus.mergeArray(status, items);
    }
  }
  get items() {
    return this._def.items;
  }
  rest(rest) {
    return new _ZodTuple({
      ...this._def,
      rest
    });
  }
};
ZodTuple.create = (schemas, params) => {
  if (!Array.isArray(schemas)) {
    throw new Error("You must pass an array of schemas to z.tuple([ ... ])");
  }
  return new ZodTuple({
    items: schemas,
    typeName: ZodFirstPartyTypeKind.ZodTuple,
    rest: null,
    ...processCreateParams(params)
  });
};
var ZodRecord = class _ZodRecord extends ZodType {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.object) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const pairs = [];
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    for (const key in ctx.data) {
      pairs.push({
        key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, key)),
        value: valueType._parse(new ParseInputLazyPath(ctx, ctx.data[key], ctx.path, key)),
        alwaysSet: key in ctx.data
      });
    }
    if (ctx.common.async) {
      return ParseStatus.mergeObjectAsync(status, pairs);
    } else {
      return ParseStatus.mergeObjectSync(status, pairs);
    }
  }
  get element() {
    return this._def.valueType;
  }
  static create(first, second, third) {
    if (second instanceof ZodType) {
      return new _ZodRecord({
        keyType: first,
        valueType: second,
        typeName: ZodFirstPartyTypeKind.ZodRecord,
        ...processCreateParams(third)
      });
    }
    return new _ZodRecord({
      keyType: ZodString.create(),
      valueType: first,
      typeName: ZodFirstPartyTypeKind.ZodRecord,
      ...processCreateParams(second)
    });
  }
};
var ZodMap = class extends ZodType {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.map) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.map,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    const pairs = [...ctx.data.entries()].map(([key, value], index) => {
      return {
        key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, [index, "key"])),
        value: valueType._parse(new ParseInputLazyPath(ctx, value, ctx.path, [index, "value"]))
      };
    });
    if (ctx.common.async) {
      const finalMap = /* @__PURE__ */ new Map();
      return Promise.resolve().then(async () => {
        for (const pair of pairs) {
          const key = await pair.key;
          const value = await pair.value;
          if (key.status === "aborted" || value.status === "aborted") {
            return INVALID;
          }
          if (key.status === "dirty" || value.status === "dirty") {
            status.dirty();
          }
          finalMap.set(key.value, value.value);
        }
        return { status: status.value, value: finalMap };
      });
    } else {
      const finalMap = /* @__PURE__ */ new Map();
      for (const pair of pairs) {
        const key = pair.key;
        const value = pair.value;
        if (key.status === "aborted" || value.status === "aborted") {
          return INVALID;
        }
        if (key.status === "dirty" || value.status === "dirty") {
          status.dirty();
        }
        finalMap.set(key.value, value.value);
      }
      return { status: status.value, value: finalMap };
    }
  }
};
ZodMap.create = (keyType, valueType, params) => {
  return new ZodMap({
    valueType,
    keyType,
    typeName: ZodFirstPartyTypeKind.ZodMap,
    ...processCreateParams(params)
  });
};
var ZodSet = class _ZodSet extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.set) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.set,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const def = this._def;
    if (def.minSize !== null) {
      if (ctx.data.size < def.minSize.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_small,
          minimum: def.minSize.value,
          type: "set",
          inclusive: true,
          exact: false,
          message: def.minSize.message
        });
        status.dirty();
      }
    }
    if (def.maxSize !== null) {
      if (ctx.data.size > def.maxSize.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_big,
          maximum: def.maxSize.value,
          type: "set",
          inclusive: true,
          exact: false,
          message: def.maxSize.message
        });
        status.dirty();
      }
    }
    const valueType = this._def.valueType;
    function finalizeSet(elements2) {
      const parsedSet = /* @__PURE__ */ new Set();
      for (const element of elements2) {
        if (element.status === "aborted")
          return INVALID;
        if (element.status === "dirty")
          status.dirty();
        parsedSet.add(element.value);
      }
      return { status: status.value, value: parsedSet };
    }
    const elements = [...ctx.data.values()].map((item, i) => valueType._parse(new ParseInputLazyPath(ctx, item, ctx.path, i)));
    if (ctx.common.async) {
      return Promise.all(elements).then((elements2) => finalizeSet(elements2));
    } else {
      return finalizeSet(elements);
    }
  }
  min(minSize, message) {
    return new _ZodSet({
      ...this._def,
      minSize: { value: minSize, message: errorUtil.toString(message) }
    });
  }
  max(maxSize, message) {
    return new _ZodSet({
      ...this._def,
      maxSize: { value: maxSize, message: errorUtil.toString(message) }
    });
  }
  size(size, message) {
    return this.min(size, message).max(size, message);
  }
  nonempty(message) {
    return this.min(1, message);
  }
};
ZodSet.create = (valueType, params) => {
  return new ZodSet({
    valueType,
    minSize: null,
    maxSize: null,
    typeName: ZodFirstPartyTypeKind.ZodSet,
    ...processCreateParams(params)
  });
};
var ZodFunction = class _ZodFunction extends ZodType {
  constructor() {
    super(...arguments);
    this.validate = this.implement;
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.function) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.function,
        received: ctx.parsedType
      });
      return INVALID;
    }
    function makeArgsIssue(args, error) {
      return makeIssue({
        data: args,
        path: ctx.path,
        errorMaps: [ctx.common.contextualErrorMap, ctx.schemaErrorMap, getErrorMap(), en_default].filter((x) => !!x),
        issueData: {
          code: ZodIssueCode.invalid_arguments,
          argumentsError: error
        }
      });
    }
    function makeReturnsIssue(returns, error) {
      return makeIssue({
        data: returns,
        path: ctx.path,
        errorMaps: [ctx.common.contextualErrorMap, ctx.schemaErrorMap, getErrorMap(), en_default].filter((x) => !!x),
        issueData: {
          code: ZodIssueCode.invalid_return_type,
          returnTypeError: error
        }
      });
    }
    const params = { errorMap: ctx.common.contextualErrorMap };
    const fn = ctx.data;
    if (this._def.returns instanceof ZodPromise) {
      const me = this;
      return OK(async function(...args) {
        const error = new ZodError([]);
        const parsedArgs = await me._def.args.parseAsync(args, params).catch((e) => {
          error.addIssue(makeArgsIssue(args, e));
          throw error;
        });
        const result = await Reflect.apply(fn, this, parsedArgs);
        const parsedReturns = await me._def.returns._def.type.parseAsync(result, params).catch((e) => {
          error.addIssue(makeReturnsIssue(result, e));
          throw error;
        });
        return parsedReturns;
      });
    } else {
      const me = this;
      return OK(function(...args) {
        const parsedArgs = me._def.args.safeParse(args, params);
        if (!parsedArgs.success) {
          throw new ZodError([makeArgsIssue(args, parsedArgs.error)]);
        }
        const result = Reflect.apply(fn, this, parsedArgs.data);
        const parsedReturns = me._def.returns.safeParse(result, params);
        if (!parsedReturns.success) {
          throw new ZodError([makeReturnsIssue(result, parsedReturns.error)]);
        }
        return parsedReturns.data;
      });
    }
  }
  parameters() {
    return this._def.args;
  }
  returnType() {
    return this._def.returns;
  }
  args(...items) {
    return new _ZodFunction({
      ...this._def,
      args: ZodTuple.create(items).rest(ZodUnknown.create())
    });
  }
  returns(returnType) {
    return new _ZodFunction({
      ...this._def,
      returns: returnType
    });
  }
  implement(func) {
    const validatedFunc = this.parse(func);
    return validatedFunc;
  }
  strictImplement(func) {
    const validatedFunc = this.parse(func);
    return validatedFunc;
  }
  static create(args, returns, params) {
    return new _ZodFunction({
      args: args ? args : ZodTuple.create([]).rest(ZodUnknown.create()),
      returns: returns || ZodUnknown.create(),
      typeName: ZodFirstPartyTypeKind.ZodFunction,
      ...processCreateParams(params)
    });
  }
};
var ZodLazy = class extends ZodType {
  get schema() {
    return this._def.getter();
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const lazySchema = this._def.getter();
    return lazySchema._parse({ data: ctx.data, path: ctx.path, parent: ctx });
  }
};
ZodLazy.create = (getter, params) => {
  return new ZodLazy({
    getter,
    typeName: ZodFirstPartyTypeKind.ZodLazy,
    ...processCreateParams(params)
  });
};
var ZodLiteral = class extends ZodType {
  _parse(input) {
    if (input.data !== this._def.value) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_literal,
        expected: this._def.value
      });
      return INVALID;
    }
    return { status: "valid", value: input.data };
  }
  get value() {
    return this._def.value;
  }
};
ZodLiteral.create = (value, params) => {
  return new ZodLiteral({
    value,
    typeName: ZodFirstPartyTypeKind.ZodLiteral,
    ...processCreateParams(params)
  });
};
function createZodEnum(values, params) {
  return new ZodEnum({
    values,
    typeName: ZodFirstPartyTypeKind.ZodEnum,
    ...processCreateParams(params)
  });
}
var ZodEnum = class _ZodEnum extends ZodType {
  _parse(input) {
    if (typeof input.data !== "string") {
      const ctx = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx, {
        expected: util.joinValues(expectedValues),
        received: ctx.parsedType,
        code: ZodIssueCode.invalid_type
      });
      return INVALID;
    }
    if (!this._cache) {
      this._cache = new Set(this._def.values);
    }
    if (!this._cache.has(input.data)) {
      const ctx = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_enum_value,
        options: expectedValues
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get options() {
    return this._def.values;
  }
  get enum() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  get Values() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  get Enum() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  extract(values, newDef = this._def) {
    return _ZodEnum.create(values, {
      ...this._def,
      ...newDef
    });
  }
  exclude(values, newDef = this._def) {
    return _ZodEnum.create(this.options.filter((opt) => !values.includes(opt)), {
      ...this._def,
      ...newDef
    });
  }
};
ZodEnum.create = createZodEnum;
var ZodNativeEnum = class extends ZodType {
  _parse(input) {
    const nativeEnumValues = util.getValidEnumValues(this._def.values);
    const ctx = this._getOrReturnCtx(input);
    if (ctx.parsedType !== ZodParsedType.string && ctx.parsedType !== ZodParsedType.number) {
      const expectedValues = util.objectValues(nativeEnumValues);
      addIssueToContext(ctx, {
        expected: util.joinValues(expectedValues),
        received: ctx.parsedType,
        code: ZodIssueCode.invalid_type
      });
      return INVALID;
    }
    if (!this._cache) {
      this._cache = new Set(util.getValidEnumValues(this._def.values));
    }
    if (!this._cache.has(input.data)) {
      const expectedValues = util.objectValues(nativeEnumValues);
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_enum_value,
        options: expectedValues
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get enum() {
    return this._def.values;
  }
};
ZodNativeEnum.create = (values, params) => {
  return new ZodNativeEnum({
    values,
    typeName: ZodFirstPartyTypeKind.ZodNativeEnum,
    ...processCreateParams(params)
  });
};
var ZodPromise = class extends ZodType {
  unwrap() {
    return this._def.type;
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.promise && ctx.common.async === false) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.promise,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const promisified = ctx.parsedType === ZodParsedType.promise ? ctx.data : Promise.resolve(ctx.data);
    return OK(promisified.then((data) => {
      return this._def.type.parseAsync(data, {
        path: ctx.path,
        errorMap: ctx.common.contextualErrorMap
      });
    }));
  }
};
ZodPromise.create = (schema, params) => {
  return new ZodPromise({
    type: schema,
    typeName: ZodFirstPartyTypeKind.ZodPromise,
    ...processCreateParams(params)
  });
};
var ZodEffects = class extends ZodType {
  innerType() {
    return this._def.schema;
  }
  sourceType() {
    return this._def.schema._def.typeName === ZodFirstPartyTypeKind.ZodEffects ? this._def.schema.sourceType() : this._def.schema;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    const effect = this._def.effect || null;
    const checkCtx = {
      addIssue: (arg) => {
        addIssueToContext(ctx, arg);
        if (arg.fatal) {
          status.abort();
        } else {
          status.dirty();
        }
      },
      get path() {
        return ctx.path;
      }
    };
    checkCtx.addIssue = checkCtx.addIssue.bind(checkCtx);
    if (effect.type === "preprocess") {
      const processed = effect.transform(ctx.data, checkCtx);
      if (ctx.common.async) {
        return Promise.resolve(processed).then(async (processed2) => {
          if (status.value === "aborted")
            return INVALID;
          const result = await this._def.schema._parseAsync({
            data: processed2,
            path: ctx.path,
            parent: ctx
          });
          if (result.status === "aborted")
            return INVALID;
          if (result.status === "dirty")
            return DIRTY(result.value);
          if (status.value === "dirty")
            return DIRTY(result.value);
          return result;
        });
      } else {
        if (status.value === "aborted")
          return INVALID;
        const result = this._def.schema._parseSync({
          data: processed,
          path: ctx.path,
          parent: ctx
        });
        if (result.status === "aborted")
          return INVALID;
        if (result.status === "dirty")
          return DIRTY(result.value);
        if (status.value === "dirty")
          return DIRTY(result.value);
        return result;
      }
    }
    if (effect.type === "refinement") {
      const executeRefinement = (acc) => {
        const result = effect.refinement(acc, checkCtx);
        if (ctx.common.async) {
          return Promise.resolve(result);
        }
        if (result instanceof Promise) {
          throw new Error("Async refinement encountered during synchronous parse operation. Use .parseAsync instead.");
        }
        return acc;
      };
      if (ctx.common.async === false) {
        const inner = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (inner.status === "aborted")
          return INVALID;
        if (inner.status === "dirty")
          status.dirty();
        executeRefinement(inner.value);
        return { status: status.value, value: inner.value };
      } else {
        return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((inner) => {
          if (inner.status === "aborted")
            return INVALID;
          if (inner.status === "dirty")
            status.dirty();
          return executeRefinement(inner.value).then(() => {
            return { status: status.value, value: inner.value };
          });
        });
      }
    }
    if (effect.type === "transform") {
      if (ctx.common.async === false) {
        const base = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (!isValid(base))
          return INVALID;
        const result = effect.transform(base.value, checkCtx);
        if (result instanceof Promise) {
          throw new Error(`Asynchronous transform encountered during synchronous parse operation. Use .parseAsync instead.`);
        }
        return { status: status.value, value: result };
      } else {
        return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((base) => {
          if (!isValid(base))
            return INVALID;
          return Promise.resolve(effect.transform(base.value, checkCtx)).then((result) => ({
            status: status.value,
            value: result
          }));
        });
      }
    }
    util.assertNever(effect);
  }
};
ZodEffects.create = (schema, effect, params) => {
  return new ZodEffects({
    schema,
    typeName: ZodFirstPartyTypeKind.ZodEffects,
    effect,
    ...processCreateParams(params)
  });
};
ZodEffects.createWithPreprocess = (preprocess, schema, params) => {
  return new ZodEffects({
    schema,
    effect: { type: "preprocess", transform: preprocess },
    typeName: ZodFirstPartyTypeKind.ZodEffects,
    ...processCreateParams(params)
  });
};
var ZodOptional = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType === ZodParsedType.undefined) {
      return OK(void 0);
    }
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodOptional.create = (type, params) => {
  return new ZodOptional({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodOptional,
    ...processCreateParams(params)
  });
};
var ZodNullable = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType === ZodParsedType.null) {
      return OK(null);
    }
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodNullable.create = (type, params) => {
  return new ZodNullable({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodNullable,
    ...processCreateParams(params)
  });
};
var ZodDefault = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    let data = ctx.data;
    if (ctx.parsedType === ZodParsedType.undefined) {
      data = this._def.defaultValue();
    }
    return this._def.innerType._parse({
      data,
      path: ctx.path,
      parent: ctx
    });
  }
  removeDefault() {
    return this._def.innerType;
  }
};
ZodDefault.create = (type, params) => {
  return new ZodDefault({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodDefault,
    defaultValue: typeof params.default === "function" ? params.default : () => params.default,
    ...processCreateParams(params)
  });
};
var ZodCatch = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const newCtx = {
      ...ctx,
      common: {
        ...ctx.common,
        issues: []
      }
    };
    const result = this._def.innerType._parse({
      data: newCtx.data,
      path: newCtx.path,
      parent: {
        ...newCtx
      }
    });
    if (isAsync(result)) {
      return result.then((result2) => {
        return {
          status: "valid",
          value: result2.status === "valid" ? result2.value : this._def.catchValue({
            get error() {
              return new ZodError(newCtx.common.issues);
            },
            input: newCtx.data
          })
        };
      });
    } else {
      return {
        status: "valid",
        value: result.status === "valid" ? result.value : this._def.catchValue({
          get error() {
            return new ZodError(newCtx.common.issues);
          },
          input: newCtx.data
        })
      };
    }
  }
  removeCatch() {
    return this._def.innerType;
  }
};
ZodCatch.create = (type, params) => {
  return new ZodCatch({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodCatch,
    catchValue: typeof params.catch === "function" ? params.catch : () => params.catch,
    ...processCreateParams(params)
  });
};
var ZodNaN = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.nan) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.nan,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return { status: "valid", value: input.data };
  }
};
ZodNaN.create = (params) => {
  return new ZodNaN({
    typeName: ZodFirstPartyTypeKind.ZodNaN,
    ...processCreateParams(params)
  });
};
var BRAND = /* @__PURE__ */ Symbol("zod_brand");
var ZodBranded = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const data = ctx.data;
    return this._def.type._parse({
      data,
      path: ctx.path,
      parent: ctx
    });
  }
  unwrap() {
    return this._def.type;
  }
};
var ZodPipeline = class _ZodPipeline extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.common.async) {
      const handleAsync = async () => {
        const inResult = await this._def.in._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (inResult.status === "aborted")
          return INVALID;
        if (inResult.status === "dirty") {
          status.dirty();
          return DIRTY(inResult.value);
        } else {
          return this._def.out._parseAsync({
            data: inResult.value,
            path: ctx.path,
            parent: ctx
          });
        }
      };
      return handleAsync();
    } else {
      const inResult = this._def.in._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
      if (inResult.status === "aborted")
        return INVALID;
      if (inResult.status === "dirty") {
        status.dirty();
        return {
          status: "dirty",
          value: inResult.value
        };
      } else {
        return this._def.out._parseSync({
          data: inResult.value,
          path: ctx.path,
          parent: ctx
        });
      }
    }
  }
  static create(a, b) {
    return new _ZodPipeline({
      in: a,
      out: b,
      typeName: ZodFirstPartyTypeKind.ZodPipeline
    });
  }
};
var ZodReadonly = class extends ZodType {
  _parse(input) {
    const result = this._def.innerType._parse(input);
    const freeze = (data) => {
      if (isValid(data)) {
        data.value = Object.freeze(data.value);
      }
      return data;
    };
    return isAsync(result) ? result.then((data) => freeze(data)) : freeze(result);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodReadonly.create = (type, params) => {
  return new ZodReadonly({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodReadonly,
    ...processCreateParams(params)
  });
};
function cleanParams(params, data) {
  const p = typeof params === "function" ? params(data) : typeof params === "string" ? { message: params } : params;
  const p2 = typeof p === "string" ? { message: p } : p;
  return p2;
}
function custom(check, _params = {}, fatal) {
  if (check)
    return ZodAny.create().superRefine((data, ctx) => {
      const r = check(data);
      if (r instanceof Promise) {
        return r.then((r2) => {
          if (!r2) {
            const params = cleanParams(_params, data);
            const _fatal = params.fatal ?? fatal ?? true;
            ctx.addIssue({ code: "custom", ...params, fatal: _fatal });
          }
        });
      }
      if (!r) {
        const params = cleanParams(_params, data);
        const _fatal = params.fatal ?? fatal ?? true;
        ctx.addIssue({ code: "custom", ...params, fatal: _fatal });
      }
      return;
    });
  return ZodAny.create();
}
var late = {
  object: ZodObject.lazycreate
};
var ZodFirstPartyTypeKind;
(function(ZodFirstPartyTypeKind2) {
  ZodFirstPartyTypeKind2["ZodString"] = "ZodString";
  ZodFirstPartyTypeKind2["ZodNumber"] = "ZodNumber";
  ZodFirstPartyTypeKind2["ZodNaN"] = "ZodNaN";
  ZodFirstPartyTypeKind2["ZodBigInt"] = "ZodBigInt";
  ZodFirstPartyTypeKind2["ZodBoolean"] = "ZodBoolean";
  ZodFirstPartyTypeKind2["ZodDate"] = "ZodDate";
  ZodFirstPartyTypeKind2["ZodSymbol"] = "ZodSymbol";
  ZodFirstPartyTypeKind2["ZodUndefined"] = "ZodUndefined";
  ZodFirstPartyTypeKind2["ZodNull"] = "ZodNull";
  ZodFirstPartyTypeKind2["ZodAny"] = "ZodAny";
  ZodFirstPartyTypeKind2["ZodUnknown"] = "ZodUnknown";
  ZodFirstPartyTypeKind2["ZodNever"] = "ZodNever";
  ZodFirstPartyTypeKind2["ZodVoid"] = "ZodVoid";
  ZodFirstPartyTypeKind2["ZodArray"] = "ZodArray";
  ZodFirstPartyTypeKind2["ZodObject"] = "ZodObject";
  ZodFirstPartyTypeKind2["ZodUnion"] = "ZodUnion";
  ZodFirstPartyTypeKind2["ZodDiscriminatedUnion"] = "ZodDiscriminatedUnion";
  ZodFirstPartyTypeKind2["ZodIntersection"] = "ZodIntersection";
  ZodFirstPartyTypeKind2["ZodTuple"] = "ZodTuple";
  ZodFirstPartyTypeKind2["ZodRecord"] = "ZodRecord";
  ZodFirstPartyTypeKind2["ZodMap"] = "ZodMap";
  ZodFirstPartyTypeKind2["ZodSet"] = "ZodSet";
  ZodFirstPartyTypeKind2["ZodFunction"] = "ZodFunction";
  ZodFirstPartyTypeKind2["ZodLazy"] = "ZodLazy";
  ZodFirstPartyTypeKind2["ZodLiteral"] = "ZodLiteral";
  ZodFirstPartyTypeKind2["ZodEnum"] = "ZodEnum";
  ZodFirstPartyTypeKind2["ZodEffects"] = "ZodEffects";
  ZodFirstPartyTypeKind2["ZodNativeEnum"] = "ZodNativeEnum";
  ZodFirstPartyTypeKind2["ZodOptional"] = "ZodOptional";
  ZodFirstPartyTypeKind2["ZodNullable"] = "ZodNullable";
  ZodFirstPartyTypeKind2["ZodDefault"] = "ZodDefault";
  ZodFirstPartyTypeKind2["ZodCatch"] = "ZodCatch";
  ZodFirstPartyTypeKind2["ZodPromise"] = "ZodPromise";
  ZodFirstPartyTypeKind2["ZodBranded"] = "ZodBranded";
  ZodFirstPartyTypeKind2["ZodPipeline"] = "ZodPipeline";
  ZodFirstPartyTypeKind2["ZodReadonly"] = "ZodReadonly";
})(ZodFirstPartyTypeKind || (ZodFirstPartyTypeKind = {}));
var instanceOfType = (cls, params = {
  message: `Input not instance of ${cls.name}`
}) => custom((data) => data instanceof cls, params);
var stringType = ZodString.create;
var numberType = ZodNumber.create;
var nanType = ZodNaN.create;
var bigIntType = ZodBigInt.create;
var booleanType = ZodBoolean.create;
var dateType = ZodDate.create;
var symbolType = ZodSymbol.create;
var undefinedType = ZodUndefined.create;
var nullType = ZodNull.create;
var anyType = ZodAny.create;
var unknownType = ZodUnknown.create;
var neverType = ZodNever.create;
var voidType = ZodVoid.create;
var arrayType = ZodArray.create;
var objectType = ZodObject.create;
var strictObjectType = ZodObject.strictCreate;
var unionType = ZodUnion.create;
var discriminatedUnionType = ZodDiscriminatedUnion.create;
var intersectionType = ZodIntersection.create;
var tupleType = ZodTuple.create;
var recordType = ZodRecord.create;
var mapType = ZodMap.create;
var setType = ZodSet.create;
var functionType = ZodFunction.create;
var lazyType = ZodLazy.create;
var literalType = ZodLiteral.create;
var enumType = ZodEnum.create;
var nativeEnumType = ZodNativeEnum.create;
var promiseType = ZodPromise.create;
var effectsType = ZodEffects.create;
var optionalType = ZodOptional.create;
var nullableType = ZodNullable.create;
var preprocessType = ZodEffects.createWithPreprocess;
var pipelineType = ZodPipeline.create;
var ostring = () => stringType().optional();
var onumber = () => numberType().optional();
var oboolean = () => booleanType().optional();
var coerce = {
  string: ((arg) => ZodString.create({ ...arg, coerce: true })),
  number: ((arg) => ZodNumber.create({ ...arg, coerce: true })),
  boolean: ((arg) => ZodBoolean.create({
    ...arg,
    coerce: true
  })),
  bigint: ((arg) => ZodBigInt.create({ ...arg, coerce: true })),
  date: ((arg) => ZodDate.create({ ...arg, coerce: true }))
};
var NEVER = INVALID;

// ../../packages/schema/src/index.ts
var hexHashSchema = external_exports.string().regex(/^0x[a-fA-F0-9]{64}$/);
var isoDateSchema = external_exports.string().datetime();
var traceSpanSchema = external_exports.object({
  spanId: external_exports.string().min(1),
  tool: external_exports.string().min(1),
  model: external_exports.string().min(1),
  startedAt: isoDateSchema,
  endedAt: isoDateSchema,
  promptHash: hexHashSchema,
  responseHash: hexHashSchema,
  promptExcerpt: external_exports.string().optional(),
  responseExcerpt: external_exports.string().optional(),
  filesMentioned: external_exports.array(external_exports.string()).default([]),
  artifactsProduced: external_exports.array(external_exports.string()).default([]),
  metadata: external_exports.record(external_exports.unknown()).default({})
}).strict();
function canonicalStringify(value) {
  return JSON.stringify(normalizeForCanonicalJson(value));
}
function canonicalHash(value) {
  const bytes = new TextEncoder().encode(canonicalStringify(value));
  return `0x${bytesToHex(sha256(bytes))}`;
}
function validateTraceSpans(input) {
  return external_exports.array(traceSpanSchema).parse(input);
}
function hashPublicLedgerBundle(bundle) {
  return canonicalHash(publicLedgerHashPayload(bundle));
}
function createPublicLedgerBundle(bundle) {
  const withPendingHash = {
    ...bundle,
    manifest: {
      ...bundle.manifest,
      publicBundleHash: "pending"
    }
  };
  const publicBundleHash = hashPublicLedgerBundle(withPendingHash);
  return {
    ...bundle,
    manifest: {
      ...bundle.manifest,
      publicBundleHash
    }
  };
}
function publicLedgerHashPayload(bundle) {
  return {
    manifest: {
      ...bundle.manifest,
      publicBundleHash: "pending",
      anchors: []
    },
    publicGraph: bundle.publicGraph,
    verifierSummary: bundle.verifierSummary,
    evidenceBadges: bundle.evidenceBadges
  };
}
function normalizeForCanonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeForCanonicalJson(item));
  }
  if (typeof value === "object") {
    const object = value;
    const normalized = {};
    for (const key of Object.keys(object).sort()) {
      if (object[key] !== void 0) {
        normalized[key] = normalizeForCanonicalJson(object[key]);
      }
    }
    return normalized;
  }
  return String(value);
}

// ../../packages/graph/src/index.ts
function buildArtifactGraph(input) {
  const nodes = /* @__PURE__ */ new Map();
  const edges = /* @__PURE__ */ new Map();
  for (const trace of sortBy(input.traces, (trace2) => trace2.spanId)) {
    addNode(nodes, {
      id: traceNodeId(trace.spanId),
      type: "TraceSpan",
      label: `${trace.tool} / ${trace.model}`,
      data: {
        spanId: trace.spanId,
        tool: trace.tool,
        model: trace.model,
        startedAt: trace.startedAt,
        endedAt: trace.endedAt,
        promptHash: trace.promptHash,
        responseHash: trace.responseHash,
        filesMentioned: trace.filesMentioned,
        artifactsProduced: trace.artifactsProduced,
        metadata: redactTraceMetadata(trace.metadata)
      }
    });
    for (const artifactPath of trace.artifactsProduced.sort()) {
      const artifactId = artifactNodeId(artifactPath);
      addNode(nodes, {
        id: artifactId,
        type: "PatchArtifact",
        label: artifactPath,
        data: { path: artifactPath }
      });
      addEdge(edges, traceNodeId(trace.spanId), artifactId, "produced");
    }
  }
  for (const snapshot of sortBy(input.snapshots, (snapshot2) => `${snapshot2.createdAt}:${snapshot2.commit}`)) {
    const commitId = commitNodeId(snapshot.commit);
    addNode(nodes, {
      id: commitId,
      type: "CommitSnapshot",
      label: snapshot.commit,
      data: redactSnapshot(snapshot)
    });
    for (const file of sortBy(snapshot.files, (file2) => file2.path)) {
      const fileId = fileNodeId(file.path, snapshot.commit);
      addNode(nodes, {
        id: fileId,
        type: "FileVersion",
        label: file.path,
        data: {
          path: file.path,
          hash: file.hash,
          size: file.size,
          commit: snapshot.commit
        }
      });
      addEdge(edges, fileId, commitId, "included_in");
      for (const trace of input.traces) {
        if (trace.artifactsProduced.includes(file.path) || trace.filesMentioned.includes(file.path)) {
          addEdge(edges, artifactNodeId(file.path), fileId, "modified");
        }
      }
    }
  }
  for (const claim of sortBy(input.claims, (claim2) => claim2.claimId)) {
    const claimId = claimNodeId(claim.claimId);
    addNode(nodes, {
      id: claimId,
      type: "Claim",
      label: claim.text,
      data: claim
    });
    const evidence = claim.evidence ?? "structural";
    if (evidence === "external") continue;
    for (const snapshot of input.snapshots) {
      for (const file of snapshot.files) {
        if (!selectorsMatchFile(claim.selectors, file.path)) continue;
        if (evidence === "trace" && !fileIsTraceBacked(input.traces, file.path)) continue;
        addEdge(edges, fileNodeId(file.path, snapshot.commit), claimId, "supports", {
          matchedSelectors: claim.selectors.filter((selector) => file.path.toLowerCase().includes(selector.toLowerCase())),
          traceBacked: evidence === "trace" ? true : void 0
        });
      }
    }
  }
  const graphWithoutHash = {
    nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...edges.values()].sort((a, b) => a.id.localeCompare(b.id)),
    redactionPolicy: "private-by-default",
    canonicalHash: "pending"
  };
  return {
    ...graphWithoutHash,
    canonicalHash: canonicalHash(graphWithoutHash)
  };
}
var SENSITIVE_TRACE_META = /* @__PURE__ */ new Set(["sessionId", "agentId", "tokens"]);
function redactTraceMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") return {};
  const safe = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!SENSITIVE_TRACE_META.has(key)) safe[key] = value;
  }
  return safe;
}
function redactSnapshot(snapshot) {
  const pkg = snapshot.packageMetadata;
  const name = pkg && typeof pkg === "object" ? pkg.name : void 0;
  return { ...snapshot, packageMetadata: name ? { name } : {} };
}
function addNode(nodes, node) {
  if (!nodes.has(node.id)) {
    nodes.set(node.id, node);
  }
}
function addEdge(edges, from, to, type, data) {
  const id = `${from}->${type}->${to}`;
  if (!edges.has(id)) {
    edges.set(id, { id, from, to, type, data });
  }
}
function selectorsMatchFile(selectors, filePath) {
  const normalized = filePath.toLowerCase();
  return selectors.some((selector) => normalized.includes(selector.toLowerCase()));
}
function fileIsTraceBacked(traces, filePath) {
  return traces.some(
    (t) => t.artifactsProduced.includes(filePath) || t.filesMentioned.includes(filePath)
  );
}
function sortBy(items, selector) {
  return [...items].sort((a, b) => selector(a).localeCompare(selector(b)));
}
function traceNodeId(spanId) {
  return `trace:${spanId}`;
}
function artifactNodeId(path) {
  return `artifact:${path}`;
}
function fileNodeId(path, commit) {
  return `file:${path}@${commit}`;
}
function commitNodeId(commit) {
  return `commit:${commit}`;
}
function claimNodeId(claimId) {
  return `claim:${claimId}`;
}

// src/collect.ts
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
var AI_TOUCH_TOOLS = /* @__PURE__ */ new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
function sha256Hex(text) {
  return `0x${createHash("sha256").update(text, "utf8").digest("hex")}`;
}
function extractText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (block && typeof block === "object") {
      const b = block;
      if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    }
  }
  return parts.join("\n");
}
function* toolUses(content) {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block && typeof block === "object") {
      const b = block;
      if (b.type === "tool_use" && typeof b.name === "string") {
        const filePath = b.input?.file_path;
        if (typeof filePath === "string" && filePath.length > 0) {
          yield { name: b.name, filePath };
        }
      }
    }
  }
}
function slugFromSessionId(sessionId) {
  const cleaned = sessionId.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `claude-code:${cleaned || "session"}`;
}
function buildSpanFromAgent(records, options) {
  const repoRoot = options.repoRoot;
  const prefix = repoRoot.endsWith("/") ? repoRoot : `${repoRoot}/`;
  const agentId = options.agentId;
  let sessionId;
  const cwds = /* @__PURE__ */ new Set();
  const modelCounts = /* @__PURE__ */ new Map();
  let first;
  let last;
  const userTexts = [];
  const assistantTexts = [];
  const produced = /* @__PURE__ */ new Set();
  let inputTokens = 0;
  let outputTokens = 0;
  const underRepo = (absPath) => absPath === repoRoot || absPath.startsWith(prefix);
  for (const rec of records) {
    if (rec.sessionId && !sessionId) sessionId = rec.sessionId;
    if (typeof rec.cwd === "string" && rec.cwd.length > 0) cwds.add(rec.cwd);
    const ts = rec.timestamp;
    if (typeof ts === "string" && ts.length > 0) {
      if (first === void 0 || ts < first) first = ts;
      if (last === void 0 || ts > last) last = ts;
    }
    const type = rec.type;
    const message = rec.message;
    if (type === "user") {
      const text = extractText(message?.content);
      if (text.trim().length > 0) userTexts.push(text);
    } else if (type === "assistant" && message) {
      const model2 = message.model;
      if (typeof model2 === "string" && model2.length > 0 && model2 !== "<synthetic>") {
        modelCounts.set(model2, (modelCounts.get(model2) ?? 0) + 1);
      }
      const text = extractText(message.content);
      if (text.trim().length > 0) assistantTexts.push(text);
      const usage = message.usage;
      if (usage) {
        inputTokens += usage.input_tokens ?? 0;
        outputTokens += usage.output_tokens ?? 0;
      }
      for (const { name, filePath } of toolUses(message.content)) {
        const abs = resolve(filePath);
        if (!underRepo(abs)) continue;
        if (!options.fileExists(abs)) continue;
        const rel = relative(repoRoot, abs).replaceAll("\\", "/");
        if (AI_TOUCH_TOOLS.has(name)) produced.add(rel);
      }
    }
  }
  let ranInRepo = false;
  for (const c of cwds) {
    if (c === repoRoot || c.startsWith(prefix)) {
      ranInRepo = true;
      break;
    }
  }
  if (!ranInRepo) return void 0;
  if (!sessionId && !agentId) return void 0;
  let model;
  let best = -1;
  for (const [m, count] of modelCounts) {
    if (count > best) {
      best = count;
      model = m;
    }
  }
  if (!model) return void 0;
  if (first === void 0) return void 0;
  let endedAt = last ?? first;
  if (endedAt > options.now) endedAt = options.now;
  let startedAt = first;
  if (startedAt > endedAt) startedAt = endedAt;
  const promptHash = sha256Hex(userTexts.join("\n"));
  const responseHash = sha256Hex(assistantTexts.join("\n"));
  const metadata = {
    source: "claude-code-collect",
    sessionId: sessionId ?? agentId ?? "unknown"
  };
  if (agentId) metadata.agentId = agentId;
  if (inputTokens > 0 || outputTokens > 0) {
    metadata.tokens = { input: inputTokens, output: outputTokens };
  }
  const identifier = agentId ?? sessionId ?? "unknown";
  const span = {
    spanId: slugFromSessionId(identifier),
    tool: "claude-code",
    model,
    startedAt,
    endedAt,
    promptHash,
    responseHash,
    filesMentioned: [],
    artifactsProduced: [...produced].sort(),
    metadata
  };
  if (options.includeExcerpts) {
    const redact = (s) => s.replace(/\s+/g, " ").trim().slice(0, 200);
    if (userTexts.length) span.promptExcerpt = redact(userTexts.join(" "));
    if (assistantTexts.length) span.responseExcerpt = redact(assistantTexts.join(" "));
  }
  return span;
}
function parseJsonl(content) {
  const records = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
    }
  }
  return records;
}
async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
async function collectClaudeCode(params) {
  const home = params.home ?? homedir();
  const projectsDir = join(home, ".claude", "projects");
  const scannedDirs = [projectsDir];
  const result = {
    spans: [],
    sessionsScanned: 0,
    sessionsMatched: 0,
    scannedDirs
  };
  if (!await exists(projectsDir)) return result;
  const fileExistsCache = /* @__PURE__ */ new Map();
  const fileExists = (absPath) => {
    const cached = fileExistsCache.get(absPath);
    if (cached !== void 0) return cached;
    let ok = false;
    try {
      ok = existsSync(absPath);
    } catch {
      ok = false;
    }
    fileExistsCache.set(absPath, ok);
    return ok;
  };
  async function gatherJsonl(dir) {
    const paths = [];
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return paths;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        paths.push(...await gatherJsonl(abs));
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        if (entry.name !== "journal.jsonl") {
          paths.push(abs);
        }
      }
    }
    return paths;
  }
  const groups = /* @__PURE__ */ new Map();
  const topEntries = await readdir(projectsDir, { withFileTypes: true });
  for (const entry of topEntries) {
    const dirOrFile = join(projectsDir, entry.name);
    let filePaths = [];
    if (entry.isDirectory()) {
      filePaths = await gatherJsonl(dirOrFile);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl") && entry.name !== "journal.jsonl") {
      filePaths = [dirOrFile];
    }
    for (const filePath of filePaths) {
      let content;
      try {
        content = await readFile(filePath, "utf8");
      } catch {
        continue;
      }
      const records = parseJsonl(content);
      for (const rec of records) {
        const aid = typeof rec.agentId === "string" && rec.agentId.length > 0 ? rec.agentId : void 0;
        const key = aid ?? filePath;
        const existing = groups.get(key);
        if (existing) {
          existing.records.push(rec);
        } else {
          groups.set(key, { records: [rec], agentId: aid });
        }
      }
    }
  }
  for (const { records, agentId } of groups.values()) {
    result.sessionsScanned += 1;
    const span = buildSpanFromAgent(records, {
      repoRoot: params.repoRoot,
      fileExists,
      now: params.now,
      includeExcerpts: params.includeExcerpts,
      agentId
    });
    if (span) {
      result.sessionsMatched += 1;
      result.spans.push(span);
    }
  }
  result.spans.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.spanId.localeCompare(b.spanId));
  return result;
}

// src/codex-collect.ts
import { createHash as createHash2 } from "node:crypto";
import { existsSync as existsSync2 } from "node:fs";
import { readFile as readFile2, readdir as readdir2, stat as stat2 } from "node:fs/promises";
import { homedir as homedir2 } from "node:os";
import { isAbsolute, join as join2, relative as relative2, resolve as resolve2 } from "node:path";
function sha256Hex2(text) {
  return `0x${createHash2("sha256").update(text, "utf8").digest("hex")}`;
}
var FILE_OP_RE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/;
var MOVE_RE = /^\*\*\* Move to: (.+)$/;
function patchFiles(input) {
  if (typeof input !== "string") return [];
  const files = [];
  for (const raw of input.split("\n")) {
    const line = raw.trim();
    const m = FILE_OP_RE.exec(line);
    if (m) {
      files.push(m[1].trim());
      continue;
    }
    const mv = MOVE_RE.exec(line);
    if (mv) files.push(mv[1].trim());
  }
  return files;
}
function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (block && typeof block === "object") {
      const b = block;
      if (typeof b.text === "string" && b.text.length > 0) parts.push(b.text);
    }
  }
  return parts.join("\n");
}
function buildSpanFromCodexSession(records, options) {
  const repoRoot = options.repoRoot;
  const prefix = repoRoot.endsWith("/") ? repoRoot : `${repoRoot}/`;
  let cwd;
  let sessionId;
  const modelCounts = /* @__PURE__ */ new Map();
  let first;
  let last;
  const userTexts = [];
  const assistantTexts = [];
  const produced = /* @__PURE__ */ new Set();
  for (const rec of records) {
    const ts = rec.timestamp;
    if (typeof ts === "string" && ts.length > 0) {
      if (first === void 0 || ts < first) first = ts;
      if (last === void 0 || ts > last) last = ts;
    }
    const p = rec.payload ?? {};
    if (rec.type === "session_meta") {
      if (typeof p.cwd === "string" && p.cwd.length > 0) cwd = p.cwd;
      if (typeof p.id === "string" && p.id.length > 0) sessionId = p.id;
    } else if (rec.type === "turn_context") {
      if (typeof p.model === "string" && p.model.length > 0) {
        modelCounts.set(p.model, (modelCounts.get(p.model) ?? 0) + 1);
      }
    } else if (rec.type === "response_item") {
      if (p.type === "message") {
        const text = messageText(p.content);
        if (text.trim().length > 0) {
          if (p.role === "assistant") assistantTexts.push(text);
          else if (p.role === "user") userTexts.push(text);
        }
      } else if (p.type === "custom_tool_call" && p.name === "apply_patch") {
        const base = cwd ?? repoRoot;
        for (const rel of patchFiles(p.input)) {
          const abs = isAbsolute(rel) ? rel : resolve2(base, rel);
          if (abs !== repoRoot && !abs.startsWith(prefix)) continue;
          if (!options.fileExists(abs)) continue;
          const r = relative2(repoRoot, abs).replaceAll("\\", "/");
          if (r && !r.startsWith("..")) produced.add(r);
        }
      }
    }
  }
  if (!cwd || cwd !== repoRoot && !cwd.startsWith(prefix)) return void 0;
  if (!sessionId) return void 0;
  let model;
  let best = -1;
  for (const [m, count] of modelCounts) {
    if (count > best) {
      best = count;
      model = m;
    }
  }
  if (!model) return void 0;
  if (first === void 0) return void 0;
  let endedAt = last ?? first;
  if (endedAt > options.now) endedAt = options.now;
  let startedAt = first;
  if (startedAt > endedAt) startedAt = endedAt;
  const span = {
    spanId: `codex:${sessionId}`,
    tool: "codex",
    model,
    startedAt,
    endedAt,
    promptHash: sha256Hex2(userTexts.join("\n")),
    responseHash: sha256Hex2(assistantTexts.join("\n")),
    filesMentioned: [],
    artifactsProduced: [...produced].sort(),
    metadata: { source: "codex-collect", sessionId }
  };
  if (options.includeExcerpts) {
    const redact = (s) => s.replace(/\s+/g, " ").trim().slice(0, 200);
    if (userTexts.length) span.promptExcerpt = redact(userTexts.join(" "));
    if (assistantTexts.length) span.responseExcerpt = redact(assistantTexts.join(" "));
  }
  return span;
}
function parseCodexJsonl(content) {
  const records = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
    }
  }
  return records;
}
async function exists2(path) {
  try {
    await stat2(path);
    return true;
  } catch {
    return false;
  }
}
async function collectCodex(params) {
  const home = params.home ?? homedir2();
  const sessionsDir = join2(home, ".codex", "sessions");
  const scannedDirs = [sessionsDir];
  const result = {
    spans: [],
    sessionsScanned: 0,
    sessionsMatched: 0,
    scannedDirs
  };
  if (!await exists2(sessionsDir)) return result;
  const fileExistsCache = /* @__PURE__ */ new Map();
  const fileExists = (absPath) => {
    const cached = fileExistsCache.get(absPath);
    if (cached !== void 0) return cached;
    let ok = false;
    try {
      ok = existsSync2(absPath);
    } catch {
      ok = false;
    }
    fileExistsCache.set(absPath, ok);
    return ok;
  };
  async function gatherJsonl(dir) {
    const paths = [];
    let entries;
    try {
      entries = await readdir2(dir, { withFileTypes: true });
    } catch {
      return paths;
    }
    for (const entry of entries) {
      const abs = join2(dir, entry.name);
      if (entry.isDirectory()) {
        paths.push(...await gatherJsonl(abs));
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        paths.push(abs);
      }
    }
    return paths;
  }
  const files = await gatherJsonl(sessionsDir);
  for (const filePath of files) {
    result.sessionsScanned += 1;
    let content;
    try {
      content = await readFile2(filePath, "utf8");
    } catch {
      continue;
    }
    const records = parseCodexJsonl(content);
    const span = buildSpanFromCodexSession(records, {
      repoRoot: params.repoRoot,
      fileExists,
      now: params.now,
      includeExcerpts: params.includeExcerpts
    });
    if (span) {
      result.sessionsMatched += 1;
      result.spans.push(span);
    }
  }
  result.spans.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.spanId.localeCompare(b.spanId));
  return result;
}

// src/private-packet.ts
function leafHash(leaf) {
  return canonicalHash({ kind: leaf.kind, id: leaf.id, content: leaf.content });
}
var EMPTY_MERKLE_ROOT = canonicalHash("vibetrace.private-packet.empty");
function redactionToRegExp(pattern) {
  let source = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    const next = pattern[i + 1];
    if (char === "*" && next === "*") {
      source += ".*";
      i += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}
function idMatchesPattern(id, pattern) {
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3);
    return id === prefix || id.startsWith(`${prefix}/`);
  }
  const re = redactionToRegExp(pattern);
  if (re.test(id)) return true;
  const colonIdx = id.indexOf(":");
  if (colonIdx !== -1) {
    const bare = id.slice(colonIdx + 1);
    if (re.test(bare)) return true;
  }
  return false;
}
function applyRedactions(leaves, patterns) {
  if (patterns.length === 0) return [...leaves];
  return leaves.filter((leaf) => !patterns.some((p) => idMatchesPattern(leaf.id, p)));
}
function assemblePrivatePacket(input) {
  const claimIds = [...input.claimIds].sort();
  const leaves = [
    { kind: "public-bundle-hash", id: "public-bundle-hash", content: input.publicBundleHash },
    { kind: "snapshot-hash", id: "snapshot-hash", content: input.snapshotHash },
    { kind: "claim-list", id: "claim-list", content: JSON.stringify(claimIds) }
  ];
  for (const ex of input.fileExcerpts ?? []) {
    leaves.push({ kind: "file-excerpt", id: `file:${ex.path}`, content: ex.content });
  }
  for (const d of input.diffs ?? []) {
    leaves.push({ kind: "diff", id: `diff:${d.path}`, content: d.content });
  }
  if (typeof input.testOutput === "string" && input.testOutput.length > 0) {
    leaves.push({ kind: "test-output", id: "test-output", content: input.testOutput });
  }
  const redacted = applyRedactions(leaves, input.redact ?? []);
  redacted.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  return {
    schemaVersion: "vibetrace.private-packet.v1",
    publicBundleHash: input.publicBundleHash,
    snapshotHash: input.snapshotHash,
    claimIds,
    leaves: redacted,
    evidenceRoot: merkleRoot(redacted.map(leafHash)),
    transport: input.sealedTransportConfirmed ? "sealed" : "trusted-transport"
  };
}
function renderPacketDisclosure(packet) {
  const byKind = (kind) => packet.leaves.filter((l) => l.kind === kind).map((l) => l.id);
  const lines = [];
  lines.push("VibeTrace private packet \u2014 opt-in evidence sealed to the examiner");
  lines.push("  This is sent ONLY to the TEE adjudicator and is NEVER persisted in the public bundle.");
  lines.push(`  Public commitment in the receipt: privateEvidenceRoot = ${packet.evidenceRoot}`);
  lines.push(`  Claims it will judge: ${packet.claimIds.join(", ") || "(none)"}`);
  const excerpts = byKind("file-excerpt");
  lines.push(`  File excerpts (${excerpts.length}): ${excerpts.join(", ") || "(none)"}`);
  const diffs = byKind("diff");
  lines.push(`  Diffs (${diffs.length}): ${diffs.join(", ") || "(none)"}`);
  const tests = byKind("test-output");
  lines.push(`  Test output: ${tests.length ? "included (test-output)" : "(none)"}`);
  if (packet.transport === "sealed") {
    lines.push("  Transport: SEALED \u2014 the packet is encrypted to the enclave; the relayer cannot read it.");
  } else {
    lines.push("  Transport: TRUSTED-TRANSPORT \u2014 sealed enclave encryption is unproven, so the relayer can read this packet.");
    lines.push("  Redact anything you do not want the relayer to see with --redact <glob> (repeatable).");
  }
  return lines;
}
var DEFAULT_EXCERPT_BYTES = 4096;
async function gatherFileExcerpts(paths, read, opts = {}) {
  const maxBytes = opts.maxBytes ?? DEFAULT_EXCERPT_BYTES;
  const out = [];
  for (const path of [...new Set(paths)].sort()) {
    const raw = await read(path);
    if (typeof raw !== "string") continue;
    out.push({ path, content: raw.length > maxBytes ? raw.slice(0, maxBytes) : raw });
  }
  return out;
}
function merkleRoot(leafHashes) {
  if (leafHashes.length === 0) return EMPTY_MERKLE_ROOT;
  let level = [...leafHashes];
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : left;
      const [lo, hi] = left < right ? [left, right] : [right, left];
      next.push(canonicalHash(`${lo}${hi}`));
    }
    level = next;
  }
  return level[0];
}
var EVIDENCE_LEAF_KINDS = /* @__PURE__ */ new Set([
  "file-excerpt",
  "diff",
  "test-output"
]);
function packetCoversClaim(packet, verdict) {
  const evidenceLeafIds = new Set(
    packet.leaves.filter((l) => EVIDENCE_LEAF_KINDS.has(l.kind)).map((l) => l.id)
  );
  return verdict.supportingNodes.some((node) => evidenceLeafIds.has(node));
}
function upgradeVerdictsWithPacket(publicOnly, privateRun, packet) {
  const privateById = new Map(privateRun.map((v) => [v.claimId, v]));
  return publicOnly.map((pub) => {
    const wasAbstained = pub.verdict === "unsupported" && pub.abstainReason === "insufficient-public-evidence";
    if (!wasAbstained) return pub;
    const priv = privateById.get(pub.claimId);
    if (!priv || priv.verdict !== "substantiated") return pub;
    if (!packetCoversClaim(packet, priv)) return pub;
    return priv;
  });
}
function buildPublicSafeVerifierRun(run, opts) {
  const safeVerdicts = (run.verdicts ?? []).filter((v) => opts.allowedClaimIds.has(v.claimId)).map((v) => {
    const d = v.dimensions ?? {};
    return {
      claimId: v.claimId,
      verdict: v.verdict,
      confidence: v.confidence,
      // DROP verdict supportingNodes for private-tier: a hostile/buggy response could inject arbitrary
      // strings (e.g. "diff:SECRET") here, and a prefix filter alone would not stop content. The
      // public-safe file: supporters live on the merged badge (buildPublicSafeBadges); the private
      // evidence is committed via privateEvidenceRoot. So the public verdict carries the word + claimId.
      supportingNodes: [],
      rationale: "Rationale withheld \u2014 derived from private evidence.",
      abstainReason: v.abstainReason ?? null,
      // EXPLICIT dimensions whitelist — pick ONLY the three known enum sub-fields (drops any nested
      // injected field) and coerce each to a valid enum value (drops an injected non-enum string).
      dimensions: {
        relevance: ["strong", "weak", "none"].includes(d.relevance) ? d.relevance : "none",
        sufficiency: ["proportionate", "thin", "absent"].includes(d.sufficiency) ? d.sufficiency : "absent",
        contradiction: ["none", "present"].includes(d.contradiction) ? d.contradiction : "none"
      }
    };
  });
  const a = run.attestation;
  const safeAttestation = a ? {
    scheme: a.scheme,
    // The honest TEE-execution marker MUST survive sanitization so consumers can gate TEE status on
    // it (a private-tier bundle that drops `attests` would be wrongly treated as not-TEE-attested).
    attests: a.attests,
    providerAddress: a.providerAddress,
    signingAddress: a.signingAddress,
    signature: a.signature,
    signedDigest: a.signedDigest,
    // signedText = `responseHash:chatID` (a hash + an opaque id, NOT response content) — kept so
    // consumers can verify hashMessage(signedText) === signedDigest. Distinct from the OMITTED
    // chatSignatureLink, which retrieves the actual response text.
    signedText: a.signedText,
    responseTextHash: a.responseTextHash,
    processResponseValid: a.processResponseValid,
    teeType: a.teeType,
    composeVerificationPassed: a.composeVerificationPassed,
    signerAllMatch: a.signerAllMatch,
    attestationQuoteUri: a.attestationQuoteUri,
    quoteHash: a.quoteHash,
    raDownloadLink: a.raDownloadLink,
    verifiedAt: a.verifiedAt,
    verifiedBy: a.verifiedBy
  } : a;
  return {
    // Structural identity fields — safe (hashes only, no content)
    verifierId: run.verifierId,
    provider: run.provider,
    model: run.model,
    requestHash: run.requestHash,
    responseHash: run.responseHash,
    outputHash: run.outputHash,
    createdAt: run.createdAt,
    // Summary: replace any TEE-generated string (may echo packet content) with a fixed safe message.
    summary: `Private-tier adjudication. Evidence committed to privateEvidenceRoot ${opts.privateEvidenceRoot}.`,
    // Attestation with chatSignatureLink stripped (see above) — crypto-verifiable, no private-text path.
    attestation: safeAttestation,
    // verdictRoot MUST hash the FINAL public-safe verdicts (after allowedClaimIds filtering + scrub),
    // NOT the raw input root — otherwise a re-checker's canonicalHash(verdicts) !== verdictRoot. This is
    // the tamper-hygiene tie for the PUBLISHED verdicts.
    verdictRoot: canonicalHash(safeVerdicts),
    // Tier and root — the only private-evidence fields allowed publicly
    evidenceTier: "private",
    privateEvidenceRoot: opts.privateEvidenceRoot,
    // Verdicts with rationales scrubbed
    verdicts: safeVerdicts
  };
}
function buildPublicSafeBadges(badges, allowedClaimIds) {
  return badges.filter((b) => allowedClaimIds.has(b.claimId)).map((b) => ({
    claimId: b.claimId,
    status: b.status,
    confidence: b.confidence,
    supportingNodes: (b.supportingNodes ?? []).filter((id) => id.startsWith("file:")),
    publicExplanation: "Evidence withheld \u2014 private-tier adjudication (committed via privateEvidenceRoot).",
    provenance: b.provenance,
    verdict: b.verdict
  }));
}

// ../../packages/og/src/index.ts
import { mkdir, readFile as readFile3, writeFile } from "node:fs/promises";
import { join as join3 } from "node:path";
var OG_CHAIN_IDS = /* @__PURE__ */ new Set([16601, 16602]);
function createDevOgAdapters(options) {
  const now = options.now ?? (() => (/* @__PURE__ */ new Date()).toISOString());
  const storageDir = join3(options.workspace, "storage");
  const chainDir = join3(options.workspace, "chain");
  return {
    storage: {
      async uploadJson(value) {
        await mkdir(storageDir, { recursive: true });
        const rootHash = canonicalHash(value);
        await writeFile(join3(storageDir, `${rootHash}.json`), `${canonicalStringify(value)}
`, "utf8");
        return {
          kind: "storage",
          provider: "0g-dev",
          uri: `0g://local/${rootHash}`,
          rootHash,
          createdAt: now()
        };
      },
      async downloadJson(rootHash) {
        const filePath = join3(storageDir, `${rootHash}.json`);
        let raw;
        try {
          raw = await readFile3(filePath, "utf8");
        } catch {
          throw new Error(`0G dev storage has no object for rootHash ${rootHash} at ${filePath}`);
        }
        return JSON.parse(raw);
      }
    },
    chain: {
      async anchorManifest(manifestHash) {
        const createdAt = now();
        const txHash = canonicalHash({ manifestHash, provider: "0g-dev", createdAt });
        await mkdir(chainDir, { recursive: true });
        await writeFile(
          join3(chainDir, `${txHash}.json`),
          `${canonicalStringify({ manifestHash })}
`,
          "utf8"
        );
        return {
          kind: "chain",
          provider: "0g-dev",
          txHash,
          chainId: 16602,
          manifestHash,
          createdAt
        };
      },
      async readManifest(txHash) {
        const filePath = join3(chainDir, `${txHash}.json`);
        let raw;
        try {
          raw = await readFile3(filePath, "utf8");
        } catch {
          throw new Error(`0G dev chain has no calldata for txHash ${txHash} at ${filePath}`);
        }
        const parsed = JSON.parse(raw);
        if (typeof parsed.manifestHash !== "string") {
          throw new Error(`0G dev chain calldata for txHash ${txHash} is malformed`);
        }
        return parsed.manifestHash;
      }
    }
  };
}
function createOgAdaptersFromEnv(options) {
  const env = options.env ?? process.env;
  const mode = env.VIBETRACE_OG_MODE;
  if (mode === "real") {
    return {
      storage: new RealOgStorageAdapter(env, options.now),
      chain: new RealOgChainAdapter(env, options.now)
    };
  }
  if (mode === "real-chain") {
    return {
      storage: createDevOgAdapters(options).storage,
      chain: new RealOgChainAdapter(env, options.now)
    };
  }
  return createDevOgAdapters(options);
}
var RealOgStorageAdapter = class {
  constructor(env, now = () => (/* @__PURE__ */ new Date()).toISOString()) {
    this.env = env;
    this.now = now;
  }
  env;
  now;
  async downloadJson(rootHash) {
    const indexerRpc = this.env.VIBETRACE_0G_STORAGE_INDEXER ?? "https://indexer-storage-testnet-turbo.0g.ai";
    const { Indexer } = await import("@0gfoundation/0g-storage-ts-sdk");
    const indexer = new Indexer(indexerRpc);
    const attempts = Math.max(1, Number(this.env.VIBETRACE_0G_STORAGE_READBACK_ATTEMPTS ?? "8"));
    const delayMs = Math.max(0, Number(this.env.VIBETRACE_0G_STORAGE_READBACK_DELAY_MS ?? "5000"));
    let lastErr = null;
    for (let i = 0; i < attempts; i++) {
      const [blob, downloadErr] = await indexer.downloadToBlob(rootHash);
      if (downloadErr === null) {
        return JSON.parse(await blob.text());
      }
      lastErr = downloadErr;
      if (i < attempts - 1 && delayMs > 0) {
        await new Promise((resolve4) => setTimeout(resolve4, delayMs));
      }
    }
    throw new Error(`0G Storage download error for ${rootHash}: ${lastErr}`);
  }
  async uploadJson(value) {
    const privateKey = requirePublishKey(this.env);
    const rpcUrl = this.env.VIBETRACE_0G_RPC_URL ?? "https://evmrpc-testnet.0g.ai";
    const indexerRpc = this.env.VIBETRACE_0G_STORAGE_INDEXER ?? "https://indexer-storage-testnet-turbo.0g.ai";
    const [{ Indexer, MemData }, { ethers }] = await Promise.all([
      import("@0gfoundation/0g-storage-ts-sdk"),
      import("ethers")
    ]);
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const signer = new ethers.Wallet(privateKey, provider);
    const indexer = new Indexer(indexerRpc);
    const data = new TextEncoder().encode(canonicalStringify(value));
    const memData = new MemData(data);
    const finalityRequired = parseBooleanEnv(this.env.VIBETRACE_0G_STORAGE_FINALITY, false);
    const [tree, treeErr] = await memData.merkleTree();
    if (treeErr !== null) {
      throw new Error(`0G Storage merkle tree error: ${treeErr}`);
    }
    const [tx, uploadErr] = await indexer.upload(memData, rpcUrl, signer, { finalityRequired });
    if (uploadErr !== null) {
      throw new Error(`0G Storage upload error: ${uploadErr}`);
    }
    return {
      kind: "storage",
      provider: "0g-storage",
      uri: `0g://${tx.rootHash ?? tree?.rootHash?.()}`,
      rootHash: tx.rootHash ?? tree?.rootHash?.() ?? canonicalHash(value),
      createdAt: this.now()
    };
  }
};
var RealOgChainAdapter = class {
  constructor(env, now = () => (/* @__PURE__ */ new Date()).toISOString()) {
    this.env = env;
    this.now = now;
  }
  env;
  now;
  async anchorManifest(manifestHash) {
    const privateKey = requirePublishKey(this.env);
    const rpcUrl = this.env.VIBETRACE_0G_RPC_URL ?? "https://evmrpc-testnet.0g.ai";
    const chainId = Number(this.env.VIBETRACE_0G_CHAIN_ID ?? "16602");
    const { ethers } = await import("ethers");
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const network = await provider.getNetwork();
    const actualChainId = Number(network.chainId);
    if (actualChainId !== chainId) {
      throw new Error(`RPC chain id ${actualChainId} does not match expected 0G chain id ${chainId}`);
    }
    if (!OG_CHAIN_IDS.has(actualChainId)) {
      throw new Error(`Chain id ${actualChainId} is not an allowlisted 0G network`);
    }
    const wallet = new ethers.Wallet(privateKey, provider);
    const tx = await wallet.sendTransaction({
      to: wallet.address,
      value: 0n,
      data: manifestHash
    });
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) {
      throw new Error(`0G anchor tx ${tx.hash} did not succeed (status ${receipt?.status ?? "unknown"})`);
    }
    return {
      kind: "chain",
      provider: "0g-chain",
      txHash: tx.hash,
      chainId,
      manifestHash,
      createdAt: this.now()
    };
  }
  async readManifest(txHash, expectedChainId) {
    const rpcUrl = this.env.VIBETRACE_0G_RPC_URL ?? "https://evmrpc-testnet.0g.ai";
    const { ethers } = await import("ethers");
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const network = await provider.getNetwork();
    const actualChainId = Number(network.chainId);
    if (!OG_CHAIN_IDS.has(actualChainId)) {
      throw new Error(`RPC chain id ${actualChainId} is not an allowlisted 0G network`);
    }
    if (expectedChainId != null && actualChainId !== expectedChainId) {
      throw new Error(`RPC chain id ${actualChainId} does not match the bundle's recorded 0G chain id ${expectedChainId}`);
    }
    const tx = await provider.getTransaction(txHash);
    if (!tx) {
      throw new Error(`0G chain tx ${txHash} not found on ${rpcUrl}`);
    }
    return tx.data;
  }
};
function requirePublishKey(env) {
  const publishKey = env.VIBETRACE_0G_PUBLISH_PRIVATE_KEY;
  if (typeof publishKey === "string" && publishKey !== "") {
    return publishKey;
  }
  const legacyKey = env.VIBETRACE_0G_PRIVATE_KEY;
  if (legacyKey) {
    return legacyKey;
  }
  throw new Error(
    "VIBETRACE_0G_PUBLISH_PRIVATE_KEY or VIBETRACE_0G_PRIVATE_KEY is required when VIBETRACE_OG_MODE=real"
  );
}
function parseBooleanEnv(value, fallback) {
  if (value === void 0 || value.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

// ../../packages/verifier/src/merge.ts
var STRUCTURAL_CONFIDENCE = 0.9;
function mergeStatus(hasSupport, verdict) {
  if (!hasSupport) return "unsupported";
  if (!verdict) return "verified";
  switch (verdict.verdict) {
    case "substantiated":
      return "verified";
    // structure + judgment agree
    case "inflated":
      return "partial";
    // linked but oversold
    case "unsupported":
      return "partial";
    // linked but judgment can't back it — flagged, not silently verified
    default:
      return "partial";
  }
}
function explain(status, supportCount, verdict) {
  if (status === "unsupported") {
    return "No public artifact in the ledger currently supports this claim.";
  }
  const artifacts = `${supportCount} public artifact${supportCount === 1 ? "" : "s"}`;
  if (status === "verified" && !verdict) {
    return `${artifacts} support this claim.`;
  }
  if (status === "verified") {
    return `${artifacts} support this claim; the attested examiner judged it substantiated.`;
  }
  const word = verdict?.verdict === "inflated" ? "inflated (oversold)" : "unsupported by the examiner";
  return `${artifacts} link to this claim, but the attested examiner flagged it as ${word}.`;
}
function mergeEvidenceBadge(args) {
  const supportingNodes = [...args.structuralSupport].sort();
  const hasSupport = supportingNodes.length > 0;
  const status = mergeStatus(hasSupport, args.verdict);
  const modelConfidence = args.verdict?.confidence ?? STRUCTURAL_CONFIDENCE;
  const confidence = status === "unsupported" ? 0 : Math.min(STRUCTURAL_CONFIDENCE, modelConfidence);
  const badge = {
    claimId: args.claimId,
    status,
    confidence,
    // Invariant 4: badge.supportingNodes stays FILE-ONLY. The verdict's trace: ids
    // (verdict.supportingNodes) are display/audit-only and are NEVER read here.
    supportingNodes,
    publicExplanation: explain(status, supportingNodes.length, args.verdict),
    provenance: args.verdict ? "structural+attested" : "structural-only"
  };
  if (args.verdict) {
    badge.verdict = args.verdict.verdict;
  }
  return badge;
}
function structuralSupportFor(graph, claimId) {
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  return graph.edges.filter(
    (e) => e.type === "supports" && e.to === claimId && e.from.startsWith("file:") && nodeIds.has(e.from)
  ).map((e) => e.from);
}
function downgradeUnsupportedVerdicts(graph, verdicts) {
  return verdicts.map((v) => {
    if (v.verdict !== "unsupported" && structuralSupportFor(graph, v.claimId).length === 0) {
      return { ...v, verdict: "unsupported", confidence: 0, abstainReason: "insufficient-public-evidence" };
    }
    return v;
  });
}
function buildMergedEvidenceBadges(graph, verdicts) {
  const verdictByClaim = /* @__PURE__ */ new Map();
  for (const v of verdicts ?? []) verdictByClaim.set(v.claimId, v);
  return graph.nodes.filter((node) => node.type === "Claim").map(
    (claim) => mergeEvidenceBadge({
      claimId: claim.id,
      structuralSupport: structuralSupportFor(graph, claim.id),
      verdict: verdictByClaim.get(claim.id)
    })
  );
}

// ../../packages/verifier/src/attested-adjudicator.ts
import { mkdir as mkdir2 } from "node:fs/promises";
import { hashMessage, recoverAddress } from "ethers";

// ../../packages/verifier/src/adjudication-schema.ts
var hexHash = external_exports.string().regex(/^0x[a-fA-F0-9]{64}$/, "expected a 0x-prefixed 32-byte hex hash");
var claimSchema = external_exports.object({
  claimId: external_exports.string().min(1),
  verdict: external_exports.enum(["substantiated", "inflated", "unsupported"]),
  confidence: external_exports.number().min(0).max(1),
  supportingNodes: external_exports.array(external_exports.string().min(1)),
  rationale: external_exports.string().max(240),
  abstainReason: external_exports.literal("insufficient-public-evidence").nullable().default(null),
  // dimensions are SUPPORTING metadata (the verdict itself carries the judgment). Real-world weak
  // TEE models often omit them; default CONSERVATIVELY (never inflates) so a missing-dimensions
  // response still parses. Applied identically on producer + validator, so the verdictRoot binding
  // is unaffected.
  dimensions: external_exports.object({
    relevance: external_exports.enum(["strong", "weak", "none"]),
    sufficiency: external_exports.enum(["proportionate", "thin", "absent"]),
    contradiction: external_exports.enum(["none", "present"])
  }).strict().default({ relevance: "none", sufficiency: "absent", contradiction: "none" })
}).strict();
var adjudicationV1Schema = external_exports.object({
  schema: external_exports.literal("vibetrace.adjudication.v1"),
  graphHash: hexHash,
  evidenceTier: external_exports.enum(["private", "public-only"]),
  privateEvidenceRoot: hexHash.optional(),
  claims: external_exports.array(claimSchema),
  abstained: external_exports.array(external_exports.string()).default([])
}).strict();
function parseAdjudicationV1(raw) {
  return adjudicationV1Schema.parse(raw);
}
function extractAdjudicationJson(text) {
  const stripped = text.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
  const start = stripped.indexOf("{");
  if (start === -1) return stripped;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < stripped.length; i += 1) {
    const c = stripped[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
    } else if (c === "{") {
      depth += 1;
    } else if (c === "}") {
      depth -= 1;
      if (depth === 0) return stripped.slice(start, i + 1);
    }
  }
  return stripped.slice(start);
}
function normalizeAdjudicationEnums(raw) {
  if (!raw || typeof raw !== "object") return raw;
  const obj = raw;
  if (!Array.isArray(obj.claims)) return raw;
  const VERDICT = {
    substantiated: "substantiated",
    supported: "substantiated",
    verified: "substantiated",
    proven: "substantiated",
    confirmed: "substantiated",
    inflated: "inflated",
    overstated: "inflated",
    partial: "inflated",
    overclaimed: "inflated",
    unsupported: "unsupported",
    unsubstantiated: "unsupported",
    unproven: "unsupported",
    "not supported": "unsupported",
    none: "unsupported",
    insufficient: "unsupported"
  };
  const REL = { strong: "strong", relevant: "strong", high: "strong", direct: "strong", weak: "weak", partial: "weak", medium: "weak", some: "weak", none: "none", irrelevant: "none", low: "none" };
  const SUF = { proportionate: "proportionate", sufficient: "proportionate", strong: "proportionate", adequate: "proportionate", thin: "thin", partial: "thin", weak: "thin", limited: "thin", absent: "absent", insufficient: "absent", none: "absent" };
  const CON = { none: "none", absent: "none", no: "none", present: "present", contradicts: "present", conflict: "present", yes: "present" };
  const pick = (m, v, dflt) => typeof v === "string" && m[v.toLowerCase().trim()] || dflt;
  return {
    ...obj,
    claims: obj.claims.map((c) => {
      if (!c || typeof c !== "object") return c;
      const cc = c;
      const d = cc.dimensions && typeof cc.dimensions === "object" ? cc.dimensions : {};
      return {
        ...cc,
        verdict: pick(VERDICT, cc.verdict, "unsupported"),
        dimensions: {
          relevance: pick(REL, d.relevance, "none"),
          sufficiency: pick(SUF, d.sufficiency, "absent"),
          contradiction: pick(CON, d.contradiction, "none")
        }
      };
    })
  };
}

// ../../packages/verifier/src/structural-support.ts
function buildStructuralNeighborhood(graph) {
  const result = /* @__PURE__ */ new Map();
  for (const node of graph.nodes) {
    if (node.type === "Claim") {
      result.set(node.id, /* @__PURE__ */ new Set());
    }
  }
  for (const edge of graph.edges) {
    if (edge.type !== "supports") continue;
    if (!edge.from.startsWith("file:") && !edge.from.startsWith("trace:")) continue;
    const bucket = result.get(edge.to);
    if (bucket) {
      bucket.add(edge.from);
    }
  }
  return result;
}
function orderedClaimSupporters(graph) {
  const neighborhood = buildStructuralNeighborhood(graph);
  const ordered = /* @__PURE__ */ new Map();
  for (const [claimId, set] of neighborhood) {
    ordered.set(
      claimId,
      [...set].sort((a, b) => {
        const fa = a.startsWith("file:") ? 0 : 1;
        const fb = b.startsWith("file:") ? 0 : 1;
        return fa !== fb ? fa - fb : a.localeCompare(b);
      })
    );
  }
  return ordered;
}

// ../../packages/verifier/src/attested-adjudicator.ts
var SYSTEM_PROMPT = [
  "You are VibeTrace's neutral build adjudicator running inside a TEE.",
  "You receive a public artifact graph: claims, file versions, trace spans, and typed edges.",
  "The graph carries hashes, file paths, ids, and timestamps only \u2014 never prompt or response text.",
  "For each Claim node, judge whether its structural support substantiates the claim text along three",
  "dimensions: relevance, sufficiency/proportionality, and contradiction.",
  "Verdicts: substantiated | inflated | unsupported. inflated = real but oversold.",
  "If the public surface is too thin to judge a semantic claim, set verdict=unsupported,",
  "abstainReason=insufficient-public-evidence, confidence=0, and list the claim in abstained.",
  "Each claim carries a numbered supportingNodeTable of its ONLY allowed supporters. To cite support,",
  "set supportingNodeIndices to integer indices FROM THAT claim's table \u2014 never ids, never invent numbers.",
  "Leave supportingNodes as []. rationale <=240 chars, reference the table refs, no prompt text.",
  "Echo the input graphHash exactly. Reply with ONLY a JSON object matching schema",
  "vibetrace.adjudication.v1 (keys: schema, graphHash, evidenceTier, claims[], abstained[]).",
  'Set evidenceTier to "public-only". No markdown, no commentary.'
].join(" ");
var PRIVATE_SYSTEM_PROMPT = [
  "You are VibeTrace's neutral build adjudicator running inside a TEE.",
  "You receive a public artifact graph AND sealed private evidence (diffs, file excerpts, test output).",
  "The graph carries hashes, file paths, ids, and timestamps. Private evidence is in privateEvidence.leaves.",
  "For each Claim node, judge using BOTH the public graph AND the private evidence.",
  "You MAY use private leaf content to substantiate semantic claims that the public graph alone could not.",
  "Verdicts: substantiated | inflated | unsupported. inflated = real but oversold.",
  "If a claim's private evidence substantiates it, set verdict=substantiated.",
  "If the combined evidence is still insufficient, set verdict=unsupported,",
  "abstainReason=insufficient-public-evidence, confidence=0, and list the claim in abstained.",
  "supportingNodes MUST be ids of file:- or trace:-prefixed nodes that support the claim, or leaf ids",
  "from privateEvidence.leaves. Never invent ids. rationale <=240 chars, cite node ids/leaf ids, no raw content.",
  "Echo the input graphHash exactly. Reply with ONLY a JSON object matching schema",
  "vibetrace.adjudication.v1 (keys: schema, graphHash, evidenceTier, claims[], abstained[]).",
  'Set evidenceTier to "private". No markdown, no commentary.'
].join(" ");
function adjudicationTableCap() {
  const n = Math.floor(Number(process.env.VIBETRACE_ADJUDICATION_TABLE_CAP ?? "64"));
  return Number.isFinite(n) && n > 0 ? n : 64;
}
function buildAdjudicationRequest(graph, model, privatePacket) {
  if (privatePacket) {
    const privateEvidence = { evidenceRoot: privatePacket.evidenceRoot, leaves: privatePacket.leaves };
    const userPayload2 = {
      instruction: "Adjudicate every Claim node using the public graph and the private evidence. Output vibetrace.adjudication.v1 JSON only.",
      graphHash: graph.canonicalHash,
      nodes: graph.nodes,
      edges: graph.edges,
      privateEvidence
    };
    const body2 = {
      model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: PRIVATE_SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify(userPayload2) }
      ]
    };
    const requestHash2 = canonicalHash({
      model,
      graphHash: graph.canonicalHash,
      nodes: graph.nodes,
      edges: graph.edges,
      privateEvidence
    });
    return { body: body2, requestHash: requestHash2 };
  }
  const claimNodes = graph.nodes.filter((n) => n.type === "Claim");
  const ordered = orderedClaimSupporters(graph);
  const cap = adjudicationTableCap();
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const baseline = {
    schema: "vibetrace.adjudication.v1",
    graphHash: graph.canonicalHash,
    evidenceTier: "public-only",
    claims: claimNodes.map((n) => ({
      claimId: n.id,
      verdict: "unsupported",
      confidence: 0,
      supportingNodes: [],
      rationale: "Insufficient public evidence to substantiate this claim.",
      abstainReason: "insufficient-public-evidence",
      dimensions: { relevance: "none", sufficiency: "absent", contradiction: "none" }
    })),
    abstained: claimNodes.map((n) => n.id)
  };
  const claimsForModel = claimNodes.map((n) => ({
    claimId: n.id,
    text: n.data?.text ?? n.label,
    supportingNodeTable: (ordered.get(n.id) ?? []).slice(0, cap).map((id, index) => ({
      index,
      ref: nodeById.get(id)?.label ?? id.replace(/^(file:|trace:)/, "").replace(/@[0-9a-f]+$/i, "")
    }))
  }));
  const userPayload = {
    instruction: '`baseline` below is a COMPLETE and VALID vibetrace.adjudication.v1 JSON object (every claim unsupported/abstained). Return `baseline` as your ENTIRE JSON response, with ONLY this allowed change: for any claim in `claims` whose `supportingNodeTable` entries clearly substantiate its `text`, set that claim\'s verdict to "substantiated" (or "inflated" if real but oversold), add a `supportingNodeIndices` array holding the integer `index` values of the relevant table entries (cite INDICES from that claim\'s own table \u2014 never ids, never numbers not in the table), set confidence in [0,1], write a rationale (<=240 chars), set its abstainReason to null, and remove its claimId from `abstained`. Leave supportingNodes as []. Leave every other field EXACTLY as in baseline; echo graphHash exactly. Output ONLY the resulting JSON object \u2014 no markdown, no commentary.',
    baseline,
    claims: claimsForModel
  };
  const body = {
    model,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify(userPayload) }
    ]
  };
  const requestHash = canonicalHash({
    model,
    graphHash: graph.canonicalHash,
    nodes: graph.nodes,
    edges: graph.edges
  });
  return { body, requestHash };
}
function crossCheckAdjudication(adjudication, graph, privatePacket) {
  const graphHashMatches = adjudication.graphHash === graph.canonicalHash;
  const neighborhood = buildStructuralNeighborhood(graph);
  const EVIDENCE_LEAF_KINDS2 = /* @__PURE__ */ new Set(["file-excerpt", "diff", "test-output"]);
  const privateLeafIds = new Set(
    (privatePacket?.leaves ?? []).filter((l) => EVIDENCE_LEAF_KINDS2.has(l.kind)).map((l) => l.id)
  );
  const claimIds = new Set(graph.nodes.filter((n) => n.type === "Claim").map((n) => n.id));
  let citedUnknownNode = false;
  for (const claim of adjudication.claims) {
    if (!claimIds.has(claim.claimId)) {
      citedUnknownNode = true;
      continue;
    }
    const allowed = neighborhood.get(claim.claimId) ?? /* @__PURE__ */ new Set();
    if (claim.supportingNodes.some((id) => !allowed.has(id) && !privateLeafIds.has(id))) {
      citedUnknownNode = true;
    }
  }
  const verdicts = adjudication.claims;
  return { graphHashMatches, verdicts, citedUnknownNode };
}
function mapSupportingIndicesToIds(raw, graph) {
  if (!raw || typeof raw !== "object") return raw;
  const obj = raw;
  if (!Array.isArray(obj.claims)) return raw;
  const ordered = orderedClaimSupporters(graph);
  const downgraded = /* @__PURE__ */ new Set();
  const claims = obj.claims.map((c) => {
    if (!c || typeof c !== "object") return c;
    const cc = c;
    const claimId = typeof cc.claimId === "string" ? cc.claimId : "";
    const table = ordered.get(claimId) ?? [];
    const rawIdx = Array.isArray(cc.supportingNodeIndices) ? cc.supportingNodeIndices : [];
    const ids = [...new Set(
      rawIdx.map((i) => typeof i === "number" && Number.isInteger(i) && i >= 0 && i < table.length ? table[i] : null).filter((id) => id !== null)
    )];
    const { supportingNodeIndices: _dropIdx, supportingNodes: _dropRaw, ...rest } = cc;
    if ((cc.verdict === "substantiated" || cc.verdict === "inflated") && ids.length === 0) {
      if (claimId) downgraded.add(claimId);
      return { ...rest, supportingNodes: [], verdict: "unsupported", confidence: 0, abstainReason: "insufficient-public-evidence" };
    }
    return { ...rest, supportingNodes: ids };
  });
  const prevAbstained = Array.isArray(obj.abstained) ? obj.abstained.filter((x) => typeof x === "string") : [];
  return { ...obj, claims, abstained: [.../* @__PURE__ */ new Set([...prevAbstained, ...downgraded])] };
}
function dropTruncatedNegativesOnCap(graph, verdicts) {
  const cap = adjudicationTableCap();
  const ordered = orderedClaimSupporters(graph);
  return verdicts.filter((v) => {
    const truncated = (ordered.get(v.claimId)?.length ?? 0) > cap;
    return !(truncated && v.verdict !== "substantiated");
  });
}
var NoTeeMlProviderError = class extends Error {
  constructor() {
    super("no acknowledged TeeML provider available on the target network");
    this.name = "NoTeeMlProviderError";
  }
};
function selectTeeMlProvider(services, preferredProvider) {
  const eligible = services.filter((s) => s.verifiability === "TeeML" && s.teeSignerAcknowledged === true);
  if (eligible.length === 0) {
    throw new NoTeeMlProviderError();
  }
  if (preferredProvider) {
    const pref = eligible.find((s) => s.provider.toLowerCase() === preferredProvider.toLowerCase());
    if (pref) return pref;
  }
  return eligible[0];
}
function buildTeeAttestation(input) {
  return {
    scheme: "0g-teeml",
    // The signature attests TEE EXECUTION + a provider response-hash (signedText = `responseHash:chatID`),
    // recovering to the signer named by the attestation (on-chain acknowledgement is NOT checked).
    // It does NOT bind the verdict content.
    attests: "tee-execution",
    providerAddress: input.providerAddress,
    signingAddress: input.signingAddress,
    signature: input.signature,
    // keccak `hashMessage` over exactly the text the enclave put its signature over (the
    // `responseHash:chatID`); recover the signer from (signature, signedDigest). Real TEE-execution proof.
    signedDigest: hashMessage(input.signedText),
    // SHA-256 `canonicalHash` over the SIGNED `responseHash:chatID` (execution material), NOT the verdict
    // content — ties the signed text to VibeTrace's hash world. DISTINCT from signedDigest.
    responseTextHash: canonicalHash(input.signedText),
    processResponseValid: input.processResponseValid,
    teeType: input.verifySummary?.teeType,
    composeVerificationPassed: input.verifySummary?.composeVerificationPassed,
    signerAllMatch: input.verifySummary?.signerAllMatch,
    attestationQuoteUri: input.attestationQuoteUri,
    quoteHash: input.quoteHash,
    raDownloadLink: input.raDownloadLink,
    chatSignatureLink: input.chatSignatureLink,
    verifiedAt: input.verifiedAt,
    verifiedBy: input.verifiedBy
  };
}
async function fetchAndVerifyEnclaveSignature(args) {
  const link = await args.broker.inference.getChatSignatureDownloadLink(args.providerAddress, args.chatID).catch(() => void 0);
  if (!link) {
    throw new Error("0G Compute adjudicator: no chat signature download link available");
  }
  const sep = link.includes("?") ? "&" : "?";
  const res = await args.fetchImpl(`${link}${sep}model=${encodeURIComponent(args.model)}`, { method: "GET" });
  if (!res.ok) {
    throw new Error(`0G Compute adjudicator: signature fetch HTTP ${res.status}`);
  }
  const payload = await res.json();
  const signedText = typeof payload.text === "string" ? payload.text : "";
  if (!signedText) {
    throw new Error("0G Compute adjudicator: enclave returned no signed response text");
  }
  if (!signedText.includes(":")) {
    throw new Error("0G Compute adjudicator: signed response text is not in responseHash:chatID form");
  }
  const signature = payload.signature;
  if (!signature) {
    throw new Error("0G Compute adjudicator: enclave returned no signature");
  }
  const recovered = recoverAddress(hashMessage(signedText), signature);
  if (recovered.toLowerCase() !== args.signingAddress.toLowerCase()) {
    throw new Error(
      `0G Compute adjudicator: enclave signature does not recover to signingAddress (${recovered} != ${args.signingAddress})`
    );
  }
  return { signature, signedText, chatSignatureLink: link };
}
async function runAttestedAdjudicator(options) {
  const now = options.now ?? (() => (/* @__PURE__ */ new Date()).toISOString());
  const fetchImpl = options.fetchImpl ?? fetch;
  const { broker, graph } = options;
  const services = await broker.inference.listServiceWithDetail(0, 50, false);
  const provider = selectTeeMlProvider(services, options.preferredProvider);
  const { endpoint, model } = await broker.inference.getServiceMetadata(provider.provider);
  const privatePacket = options.privatePacket;
  const { body, requestHash } = buildAdjudicationRequest(graph, model, privatePacket);
  try {
    await broker.inference.startAutoFunding?.(provider.provider, { bufferMultiplier: 1 });
  } catch {
  }
  const headers = await broker.inference.getRequestHeaders(provider.provider, JSON.stringify(body));
  const response = await fetchImpl(`${endpoint}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`0G Compute adjudicator HTTP error: ${response.status} ${await response.text()}`);
  }
  const completion = await response.json();
  const chatID = response.headers.get("ZG-Res-Key") || completion.id || void 0;
  const content = String(completion.choices?.[0]?.message?.content ?? "");
  if (!content) {
    throw new Error("0G Compute adjudicator returned empty content");
  }
  if (!chatID) {
    throw new Error("0G Compute adjudicator returned no chat id (cannot fetch the response signature)");
  }
  const normalized = normalizeAdjudicationEnums(JSON.parse(extractAdjudicationJson(content)));
  const decoded = privatePacket ? normalized : mapSupportingIndicesToIds(normalized, graph);
  const adjudication = parseAdjudicationV1(decoded);
  const cross = crossCheckAdjudication(adjudication, graph, privatePacket);
  if (!cross.graphHashMatches) {
    throw new Error("0G Compute adjudicator graphHash echo mismatch \u2014 run rejected");
  }
  if (cross.citedUnknownNode) {
    throw new Error("0G Compute adjudicator cited a node outside the claim's structural neighborhood \u2014 run rejected");
  }
  const processResponseValid = await broker.inference.processResponse(
    provider.provider,
    chatID,
    JSON.stringify(completion.usage ?? {})
  );
  if (processResponseValid !== true) {
    throw new Error("0G Compute response not independently attested (processResponse !== true)");
  }
  const { signature, signedText, chatSignatureLink } = await fetchAndVerifyEnclaveSignature({
    broker,
    providerAddress: provider.provider,
    signingAddress: provider.teeSignerAddress,
    chatID,
    model,
    fetchImpl
  });
  let verifySummary;
  try {
    await mkdir2("/tmp/vt-tee", { recursive: true });
    const vr = await broker.inference.verifyService(provider.provider, "/tmp/vt-tee");
    if (vr) {
      verifySummary = {
        composeVerificationPassed: vr.composeVerification?.passed,
        signerAllMatch: vr.signerVerification?.allMatch,
        teeType: vr.reportsData?.combined || vr.reportsData?.llm ? "TDX" : void 0
      };
    }
  } catch {
    verifySummary = void 0;
  }
  const quote = await options.quoteStorage.uploadJson({
    providerAddress: provider.provider,
    signingAddress: provider.teeSignerAddress,
    verifySummary: verifySummary ?? null,
    chatID,
    capturedAt: now()
  });
  const raDownloadLink = await broker.inference.getSignerRaDownloadLink(provider.provider).catch(() => void 0);
  const attestation = buildTeeAttestation({
    providerAddress: provider.provider,
    signingAddress: provider.teeSignerAddress,
    signature,
    signedText,
    processResponseValid: true,
    verifySummary,
    quoteHash: quote.rootHash,
    attestationQuoteUri: quote.uri,
    raDownloadLink,
    chatSignatureLink,
    verifiedBy: options.verifiedBy,
    verifiedAt: now()
  });
  const verdicts = privatePacket ? cross.verdicts : downgradeUnsupportedVerdicts(graph, dropTruncatedNegativesOnCap(graph, cross.verdicts));
  const evidenceBadges = buildMergedEvidenceBadges(graph, verdicts);
  const output = {
    graphHash: graph.canonicalHash,
    verdicts,
    evidenceBadges,
    citedUnknownNode: cross.citedUnknownNode
  };
  const verdictRoot = canonicalHash(verdicts);
  const packetAny = options.privatePacket;
  const verifierRun = {
    verifierId: "vibetrace-attested-adjudicator",
    provider: "0g-compute",
    model,
    requestHash,
    responseHash: canonicalHash(completion),
    outputHash: canonicalHash(output),
    createdAt: now(),
    summary: `Examined by ${model} in an attested 0G TEE: ${verdicts.length} claim${verdicts.length === 1 ? "" : "s"} judged.`,
    attestation,
    verdicts,
    verdictRoot,
    evidenceTier: packetAny ? "private" : "public-only",
    ...packetAny?.evidenceRoot !== void 0 ? { privateEvidenceRoot: packetAny.evidenceRoot } : {}
  };
  return { verifierRun, evidenceBadges, signedText };
}

// ../../packages/verifier/src/relayer-client.ts
import { hashMessage as hashMessage2, recoverAddress as recoverAddress2 } from "ethers";
function validateAttestationLocally(run, signedText, expected) {
  const att = run.attestation;
  if (!att) {
    return { valid: false, reason: "no attestation present" };
  }
  if (typeof signedText !== "string" || signedText.length === 0) {
    return { valid: false, reason: "no signedText to verify the TEE execution" };
  }
  if (att.processResponseValid !== true) {
    return { valid: false, reason: "processResponseValid is not true" };
  }
  const digest = hashMessage2(signedText);
  if (digest !== att.signedDigest) {
    return { valid: false, reason: "hashMessage(signedText) !== signedDigest" };
  }
  if (canonicalHash(signedText) !== att.responseTextHash) {
    return { valid: false, reason: "canonicalHash(signedText) !== responseTextHash" };
  }
  try {
    const recovered = recoverAddress2(digest, att.signature);
    if (recovered.toLowerCase() !== att.signingAddress.toLowerCase()) {
      return { valid: false, reason: `signature recovers to ${recovered}, not ${att.signingAddress}` };
    }
  } catch (error) {
    return { valid: false, reason: `signature recover failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (canonicalHash(run.verdicts ?? []) !== run.verdictRoot) {
    return { valid: false, reason: "canonicalHash(run.verdicts) !== verdictRoot \u2014 verdicts not self-consistent" };
  }
  if (expected) {
    if (run.evidenceTier !== void 0) {
      const expectedTier = expected.evidenceTier ?? "public-only";
      if (run.evidenceTier !== expectedTier) {
        return { valid: false, reason: `run.evidenceTier ${run.evidenceTier} !== expected ${expectedTier}` };
      }
    }
    if (expected.privateEvidenceRoot !== void 0 && run.privateEvidenceRoot !== expected.privateEvidenceRoot) {
      return { valid: false, reason: `run.privateEvidenceRoot !== expected` };
    }
  }
  return { valid: true };
}
async function runRelayerAdjudication(options) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = options.relayerUrl.replace(/\/$/, "");
  const headers = { "Content-Type": "application/json" };
  if (options.authToken) headers["Authorization"] = `Bearer ${options.authToken}`;
  const response = await fetchImpl(`${base}/adjudicate`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      graph: options.graph,
      evidenceTier: options.evidenceTier ?? "public-only",
      ...options.privateEvidenceRoot !== void 0 ? { privateEvidenceRoot: options.privateEvidenceRoot } : {},
      ...options.privatePacket !== void 0 ? { privatePacket: options.privatePacket } : {}
    }),
    signal: options.signal
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`relayer /adjudicate HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
  const result = await response.json();
  const check = validateAttestationLocally(result.verifierRun, result.signedText ?? "", {
    evidenceTier: options.evidenceTier ?? "public-only",
    privateEvidenceRoot: options.privateEvidenceRoot
  });
  if (!check.valid) {
    throw new Error(`relayer returned an attestation that failed LOCAL validation: ${check.reason}`);
  }
  if (result.verifierRun.attestation && result.signedText) {
    result.verifierRun.attestation.signedText = result.signedText;
  }
  delete result.signedText;
  const isPrivate = (options.evidenceTier ?? "public-only") === "private";
  if (!isPrivate) {
    const gated = downgradeUnsupportedVerdicts(
      options.graph,
      dropTruncatedNegativesOnCap(options.graph, result.verifierRun.verdicts ?? [])
    );
    result.verifierRun.verdicts = gated;
    result.verifierRun.verdictRoot = canonicalHash(gated);
    result.evidenceBadges = buildMergedEvidenceBadges(options.graph, gated);
  }
  return result;
}

// ../../packages/verifier/src/signer-verify.ts
import { mkdir as mkdir3 } from "node:fs/promises";
async function verifySignerAgainst0G(broker, input) {
  const base = {
    providerAddress: input.providerAddress,
    expectedSigner: input.expectedSigner,
    onChainSigner: null,
    acknowledgedOnChain: false,
    quoteVerified: false,
    matches: false
  };
  try {
    const services = await broker.inference.listServiceWithDetail(0, 50, false);
    const svc = services.find((s) => s.provider.toLowerCase() === input.providerAddress.toLowerCase());
    if (!svc) return base;
    const onChainSigner = typeof svc.teeSignerAddress === "string" && svc.teeSignerAddress.length > 0 ? svc.teeSignerAddress : null;
    const acknowledgedOnChain = svc.teeSignerAcknowledged === true;
    let quoteVerified = false;
    try {
      const outDir = input.outputDir ?? "/tmp/vt-verify";
      await mkdir3(outDir, { recursive: true });
      const vr = await broker.inference.verifyService(input.providerAddress, outDir);
      quoteVerified = vr?.composeVerification?.passed === true && vr?.signerVerification?.allMatch === true;
    } catch {
      quoteVerified = false;
    }
    const addrMatch = onChainSigner !== null && onChainSigner.toLowerCase() === input.expectedSigner.toLowerCase();
    return {
      ...base,
      onChainSigner,
      acknowledgedOnChain,
      quoteVerified,
      // reported, but NOT a factor in `matches` (best-effort live quote; see doc above)
      matches: addrMatch && acknowledgedOnChain
    };
  } catch {
    return base;
  }
}

// ../../packages/verifier/src/index.ts
async function runLocalVerifier(options) {
  const now = options.now ?? (() => (/* @__PURE__ */ new Date()).toISOString());
  const evidenceBadges = buildEvidenceBadges(options.graph);
  const output = {
    graphHash: options.graph.canonicalHash,
    evidenceBadges,
    summary: summarizeGraph(options.graph, evidenceBadges)
  };
  return {
    verifierRun: {
      verifierId: "vibetrace-local-verifier",
      provider: "0g-dev",
      model: "deterministic-lineage-verifier",
      requestHash: canonicalHash({
        graphHash: options.graph.canonicalHash,
        nodeCount: options.graph.nodes.length,
        edgeCount: options.graph.edges.length
      }),
      responseHash: canonicalHash(output),
      outputHash: canonicalHash(output),
      createdAt: now(),
      summary: output.summary,
      evidenceTier: "public-only"
    },
    evidenceBadges
  };
}
async function runVibeTraceVerifier(options) {
  const env = options.env ?? process.env;
  if (options.broker && options.quoteStorage) {
    const adjOptions = {
      graph: options.graph,
      broker: options.broker,
      quoteStorage: options.quoteStorage,
      fetchImpl: options.fetchImpl,
      preferredProvider: options.preferredProvider,
      verifiedBy: options.verifiedBy ?? "vibetrace-relayer",
      now: options.now
    };
    return runAttestedAdjudicator(adjOptions);
  }
  const relayerUrl = options.relayerUrl ?? env.VIBETRACE_RELAYER_URL;
  if (relayerUrl) {
    try {
      return await runRelayerAdjudication({
        graph: options.graph,
        relayerUrl,
        authToken: options.authToken ?? env.VIBETRACE_RELAYER_AUTH_TOKEN,
        fetchImpl: options.fetchImpl,
        now: options.now
      });
    } catch (err) {
      console.error(`\u26A0 attested adjudication unavailable \u2014 falling back to structural-only verifier: ${err?.message ?? err}`);
      return runLocalVerifier({ graph: options.graph, now: options.now });
    }
  }
  return runLocalVerifier({ graph: options.graph, now: options.now });
}
function buildEvidenceBadges(graph, verdicts) {
  return buildMergedEvidenceBadges(graph, verdicts);
}
function summarizeGraph(graph, badges) {
  const traceCount = graph.nodes.filter((node) => node.type === "TraceSpan").length;
  const fileCount = graph.nodes.filter((node) => node.type === "FileVersion").length;
  const verifiedCount = badges.filter((badge) => badge.status === "verified").length;
  return `VibeTrace linked ${traceCount} AI trace span${traceCount === 1 ? "" : "s"} to ${fileCount} file version${fileCount === 1 ? "" : "s"} and verified ${verifiedCount} public claim${verifiedCount === 1 ? "" : "s"}.`;
}

// src/index.ts
var execFileAsync = promisify(execFile);
var workspaceDir = ".vibetrace";
var ledgerFile = "ledger.json";
var configFile = "vibetrace.config.json";
var requiredRealChainEnv = [
  "VIBETRACE_0G_PRIVATE_KEY",
  "VIBETRACE_0G_RPC_URL"
];
var requiredRealStorageEnv = requiredRealChainEnv;
var requiredRealComputeEnv = ["VIBETRACE_RELAYER_URL"];
var defaultRegistryUrl = "https://vibetrace.timidan.xyz";
async function runCli(argv, options = {}) {
  const cwd = resolve3(options.cwd ?? process.cwd());
  const now = options.now ?? (() => (/* @__PURE__ */ new Date()).toISOString());
  const stdout = options.stdout ?? ((message) => console.log(message));
  const command = argv[0];
  switch (command) {
    case "init":
      await initWorkspace(cwd, now, stdout, {
        ci: argv.includes("--ci"),
        promptText: options.promptText ?? defaultPromptText
      });
      return;
    case "ci":
      await runCi(cwd, argv, now, options.env ?? process.env, stdout);
      return;
    case "collect":
      await collectTraces(cwd, argv, now, stdout);
      return;
    case "ship":
      await shipFlow(
        cwd,
        argv,
        now,
        options.env ?? process.env,
        stdout,
        options.promptYesNo ?? defaultPromptYesNo,
        options.promptText ?? defaultPromptText
      );
      return;
    case "snapshot":
      await snapshotWorkspace(cwd, now, stdout);
      return;
    case "import":
      await importTrace(cwd, argv, stdout);
      return;
    case "verify": {
      const bundleArg = argv.slice(1).find((a) => !a.startsWith("-") && a.endsWith(".json"));
      if (bundleArg) {
        const bundlePath = isAbsolute2(bundleArg) ? bundleArg : join4(cwd, bundleArg);
        const ok = await reverifyPublishedBundle(bundlePath, options.env ?? process.env, stdout);
        if (!ok) process.exitCode = 1;
        return;
      }
      await verifyLedger(cwd, now, options.env ?? process.env, stdout, {
        argv,
        adjudicate: options.adjudicate,
        verifierFn: options.verifierFn
      });
      return;
    }
    case "publish":
      await publishLedger(cwd, argv, now, options.env ?? process.env, stdout);
      return;
    case "inspect":
      await inspectLedger(cwd, argv, stdout);
      return;
    case "doctor":
      await doctorWorkspace(cwd, argv, options.env ?? process.env, stdout);
      return;
    case "--help":
    case "-h":
      stdout(helpText());
      return;
    case void 0:
      await shipFlow(
        cwd,
        argv,
        now,
        options.env ?? process.env,
        stdout,
        options.promptYesNo ?? defaultPromptYesNo,
        options.promptText ?? defaultPromptText
      );
      return;
    default:
      throw new Error(`Unknown command: ${command}

${helpText()}`);
  }
}
async function initWorkspace(cwd, now, stdout, options = {}) {
  const dir = ledgerDir(cwd);
  const packageJson = await readPackageJson(cwd);
  const config = await ensureConfig(cwd, packageJson, options.promptText ?? defaultPromptText);
  await ensureGitignore(cwd);
  if (options.ci) {
    const workflowPath = await ensureCiWorkflow(cwd, await detectPackageManager(cwd));
    stdout(workflowPath ? `Created ${workflowPath}.` : "VibeTrace CI workflow already exists.");
  }
  await mkdir4(dir, { recursive: true });
  await mkdir4(join4(dir, "traces"), { recursive: true });
  await mkdir4(join4(dir, "public"), { recursive: true });
  if (await exists3(ledgerPath(cwd))) {
    stdout("VibeTrace workspace already initialized.");
    return;
  }
  const ledger = {
    schemaVersion: "vibetrace.local.v1",
    project: {
      name: config.project.name,
      root: cwd
    },
    createdAt: now(),
    snapshots: [],
    traces: [],
    claims: defaultClaims()
  };
  await writeLedger(cwd, ledger);
  stdout("Initialized .vibetrace workspace.");
}
async function runCi(cwd, argv, now, env, stdout) {
  if (!await exists3(ledgerPath(cwd)) || !await exists3(configPath(cwd))) {
    await initWorkspace(cwd, now, stdout);
  }
  await snapshotWorkspace(cwd, now, stdout);
  const config = await readConfig(cwd);
  const traceFiles = await discoverTraceFiles(cwd, config);
  let importedSpans = 0;
  for (const file of traceFiles) {
    const result = await importTraceFile(cwd, file);
    importedSpans += result.added;
    stdout(`Imported ${result.added} trace span${result.added === 1 ? "" : "s"} from ${file}.`);
  }
  if (traceFiles.length === 0) {
    stdout("No trace files discovered; continuing with a snapshot-only ledger.");
  }
  await verifyLedger(cwd, now, env, stdout);
  const publishArgs = ["publish", "--public-summary"];
  const outPath = valueAfter(argv, "--out");
  const viewerUrl = valueAfter(argv, "--viewer-url");
  if (outPath) publishArgs.push("--out", outPath);
  if (viewerUrl) publishArgs.push("--viewer-url", viewerUrl);
  await publishLedger(cwd, publishArgs, now, env, stdout);
  stdout(
    `VibeTrace CI complete: ${traceFiles.length} trace file${traceFiles.length === 1 ? "" : "s"}, ${importedSpans} imported span${importedSpans === 1 ? "" : "s"}.`
  );
}
var collectedTraceFile = "collected-trace.json";
async function collectTraces(cwd, argv, now, stdout) {
  const skipConfirm = argv.includes("--yes") || argv.includes("-y");
  const includeExcerpts = argv.includes("--include-excerpts");
  let repoRoot = resolve3(cwd);
  try {
    repoRoot = await realpath(repoRoot);
  } catch {
  }
  const nowIso = now();
  const claudeProbe = await collectClaudeCode({ repoRoot, now: nowIso, includeExcerpts });
  const codexProbe = await collectCodex({ repoRoot, now: nowIso, includeExcerpts });
  const probe = {
    spans: [...claudeProbe.spans, ...codexProbe.spans].sort(
      (a, b) => a.startedAt.localeCompare(b.startedAt) || a.spanId.localeCompare(b.spanId)
    ),
    sessionsScanned: claudeProbe.sessionsScanned + codexProbe.sessionsScanned,
    sessionsMatched: claudeProbe.sessionsMatched + codexProbe.sessionsMatched,
    scannedDirs: [...claudeProbe.scannedDirs, ...codexProbe.scannedDirs]
  };
  stdout("VibeTrace collect \u2014 local AI-agent trace collection");
  stdout(`  Reading: ${probe.scannedDirs.join(", ")}`);
  stdout("  Local-only: this reads transcripts on this machine and uploads NOTHING.");
  stdout(
    `  Default output is hashes + file paths + timestamps + model \u2014 never prompt/response text${includeExcerpts ? " (excerpts ENABLED via --include-excerpts)" : ""}.`
  );
  stdout(`  Scope: only sessions whose cwd is this repo (${repoRoot}).`);
  stdout(
    `  Matched ${probe.sessionsMatched} agent run${probe.sessionsMatched === 1 ? "" : "s"} (sessions + subagents) out of ${probe.sessionsScanned} scanned.`
  );
  if (!skipConfirm) {
    stdout("  Pass --yes to confirm and write the collected trace.");
    stdout("  No files written (dry run).");
    return "";
  }
  const trace = probe.spans;
  const outPath = join4(ledgerDir(cwd), collectedTraceFile);
  await mkdir4(ledgerDir(cwd), { recursive: true });
  await writeFile2(outPath, `${canonicalStringify(trace)}
`, "utf8");
  const models = unique(trace.map((span) => span.model)).sort();
  const filesTraced = unique(
    trace.flatMap((span) => [...span.artifactsProduced, ...span.filesMentioned])
  ).length;
  stdout(
    `Collected ${trace.length} agent span${trace.length === 1 ? "" : "s"}, ${filesTraced} distinct file${filesTraced === 1 ? "" : "s"} traced${models.length ? ` (models: ${models.join(", ")})` : ""}.`
  );
  stdout(`Wrote ${relative3(cwd, outPath).replaceAll("\\", "/")}.`);
  return outPath;
}
async function shipFlow(cwd, argv, now, env, stdout, promptYesNo = defaultPromptYesNo, promptText = defaultPromptText) {
  if (!await exists3(ledgerPath(cwd)) || !await exists3(configPath(cwd))) {
    await initWorkspace(cwd, now, stdout, { promptText });
  }
  await migrateLedgerProjectName(cwd, stdout);
  const collectArgs = ["collect", ...argv.slice(1)];
  if (!collectArgs.includes("--yes") && !collectArgs.includes("-y") && !collectArgs.includes("--no-yes")) {
    collectArgs.push("--yes");
  }
  const collectedPath = await collectTraces(cwd, collectArgs, now, stdout);
  await snapshotWorkspace(cwd, now, stdout);
  if (collectedPath) {
    const relPath = relative3(cwd, collectedPath).replaceAll("\\", "/");
    const result = await importTraceFile(cwd, relPath);
    const fileSpans = result.added + result.skipped;
    if (result.added > 0) {
      const dupNote = result.skipped ? ` (${result.skipped} already in the ledger)` : "";
      stdout(`Imported ${result.added} new span${result.added === 1 ? "" : "s"}${dupNote}.`);
    } else if (fileSpans > 0) {
      stdout(`${fileSpans} collected span${fileSpans === 1 ? "" : "s"} already in the ledger (0 new to import).`);
    } else {
      stdout("No spans in the collected trace; continuing with a snapshot-only ledger.");
    }
  } else {
    stdout("No collected trace to import; continuing with a snapshot-only ledger.");
  }
  await verifyLedger(cwd, now, env, stdout);
  const publishArgs = ["publish", "--public-summary"];
  const outPath = valueAfter(argv, "--out");
  const viewerUrl = valueAfter(argv, "--viewer-url");
  if (outPath) publishArgs.push("--out", outPath);
  if (viewerUrl) publishArgs.push("--viewer-url", viewerUrl);
  await publishLedger(cwd, publishArgs, now, env, stdout);
  const config = await readConfig(cwd);
  if (argv.includes("--no-register")) {
    stdout("Skipping registry registration (--no-register).");
    return;
  }
  const registryUrl = firstNonEmpty(
    valueAfter(argv, "--registry-url"),
    env.VIBETRACE_REGISTRY_URL,
    config.publish.registryUrl,
    defaultRegistryUrl
  ).replace(/\/$/, "");
  if (registryUrl !== defaultRegistryUrl) {
    stdout(`\u26A0 Registering with a NON-DEFAULT registry (from repo config): ${registryUrl}`);
    stdout("  Pass --no-register to skip if you did not expect this destination.");
  }
  stdout(`Registering build with ${registryUrl}/api/submit \u2026`);
  const ledger = await readLedger(cwd);
  if (!ledger.published) {
    stdout("Publish did not record a public bundle; skipping registry registration.");
    return;
  }
  const bundlePath = join4(ledgerDir(cwd), "public", `${ledger.published.publicBundleHash}.json`);
  let bundle;
  try {
    bundle = JSON.parse(await readFile4(bundlePath, "utf8"));
  } catch {
    stdout("Could not read the published public bundle; skipping registry registration.");
    return;
  }
  try {
    const gzipped = gzipSync(Buffer.from(JSON.stringify({ bundle }), "utf8"));
    const response = await fetch(`${registryUrl}/api/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Encoding": "gzip" },
      body: gzipped
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      stdout(
        `Published locally, but the registry rejected the submission (HTTP ${response.status})${detail ? `: ${detail.slice(0, 200)}` : ""}.`
      );
      return;
    }
    const payload = await response.json();
    const id = payload.entry?.id ?? ledger.published.publicBundleHash.replace(/^0x/, "");
    stdout(`\u2713 You're on the board: ${registryUrl}/#/p/${id}`);
    await offerBadge(cwd, registryUrl, id, payload.entry?.buildTier ?? "", argv, promptYesNo, stdout);
  } catch (error) {
    stdout(
      `Published locally. Registry at ${registryUrl} is unreachable (${error instanceof Error ? error.message : String(error)}); run 'vibetrace ship' again once it's up.`
    );
  }
}
var defaultPromptYesNo = async (question) => {
  if (!process.stdin.isTTY) return false;
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
};
var defaultPromptText = async (question, defaultValue) => {
  if (!process.stdin.isTTY) return defaultValue;
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question}${defaultValue ? ` [${defaultValue}]` : ""} `)).trim();
    return answer || defaultValue;
  } finally {
    rl.close();
  }
};
async function offerBadge(cwd, registryUrl, id, tier, argv, promptYesNo, stdout) {
  if (argv.includes("--no-badge")) return;
  const alt = tier ? `VibeScore ${tier}` : "VibeScore";
  const badgeMd = `[![${alt}](${registryUrl}/api/badge/${id}.svg)](${registryUrl}/#/p/${id})`;
  const block = `<!-- vibetrace-badge -->
${badgeMd}
<!-- /vibetrace-badge -->`;
  let add = argv.includes("--add-badge");
  if (!add) add = await promptYesNo("Would you like VibeTrace to add the badge to your README? (y/N)");
  if (!add) {
    stdout("Badge ready \u2014 paste it anywhere:");
    stdout(`  ${badgeMd}`);
    return;
  }
  try {
    const { path: readmePath, created } = await addBadgeToReadme(cwd, block);
    stdout(`\u2713 Badge ${created ? "written to new" : "added to"} ${relative3(cwd, readmePath).replaceAll("\\", "/")}.`);
  } catch (error) {
    stdout(`Could not edit the README (${error instanceof Error ? error.message : String(error)}). Paste it yourself:`);
    stdout(`  ${badgeMd}`);
  }
}
async function addBadgeToReadme(cwd, block) {
  const START = "<!-- vibetrace-badge -->";
  const END = "<!-- /vibetrace-badge -->";
  const candidates = ["README.md", "Readme.md", "readme.md", "README.markdown", "README"];
  let readmePath;
  for (const name of candidates) {
    let candidate;
    try {
      candidate = resolveInsideProject(cwd, name);
    } catch {
      continue;
    }
    if (await exists3(candidate)) {
      readmePath = candidate;
      break;
    }
  }
  if (!readmePath) {
    const created = resolveInsideProject(cwd, "README.md");
    await writeFile2(created, `${block}
`, "utf8");
    return { path: created, created: true };
  }
  let content = await readFile4(readmePath, "utf8");
  const start = content.indexOf(START);
  const end = content.indexOf(END);
  if (start >= 0 && end > start) {
    content = content.slice(0, start) + block + content.slice(end + END.length);
  } else {
    const lines = content.split("\n");
    const h1 = lines.findIndex((line) => /^#\s/.test(line));
    if (h1 >= 0) lines.splice(h1 + 1, 0, "", block);
    else lines.unshift(block, "");
    content = lines.join("\n");
  }
  await writeFile2(readmePath, content, "utf8");
  return { path: readmePath, created: false };
}
async function snapshotWorkspace(cwd, now, stdout) {
  const ledger = await readLedger(cwd);
  const config = await readConfig(cwd);
  const files = await collectFiles(cwd, config);
  const git = await readGitState(cwd, files);
  const packageMetadata = await readPackageJson(cwd);
  const snapshot = {
    snapshotId: `snapshot:${git.commit}:${files.length}:${now()}`,
    commit: git.commit,
    branch: git.branch,
    createdAt: now(),
    files,
    packageMetadata
  };
  ledger.snapshots.push(snapshot);
  await writeLedger(cwd, ledger);
  stdout(`Captured snapshot ${snapshot.snapshotId} with ${files.length} files.`);
}
async function importTrace(cwd, argv, stdout) {
  const file = valueAfter(argv, "--file");
  if (!file) {
    throw new Error("import requires --file <trace.json>");
  }
  const result = await importTraceFile(cwd, file);
  stdout(`Imported ${result.added} trace span${result.added === 1 ? "" : "s"}.`);
}
async function importTraceFile(cwd, file) {
  const ledger = await readLedger(cwd);
  const input = JSON.parse(await readFile4(resolveInsideProject(cwd, file), "utf8"));
  const spans = validateTraceSpans(Array.isArray(input) ? input : input.spans);
  const result = appendTraceSpans(ledger, spans);
  await mkdir4(join4(ledgerDir(cwd), "traces"), { recursive: true });
  await writeFile2(
    join4(ledgerDir(cwd), "traces", `${canonicalHash({ file, spans }).slice(2, 14)}-${spans.length}.json`),
    canonicalStringify(spans),
    "utf8"
  );
  await writeLedger(cwd, ledger);
  return {
    ...result,
    spans
  };
}
async function verifyLedger(cwd, now, env, stdout, opts = {}) {
  const ledger = await readLedger(cwd);
  const graph = buildArtifactGraph({
    snapshots: ledger.snapshots,
    traces: ledger.traces,
    claims: ledger.claims
  });
  const effectiveVerifierFn = opts.verifierFn ?? runVibeTraceVerifier;
  const verifier = await effectiveVerifierFn({
    graph,
    env,
    relayerUrl: env.VIBETRACE_RELAYER_URL,
    authToken: env.VIBETRACE_RELAYER_AUTH_TOKEN,
    now
  });
  ledger.graph = graph;
  ledger.verifier = verifier;
  const argv = opts.argv ?? [];
  if (argv.includes("--private-packet")) {
    const relayerUrl = env.VIBETRACE_RELAYER_URL;
    const effectiveAdjudicate = opts.adjudicate ?? (relayerUrl ? async (input) => runRelayerAdjudication({
      graph,
      relayerUrl,
      authToken: env.VIBETRACE_RELAYER_AUTH_TOKEN,
      evidenceTier: input.privatePacket ? "private" : "public-only",
      privateEvidenceRoot: input.privateEvidenceRoot,
      privatePacket: input.privatePacket
    }) : void 0);
    if (!effectiveAdjudicate) {
      await writeLedger(cwd, ledger);
      stdout(`Verified ledger graph ${graph.canonicalHash}.`);
      return;
    }
    const ok = await runPrivatePacketAdjudication(cwd, ledger, graph, argv, now, env, stdout, effectiveAdjudicate);
    if (!ok) {
      await writeLedger(cwd, ledger);
      stdout(`Verified ledger graph ${graph.canonicalHash}.`);
      return;
    }
  }
  await writeLedger(cwd, ledger);
  stdout(`Verified ledger graph ${graph.canonicalHash}.`);
}
async function runPrivatePacketAdjudication(cwd, ledger, graph, argv, now, env, stdout, adjudicate) {
  const snapshot = ledger.snapshots.at(-1);
  if (!snapshot) {
    stdout("No snapshot to build a private packet from; run vibetrace snapshot first.");
    return false;
  }
  const redact = collectFlagValues(argv, "--redact");
  const candidatePaths = snapshot.files.map((f) => f.path).slice(0, 50);
  const excerpts = await gatherFileExcerpts(candidatePaths, async (rel) => {
    try {
      return await readFile4(resolveInsideProject(cwd, rel), "utf8");
    } catch {
      return void 0;
    }
  });
  const claimIds = ledger.claims.map((c) => `claim:${c.claimId}`).sort();
  const packet = assemblePrivatePacket({
    publicBundleHash: graph.canonicalHash,
    snapshotHash: canonicalHash(snapshot),
    claimIds,
    fileExcerpts: excerpts,
    redact,
    sealedTransportConfirmed: env.VIBETRACE_0G_SEALED_TRANSPORT === "confirmed"
  });
  for (const line of renderPacketDisclosure(packet)) stdout(line);
  if (!argv.includes("--yes") && !argv.includes("-y")) {
    stdout("  Pass --yes to confirm and send this packet to the examiner.");
    stdout("  No packet sent (dry run).");
    return false;
  }
  const publicVerdicts = ledger.verifier?.verifierRun?.verdicts ?? [];
  const result = await adjudicate({
    graphHash: graph.canonicalHash,
    privatePacket: packet,
    privateEvidenceRoot: packet.evidenceRoot
  });
  const adjVerdicts = result.verifierRun?.verdicts ?? [];
  const publicBaseline = publicVerdicts.length ? publicVerdicts : graph.nodes.filter((n) => n.type === "Claim").map((n) => ({
    claimId: n.id,
    verdict: "unsupported",
    confidence: 0,
    supportingNodes: [],
    rationale: "Insufficient public evidence.",
    abstainReason: "insufficient-public-evidence",
    dimensions: { relevance: "none", sufficiency: "absent", contradiction: "none" }
  }));
  const rawMergedVerdicts = upgradeVerdictsWithPacket(publicBaseline, adjVerdicts, packet);
  const privateById = new Set(adjVerdicts.map((v) => v.claimId));
  const mergedVerdicts = rawMergedVerdicts.map(
    (v) => privateById.has(v.claimId) ? { ...v, rationale: "Rationale withheld \u2014 derived from private evidence." } : v
  );
  const allowedClaimIds = new Set(graph.nodes.filter((n) => n.type === "Claim").map((n) => n.id));
  ledger.verifier = {
    verifierRun: buildPublicSafeVerifierRun(
      { ...result.verifierRun, verdicts: mergedVerdicts },
      // gated verdicts drive verifierSummary.verdicts
      { privateEvidenceRoot: packet.evidenceRoot, allowedClaimIds }
    ),
    // Public badges MUST reflect the packet-GATED merged verdicts, not the raw adjudicator badges:
    // recompute them locally from the client's graph + the gated verdicts (and scrub free-text).
    evidenceBadges: buildPublicSafeBadges(buildMergedEvidenceBadges(graph, mergedVerdicts), allowedClaimIds),
    verdicts: mergedVerdicts
  };
  stdout(`Private packet sent (${packet.leaves.length} leaves, root ${packet.evidenceRoot}).`);
  return true;
}
function collectFlagValues(argv, flag) {
  const values = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === flag && typeof argv[i + 1] === "string") values.push(argv[i + 1]);
  }
  return values;
}
async function createReadOnlyComputeBroker(env) {
  const rpcUrl = env.VIBETRACE_0G_COMPUTE_RPC_URL ?? env.VIBETRACE_0G_RPC_URL;
  if (!rpcUrl) return null;
  try {
    const [{ createZGComputeNetworkBroker }, { ethers }] = await Promise.all([
      import("@0gfoundation/0g-compute-ts-sdk"),
      import("ethers")
    ]);
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const key = env.VIBETRACE_0G_COMPUTE_PRIVATE_KEY ?? env.VIBETRACE_0G_PRIVATE_KEY ?? "0x" + "1".repeat(64);
    const wallet = new ethers.Wallet(key, provider);
    return await createZGComputeNetworkBroker(wallet);
  } catch {
    return null;
  }
}
async function verifyBundleAgainst0G(adapters, input) {
  const fetched = await adapters.storage.downloadJson(input.storageRootHash);
  const recomputedHash = canonicalHash(fetched);
  const calldataManifestHash = await adapters.chain.readManifest(input.chainTxHash, input.expectedChainId);
  const result = {
    storage: {
      rootHash: input.storageRootHash,
      recomputedHash,
      matches: recomputedHash === input.expectedStorageHash
    },
    chain: {
      txHash: input.chainTxHash,
      calldataManifestHash,
      expectedManifestHash: input.expectedManifestHash,
      matches: calldataManifestHash === input.expectedManifestHash,
      readAt: input.readAt
    }
  };
  if (input.signer) {
    result.signer = await verifySignerAgainst0G(input.signer.broker, {
      providerAddress: input.signer.providerAddress,
      expectedSigner: input.signer.expectedSigner
    });
  }
  return result;
}
async function reverifyPublishedBundle(bundlePath, env, stdout, deps = {}) {
  const raw = await readFile4(bundlePath, "utf8");
  const bundle = JSON.parse(raw);
  const storageProvider = String(bundle.storageAnchor?.provider ?? "");
  if (storageProvider !== "0g-storage") {
    stdout(
      `This is a ${storageProvider || "dev"}-anchor bundle (no live 0G Storage object), so there is nothing to re-fetch from the indexer. Bundle re-hash + signature recovery still apply offline.`
    );
    return true;
  }
  const adapters = deps.adapters ?? createOgAdaptersFromEnv({ workspace: "/tmp/vt-reverify", env: { ...env, VIBETRACE_OG_MODE: "real" } });
  const expectedStorageHash = canonicalHash(publicLedgerHashPayload(bundle));
  const att = bundle.verifierSummary?.attestation;
  let signerInput;
  if (att?.providerAddress && att?.signingAddress) {
    const broker = deps.broker !== void 0 ? deps.broker : await createReadOnlyComputeBroker(env);
    if (broker) signerInput = { broker, providerAddress: att.providerAddress, expectedSigner: att.signingAddress };
  }
  let v;
  try {
    v = await verifyBundleAgainst0G(adapters, {
      storageRootHash: String(bundle.storageAnchor?.rootHash ?? ""),
      expectedStorageHash,
      chainTxHash: String(bundle.chainAnchor?.txHash ?? ""),
      expectedManifestHash: String(bundle.manifest?.publicBundleHash ?? ""),
      expectedChainId: bundle.chainAnchor?.chainId != null ? Number(bundle.chainAnchor.chainId) : void 0,
      readAt: (/* @__PURE__ */ new Date()).toISOString(),
      signer: signerInput
    });
  } catch (error) {
    stdout(`\u2717 Re-verification could not reach live 0G: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  const mark = (ok) => ok ? "\u2713" : "\u2717";
  stdout(`${mark(v.storage.matches)} 0G STORAGE  downloaded object re-hashes to the bundle content hash`);
  stdout(`${mark(v.chain.matches)} 0G CHAIN    tx calldata == bundle manifest hash`);
  if (v.signer) {
    const quoteNote = v.signer.quoteVerified ? "; live quote re-verified" : "; live quote not re-checked";
    stdout(
      `${mark(v.signer.matches)} 0G SIGNER   attestation signer ${v.signer.matches ? "IS" : "is NOT"} the provider's on-chain-acknowledged TEE signer (on-chain: ${v.signer.onChainSigner ?? "\u2014"}${quoteNote})`
    );
  } else if (att) {
    stdout(`\xB7 0G SIGNER   skipped (no compute RPC configured for the signer re-check)`);
  }
  const allOk = v.storage.matches && v.chain.matches && (v.signer ? v.signer.matches : true);
  stdout(allOk ? "RESULT: PASS \u2014 every live-0G leg matches." : "RESULT: FAIL \u2014 at least one leg does not match.");
  return allOk;
}
async function anchorStoreAndVerify(adapters, pendingBundle, opts) {
  const bundleHash = hashPublicLedgerBundle(pendingBundle);
  const contentForStorage = publicLedgerHashPayload({
    ...pendingBundle,
    manifest: { ...pendingBundle.manifest, publicBundleHash: bundleHash }
  });
  const storageAnchor = await adapters.storage.uploadJson(contentForStorage);
  const chainAnchor = await adapters.chain.anchorManifest(bundleHash);
  const bundle = createPublicLedgerBundle({
    ...pendingBundle,
    storageAnchor,
    chainAnchor,
    manifest: { ...pendingBundle.manifest, anchors: [storageAnchor, chainAnchor] }
  });
  const att = pendingBundle.verifierSummary.attestation;
  const signerInput = att?.providerAddress && att?.signingAddress && opts.broker ? { broker: opts.broker, providerAddress: att.providerAddress, expectedSigner: att.signingAddress } : void 0;
  const verifyAgainst0G = await verifyBundleAgainst0G(adapters, {
    storageRootHash: storageAnchor.rootHash,
    // Re-hash the DOWNLOADED object and compare to the CONTENT hash — NOT the storage rootHash
    // (a Merkle root for real 0G ≠ sha256 of the content).
    expectedStorageHash: canonicalHash(contentForStorage),
    chainTxHash: chainAnchor.txHash,
    expectedManifestHash: bundleHash,
    expectedChainId: chainAnchor.chainId,
    readAt: opts.now(),
    signer: signerInput
  });
  return { ...bundle, verifyAgainst0G };
}
async function publishViaRelayer(relayerUrl, authToken, pendingBundle) {
  const url = `${relayerUrl.replace(/\/+$/, "")}/publish`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authToken ? { Authorization: `Bearer ${authToken}` } : {}
    },
    body: JSON.stringify({ pendingBundle })
  });
  if (!res.ok) {
    let detail = String(res.status);
    try {
      const b = await res.json();
      if (b?.error) detail = `${res.status} ${b.error}`;
    } catch {
    }
    throw new Error(`Relayer publish failed (${detail}). The hosted relayer funds 0G anchoring; check VIBETRACE_RELAYER_URL or retry.`);
  }
  const body = await res.json();
  if (!body?.bundle) throw new Error("Relayer publish returned no bundle.");
  return body.bundle;
}
function assertRelayerReceipt(bundle, pendingBundle) {
  const expectedHash = hashPublicLedgerBundle(pendingBundle);
  if (bundle.manifest.publicBundleHash !== expectedHash) {
    throw new Error("Relayer receipt rejected: the returned bundle does not match the content we submitted (hash differs).");
  }
  if (hashPublicLedgerBundle(bundle) !== expectedHash) {
    throw new Error("Relayer receipt rejected: the returned bundle is internally inconsistent (re-hash mismatch).");
  }
  if (bundle.chainAnchor?.manifestHash !== expectedHash) {
    throw new Error("Relayer receipt rejected: the on-chain anchor does not commit our bundle hash.");
  }
  if (!bundle.verifyAgainst0G?.chain?.matches) {
    throw new Error("Relayer receipt rejected: the on-chain read-back did not match the bundle hash.");
  }
  if (!bundle.verifyAgainst0G?.storage?.matches) {
    throw new Error("Relayer receipt rejected: the 0G Storage read-back did not match (object not retrievable).");
  }
}
async function publishLedger(cwd, argv, now, env, stdout) {
  if (!argv.includes("--public-summary")) {
    throw new Error("publish requires explicit --public-summary to opt in to public output.");
  }
  const ledger = await readLedger(cwd);
  const config = await readConfig(cwd);
  if (!ledger.graph || !ledger.verifier) {
    await verifyLedger(cwd, now, env, () => void 0);
  }
  const verifiedLedger = await readLedger(cwd);
  if (!verifiedLedger.graph || !verifiedLedger.verifier) {
    throw new Error("Unable to publish because verification did not produce a graph.");
  }
  const adapters = createOgAdaptersFromEnv({
    workspace: ledgerDir(cwd),
    now,
    env
  });
  const placeholderStorage = {
    kind: "storage",
    provider: "pending",
    uri: "pending",
    rootHash: "pending",
    createdAt: now()
  };
  const placeholderChain = {
    kind: "chain",
    provider: "pending",
    txHash: "pending",
    chainId: Number(env.VIBETRACE_0G_CHAIN_ID ?? "16602"),
    manifestHash: "pending",
    createdAt: now()
  };
  const latestSnapshot = verifiedLedger.snapshots.at(-1);
  const relayerUrl = env.VIBETRACE_RELAYER_URL;
  const usesRealStorage = Boolean(relayerUrl) || env.VIBETRACE_OG_MODE === "real";
  const evidenceBadges = augmentEvidenceBadgesForPublish(verifiedLedger.verifier.evidenceBadges, {
    storageProvider: usesRealStorage ? "0g-storage" : void 0,
    verifierProvider: verifiedLedger.verifier.verifierRun.provider,
    verifierModel: verifiedLedger.verifier.verifierRun.model,
    // Only promote the compute/TEE badges when the run carries a structurally valid
    // (honestly-labeled `attests: "tee-execution"`) attestation — never from the provider string alone.
    attested: hasValidatedAttestationShape(verifiedLedger.verifier.verifierRun)
  });
  const manifest = {
    schemaVersion: "vibetrace.v1",
    project: {
      name: verifiedLedger.project.name
    },
    repo: {
      root: verifiedLedger.project.root,
      commit: latestSnapshot?.commit ?? "unknown",
      branch: latestSnapshot?.branch
    },
    createdAt: now(),
    snapshotRoot: canonicalHash(verifiedLedger.snapshots),
    traceRoot: canonicalHash(verifiedLedger.traces.map(stripTraceExcerpts)),
    graphRoot: verifiedLedger.graph.canonicalHash,
    publicBundleHash: "pending",
    anchors: []
  };
  const pendingBundle = {
    manifest,
    publicGraph: verifiedLedger.graph,
    verifierSummary: verifiedLedger.verifier.verifierRun,
    evidenceBadges,
    storageAnchor: placeholderStorage,
    chainAnchor: placeholderChain
  };
  let bundleWithSidecar;
  if (relayerUrl) {
    bundleWithSidecar = await publishViaRelayer(relayerUrl, env.VIBETRACE_RELAYER_AUTH_TOKEN, pendingBundle);
    assertRelayerReceipt(bundleWithSidecar, pendingBundle);
  } else {
    const att = verifiedLedger.verifier.verifierRun.attestation;
    const signerBroker = att?.providerAddress && att?.signingAddress ? await createReadOnlyComputeBroker(env) : null;
    bundleWithSidecar = await anchorStoreAndVerify(adapters, pendingBundle, { broker: signerBroker, now });
  }
  const bundle = bundleWithSidecar;
  const { storageAnchor, chainAnchor, verifyAgainst0G } = bundleWithSidecar;
  await mkdir4(join4(ledgerDir(cwd), "public"), { recursive: true });
  const publicBundleJson = `${canonicalStringify(bundleWithSidecar)}
`;
  await writeFile2(join4(ledgerDir(cwd), "public", `${bundleWithSidecar.manifest.publicBundleHash}.json`), publicBundleJson, "utf8");
  const publicBundlePath = valueAfter(argv, "--out") ?? config.publish.publicBundlePath;
  if (publicBundlePath) {
    const outPath = resolveInsideProject(cwd, publicBundlePath);
    await mkdir4(dirname(outPath), { recursive: true });
    await writeFile2(outPath, publicBundleJson, "utf8");
  }
  const viewerBaseUrl = firstNonEmpty(valueAfter(argv, "--viewer-url"), env.VIBETRACE_VIEWER_URL, config.publish.viewerBaseUrl);
  const viewerUrl = viewerBaseUrl ? buildViewerUrl(viewerBaseUrl, bundleWithSidecar.manifest.publicBundleHash) : void 0;
  verifiedLedger.published = {
    publicBundleHash: bundle.manifest.publicBundleHash,
    storageUri: storageAnchor.uri,
    chainTxHash: chainAnchor.txHash,
    createdAt: now(),
    publicBundlePath,
    viewerUrl,
    verifyAgainst0G
  };
  await writeLedger(cwd, verifiedLedger);
  await writeFile2(join4(ledgerDir(cwd), "published.json"), canonicalStringify(verifiedLedger.published), "utf8");
  await writeFile2(
    join4(ledgerDir(cwd), "verify-against-0g.json"),
    canonicalStringify(verifyAgainst0G),
    "utf8"
  );
  stdout(`Published public ledger ${bundle.manifest.publicBundleHash}.`);
  stdout(
    `Verified against 0G: storage ${verifyAgainst0G.storage.matches ? "matches" : "MISMATCH"}, chain ${verifyAgainst0G.chain.matches ? "matches" : "MISMATCH"}${verifyAgainst0G.signer ? `, signer ${verifyAgainst0G.signer.matches ? "matches" : "MISMATCH"}` : ""}.`
  );
  if (publicBundlePath) {
    stdout(`Exported public bundle ${publicBundlePath}.`);
  }
  if (viewerUrl) {
    stdout(`Viewer URL: ${viewerUrl}`);
  }
}
function hasValidatedAttestationShape(run) {
  const a = run.attestation;
  return !!a && a.scheme === "0g-teeml" && a.attests === "tee-execution" && a.processResponseValid === true && typeof a.signature === "string" && a.signature.length > 0 && typeof a.signedDigest === "string" && a.signedDigest.length > 0 && typeof a.responseTextHash === "string" && a.responseTextHash.length > 0 && typeof a.signingAddress === "string" && a.signingAddress.length > 0;
}
function augmentEvidenceBadgesForPublish(badges, options) {
  const applyOgEvidence = (badge, evidenceNode, verifiedExplanation) => {
    const supportingNodes = [.../* @__PURE__ */ new Set([...badge.supportingNodes, evidenceNode])].sort();
    if (badge.verdict === "unsupported" || badge.verdict === "inflated") {
      return {
        ...badge,
        supportingNodes,
        publicExplanation: `Live 0G evidence recorded (${evidenceNode}), but the attested examiner did not substantiate this claim from public evidence (verdict: ${badge.verdict}).`
      };
    }
    return {
      ...badge,
      status: "verified",
      confidence: Math.max(badge.confidence, 0.95),
      supportingNodes,
      publicExplanation: verifiedExplanation
    };
  };
  return badges.map((badge) => {
    if (badge.claimId === "claim:claim-0g-storage" && options.storageProvider === "0g-storage") {
      return applyOgEvidence(
        badge,
        "anchor:storage:0g-storage",
        "The public bundle was uploaded to 0G Storage and records a 0G Storage root hash."
      );
    }
    if (badge.claimId === "claim:claim-0g-compute" && options.verifierProvider === "0g-compute" && options.attested === true) {
      return applyOgEvidence(
        badge,
        `verifier:${options.verifierProvider}:${options.verifierModel}`,
        "The build was examined by an inference running in an attested 0G Compute (TeeML) enclave (execution and response-hash signed by the provider's 0G TEE signer named by the attestation; the signature recovers to that signer); verdict content is relayed by the operator."
      );
    }
    if (badge.claimId === "claim:claim-tee-attested" && options.verifierProvider === "0g-compute" && options.attested === true) {
      return applyOgEvidence(
        badge,
        `attestation:0g-teeml:${options.verifierModel}`,
        "Independently examined by an inference running in an attested 0G TEE enclave \u2014 execution and response-hash signed by the provider's 0G TEE signer named by the attestation; verdict content relayed by the operator (re-verify the signature recovers to that signer; VibeTrace does not check the signer against the provider's on-chain registry)."
      );
    }
    return badge;
  });
}
async function inspectLedger(cwd, argv, stdout) {
  const ledger = await readLedger(cwd);
  const summary = {
    project: ledger.project.name,
    snapshots: ledger.snapshots.length,
    traceSpans: ledger.traces.length,
    claims: ledger.claims.length,
    graph: ledger.graph?.canonicalHash ?? null,
    published: ledger.published ?? null
  };
  if (argv.includes("--json")) {
    stdout(JSON.stringify(summary, null, 2));
    return;
  }
  stdout(
    [
      `Project: ${summary.project}`,
      `Snapshots: ${summary.snapshots}`,
      `Trace spans: ${summary.traceSpans}`,
      `Claims: ${summary.claims}`,
      `Graph: ${summary.graph ?? "not verified"}`,
      `Published: ${summary.published?.publicBundleHash ?? "no"}`
    ].join("\n")
  );
}
async function doctorWorkspace(cwd, argv, env, stdout) {
  const report = await createDoctorReport(cwd, env);
  if (argv.includes("--json")) {
    stdout(JSON.stringify(report, null, 2));
    return;
  }
  stdout(
    [
      "VibeTrace doctor",
      `Workspace: ${report.workspaceInitialized ? "initialized" : "missing"}`,
      `Config: ${report.configFound ? "found" : "missing"}`,
      `Package: ${report.packageDetected ? "detected" : "missing"}`,
      `Git: ${report.gitDetected ? "detected" : "not detected"}`,
      `Snapshots: ${report.snapshots}`,
      `Trace spans: ${report.traces}`,
      `Graph: ${report.graphVerified ? "verified" : "not verified"}`,
      `Published: ${report.published ? "yes" : "no"}`,
      `0G mode: ${report.mode}`,
      report.missingEnv.length ? `Missing env: ${report.missingEnv.join(", ")}` : "Missing env: none",
      report.nextSteps.length ? `Next steps:
- ${report.nextSteps.join("\n- ")}` : "Next steps: none"
    ].join("\n")
  );
}
async function createDoctorReport(cwd, env) {
  const packageJson = await readPackageJson(cwd);
  const workspaceInitialized = await exists3(ledgerPath(cwd));
  const configFound = await exists3(configPath(cwd));
  const ledger = workspaceInitialized ? await readLedger(cwd) : void 0;
  const mode = ogMode(env);
  const hosted = Boolean(env.VIBETRACE_RELAYER_URL);
  const requiredEnv = hosted ? requiredRealComputeEnv : mode === "real" ? requiredRealStorageEnv : mode === "real-chain" ? requiredRealChainEnv : [];
  const missingEnv = requiredEnv.filter((name) => !env[name]);
  const nextSteps = [];
  if (!workspaceInitialized) {
    nextSteps.push("Run vibetrace init to create a private local ledger.");
  }
  if (!configFound) {
    nextSteps.push("Run vibetrace init to create vibetrace.config.json.");
  }
  if (!ledger?.snapshots.length) {
    nextSteps.push("Run vibetrace ci to record, verify, and publish the current build story.");
  }
  if (!ledger?.traces.length) {
    nextSteps.push("Drop trace JSON into .agenttrace/, traces/, ai-traces/, or .vibetrace/inbox/.");
  }
  if (!ledger?.graph) {
    nextSteps.push("Run vibetrace ci to build artifact lineage and evidence badges.");
  }
  if (!ledger?.published) {
    nextSteps.push("Run vibetrace ci to create a redacted public bundle.");
  }
  if (missingEnv.length) {
    nextSteps.push("Set the missing live 0G environment variables or use dev mode for local publishing.");
  }
  return {
    workspaceInitialized,
    configFound,
    packageDetected: Object.keys(packageJson).length > 0,
    gitDetected: await hasGit(cwd),
    snapshots: ledger?.snapshots.length ?? 0,
    traces: ledger?.traces.length ?? 0,
    graphVerified: Boolean(ledger?.graph),
    published: Boolean(ledger?.published),
    mode,
    missingEnv,
    nextSteps
  };
}
function ogMode(env) {
  return env.VIBETRACE_OG_MODE === "real" ? "real" : env.VIBETRACE_OG_MODE === "real-chain" ? "real-chain" : "dev";
}
async function collectFiles(cwd, config) {
  const files = [];
  const ignorePatterns = unique([
    ...config.snapshot.ignore,
    ...config.publish.publicBundlePath ? [config.publish.publicBundlePath] : []
  ]);
  async function walk(dir) {
    for (const entry of await readdir3(dir, { withFileTypes: true })) {
      const absolute = join4(dir, entry.name);
      const relativePath = relative3(cwd, absolute).replaceAll("\\", "/");
      if (matchesIgnore(relativePath + (entry.isDirectory() ? "/" : ""), ignorePatterns)) {
        continue;
      }
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        const data = await readFile4(absolute);
        const stats = await stat3(absolute);
        files.push({
          path: relative3(cwd, absolute).replaceAll("\\", "/"),
          hash: canonicalHash(data.toString("base64")),
          size: stats.size
        });
      }
    }
  }
  await walk(cwd);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
async function discoverTraceFiles(cwd, config) {
  const files = [];
  async function walk(dir) {
    for (const entry of await readdir3(dir, { withFileTypes: true })) {
      const absolute = join4(dir, entry.name);
      const relativePath = relative3(cwd, absolute).replaceAll("\\", "/");
      if (entry.isDirectory()) {
        if (!shouldSkipTraceDirectory(relativePath)) {
          await walk(absolute);
        }
        continue;
      }
      if (entry.isFile() && relativePath.endsWith(".json") && matchesIgnore(relativePath, config.traces.include)) {
        files.push(relativePath);
      }
    }
  }
  await walk(cwd);
  return files.sort((a, b) => a.localeCompare(b));
}
function shouldSkipTraceDirectory(path) {
  const normalized = path.replaceAll("\\", "/").replace(/\/$/, "");
  if ([".git", "node_modules", "dist", ".next", "coverage"].includes(normalized)) return true;
  return normalized.startsWith(".vibetrace/") && !normalized.startsWith(".vibetrace/inbox");
}
async function readGitState(cwd, files) {
  try {
    const [{ stdout: commit }, { stdout: branch }] = await Promise.all([
      execFileAsync("git", ["rev-parse", "HEAD"], { cwd }),
      execFileAsync("git", ["branch", "--show-current"], { cwd })
    ]);
    return {
      commit: commit.trim(),
      branch: branch.trim() || "detached"
    };
  } catch {
    return {
      commit: canonicalHash(files).slice(0, 14),
      branch: "no-git"
    };
  }
}
async function readLedger(cwd) {
  try {
    return JSON.parse(await readFile4(ledgerPath(cwd), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error("No VibeTrace workspace found. Run vibetrace init first.");
    }
    throw error;
  }
}
async function writeLedger(cwd, ledger) {
  await mkdir4(ledgerDir(cwd), { recursive: true });
  await writeFile2(ledgerPath(cwd), `${canonicalStringify(ledger)}
`, "utf8");
}
async function migrateLedgerProjectName(cwd, stdout) {
  if (!await exists3(ledgerPath(cwd))) return;
  const ledger = await readLedger(cwd);
  const current = (ledger.project?.name ?? "").trim();
  if (current && current !== "unnamed-project") return;
  const resolved = resolveProjectName(await readPackageJson(cwd), cwd);
  if (resolved === current || resolved === "unnamed-project") return;
  ledger.project.name = resolved;
  await writeLedger(cwd, ledger);
  stdout(`Updated project name to "${resolved}" (was "${current || "(empty)"}").`);
}
async function readConfig(cwd) {
  const packageJson = await readPackageJson(cwd);
  if (!await exists3(configPath(cwd))) {
    return defaultConfig(packageJson, cwd);
  }
  const input = JSON.parse(await readFile4(configPath(cwd), "utf8"));
  const defaults = defaultConfig(packageJson, cwd);
  const storedName = typeof input.project?.name === "string" ? input.project.name.trim() : "";
  const name = storedName && storedName !== "unnamed-project" ? storedName : defaults.project.name;
  return {
    schemaVersion: "vibetrace.config.v1",
    project: {
      ...defaults.project,
      ...input.project ?? {},
      name
    },
    privacy: {
      redaction: "private-by-default"
    },
    snapshot: {
      ignore: unique([...defaults.snapshot.ignore ?? [], ...input.snapshot?.ignore ?? []])
    },
    traces: {
      include: unique([...defaults.traces.include ?? [], ...input.traces?.include ?? []])
    },
    publish: {
      ...defaults.publish,
      ...input.publish ?? {}
    }
  };
}
async function ensureConfig(cwd, packageJson, promptText = defaultPromptText) {
  if (await exists3(configPath(cwd))) {
    return readConfig(cwd);
  }
  const config = defaultConfig(packageJson, cwd);
  const hasPkgName = typeof packageJson.name === "string" && packageJson.name.trim() !== "";
  if (!hasPkgName) {
    const chosen = (await promptText("Project name?", config.project.name)).trim();
    if (chosen) config.project.name = chosen;
  }
  await writeFile2(configPath(cwd), `${JSON.stringify(config, null, 2)}
`, "utf8");
  return config;
}
async function ensureCiWorkflow(cwd, packageManager) {
  const workflowPath = join4(".github", "workflows", "vibetrace.yml");
  const absolutePath = join4(cwd, workflowPath);
  if (await exists3(absolutePath)) {
    return void 0;
  }
  await mkdir4(dirname(absolutePath), { recursive: true });
  await writeFile2(absolutePath, ciWorkflowContent(packageManager), "utf8");
  return workflowPath;
}
async function ensureGitignore(cwd) {
  const path = join4(cwd, ".gitignore");
  const block = "# VibeTrace private ledger\n.vibetrace/\n";
  const existing = await exists3(path) ? await readFile4(path, "utf8") : "";
  if (existing.includes(".vibetrace/")) {
    return;
  }
  const separator = existing.length && !existing.endsWith("\n") ? "\n\n" : existing.length ? "\n" : "";
  await writeFile2(path, `${existing}${separator}${block}`, "utf8");
}
async function readPackageJson(cwd) {
  try {
    const data = JSON.parse(await readFile4(join4(cwd, "package.json"), "utf8"));
    return {
      name: data.name,
      version: data.version,
      scripts: data.scripts,
      dependencies: data.dependencies,
      devDependencies: data.devDependencies
    };
  } catch {
    return {};
  }
}
function resolveProjectName(packageJson, cwd) {
  const fromPkg = typeof packageJson.name === "string" ? packageJson.name.trim() : "";
  if (fromPkg) return fromPkg;
  const folder = basename(resolve3(cwd)).trim();
  if (folder && folder !== "." && folder !== "/" && folder !== "~") return folder;
  return "unnamed-project";
}
function defaultConfig(packageJson, cwd) {
  return {
    schemaVersion: "vibetrace.config.v1",
    project: {
      name: resolveProjectName(packageJson, cwd)
    },
    privacy: {
      redaction: "private-by-default"
    },
    snapshot: {
      // Dir-name patterns match at ANY depth (see patternMatchesPath), so nested deps/build output in a
      // monorepo are excluded too — keeping the snapshot to real source so coverage isn't diluted.
      // Only UNAMBIGUOUS dependency / cache / framework-output dirs are excluded at any depth — names a
      // project would essentially never use for committed source. Ambiguous ones (build, out, vendor,
      // target) are deliberately omitted to avoid silently dropping real source; a project can still add
      // them to its own config's ignore.
      ignore: [
        ".git/**",
        ".vibetrace/**",
        "node_modules/**",
        "dist/**",
        ".next/**",
        ".nuxt/**",
        ".output/**",
        ".svelte-kit/**",
        ".turbo/**",
        ".cache/**",
        ".parcel-cache/**",
        "coverage/**",
        "playwright-report/**",
        "test-results/**",
        "__pycache__/**",
        ".venv/**",
        ".env*",
        "*.log"
      ]
    },
    traces: {
      include: [
        ".agenttrace/*.json",
        ".agenttrace/**/*.json",
        ".vibetrace/inbox/*.json",
        ".vibetrace/inbox/**/*.json",
        "agenttrace/*.json",
        "agenttrace/**/*.json",
        "ai-traces/*.json",
        "ai-traces/**/*.json",
        "trace.json",
        "traces/*.json",
        "traces/**/*.json",
        "vibetrace.trace.json"
      ]
    },
    publish: {
      publicBundlePath: "public/vibetrace.json",
      registryUrl: defaultRegistryUrl
    }
  };
}
function appendTraceSpans(ledger, spans) {
  const seen = new Set(ledger.traces.map(traceIdentity));
  let added = 0;
  let skipped = 0;
  for (const span of spans) {
    const identity = traceIdentity(span);
    if (seen.has(identity)) {
      skipped += 1;
      continue;
    }
    ledger.traces.push(span);
    seen.add(identity);
    added += 1;
  }
  return { added, skipped };
}
function traceIdentity(span) {
  return `${span.spanId}:${span.promptHash}:${span.responseHash}`;
}
async function detectPackageManager(cwd) {
  if (await exists3(join4(cwd, "pnpm-lock.yaml")) || await exists3(join4(cwd, "pnpm-workspace.yaml"))) return "pnpm";
  if (await exists3(join4(cwd, "package-lock.json")) || await exists3(join4(cwd, "npm-shrinkwrap.json"))) return "npm";
  if (await exists3(join4(cwd, "yarn.lock"))) return "yarn";
  if (await exists3(join4(cwd, "bun.lock")) || await exists3(join4(cwd, "bun.lockb"))) return "bun";
  return "pnpm";
}
function ciWorkflowContent(packageManager) {
  const setup = workflowPackageManagerSteps(packageManager);
  return `name: VibeTrace

on:
  workflow_dispatch:
  push:
    branches: [main]
  pull_request:

jobs:
  vibetrace:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    env:
      VIBETRACE_REGISTRY_URL: \${{ vars.VIBETRACE_REGISTRY_URL }}
      VIBETRACE_VIEWER_URL: \${{ vars.VIBETRACE_VIEWER_URL }}
      # OPTIONAL attested path \u2014 set this to a VibeTrace relayer YOU operate or are authorized to use.
      # It funds ALL 0G writes (anchor + storage + compute) with ITS key, so this workflow needs none.
      # Leave UNSET to skip attestation and run the keyless local verifier (the default).
      VIBETRACE_RELAYER_URL: \${{ vars.VIBETRACE_RELAYER_URL }}
      VIBETRACE_RELAYER_AUTH_TOKEN: \${{ secrets.VIBETRACE_RELAYER_AUTH_TOKEN }}
      # SELF-FUNDED path \u2014 instead of a relayer, set VIBETRACE_OG_MODE (real / real-chain) plus your
      # OWN funded VIBETRACE_0G_PRIVATE_KEY to anchor on 0G locally with your own gas.
      VIBETRACE_OG_MODE: \${{ vars.VIBETRACE_OG_MODE }}
      VIBETRACE_0G_CHAIN_ID: \${{ vars.VIBETRACE_0G_CHAIN_ID }}
      VIBETRACE_0G_RPC_URL: \${{ vars.VIBETRACE_0G_RPC_URL }}
      VIBETRACE_0G_STORAGE_INDEXER: \${{ vars.VIBETRACE_0G_STORAGE_INDEXER }}
      VIBETRACE_0G_STORAGE_FINALITY: \${{ vars.VIBETRACE_0G_STORAGE_FINALITY }}
      VIBETRACE_0G_PRIVATE_KEY: \${{ secrets.VIBETRACE_0G_PRIVATE_KEY }}
    steps:
      - uses: actions/checkout@v4
${setup}
      - name: Generate VibeTrace public bundle
        run: ${workflowRunCommand(packageManager)}

      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: vibetrace-public-bundle
          path: public/vibetrace.json
          if-no-files-found: ignore
`;
}
function workflowPackageManagerSteps(packageManager) {
  switch (packageManager) {
    case "npm":
      return `
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - run: npm ci
`;
    case "yarn":
      return `
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: yarn

      - run: corepack enable
      - run: yarn install --immutable || yarn install --frozen-lockfile
`;
    case "bun":
      return `
      - uses: oven-sh/setup-bun@v2

      - run: bun install --frozen-lockfile
`;
    case "pnpm":
      return `
      - uses: pnpm/action-setup@v4
        with:
          version: 10

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm

      - run: pnpm install --frozen-lockfile
`;
  }
}
function workflowRunCommand(packageManager) {
  switch (packageManager) {
    case "npm":
      return "npx vibetrace ci";
    case "yarn":
      return "yarn vibetrace ci";
    case "bun":
      return "bunx vibetrace ci";
    case "pnpm":
      return "pnpm exec vibetrace ci";
  }
}
async function exists3(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
async function hasGit(cwd) {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}
function defaultClaims() {
  return [
    { claimId: "claim-0g-storage", text: "Uses or integrates 0G Storage", selectors: ["0g", "storage"], evidence: "external" },
    { claimId: "claim-0g-compute", text: "Uses or integrates 0G Compute", selectors: ["0g", "compute"], evidence: "external" },
    {
      claimId: "claim-tee-attested",
      text: "Examined by an inference running in an attested 0G Compute TEE (execution attested by the provider's 0G TEE signer named by the attestation)",
      selectors: ["0g", "compute", "tee", "attest"],
      evidence: "external"
    },
    { claimId: "claim-ai-build", text: "Includes AI-assisted build trace evidence", selectors: ["src", "app", "package"], evidence: "trace" }
  ];
}
function stripTraceExcerpts(span) {
  const { promptExcerpt: _promptExcerpt, responseExcerpt: _responseExcerpt, ...publicSpan } = span;
  return publicSpan;
}
function ledgerDir(cwd) {
  return join4(cwd, workspaceDir);
}
function ledgerPath(cwd) {
  return join4(ledgerDir(cwd), ledgerFile);
}
function configPath(cwd) {
  return join4(cwd, configFile);
}
function valueAfter(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : void 0;
}
function unique(values) {
  return [...new Set(values)];
}
function matchesIgnore(path, patterns) {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  return patterns.some((pattern) => patternMatchesPath(pattern, normalized));
}
function patternMatchesPath(pattern, path) {
  const normalizedPattern = pattern.replaceAll("\\", "/").replace(/^\.\//, "");
  const pathWithoutTrailingSlash = path.endsWith("/") ? path.slice(0, -1) : path;
  const dirSegmentAtAnyDepth = (name) => Boolean(name) && !name.includes("/") && `/${pathWithoutTrailingSlash}/`.includes(`/${name}/`);
  if (normalizedPattern.endsWith("/**")) {
    const prefix = normalizedPattern.slice(0, -3);
    if (pathWithoutTrailingSlash === prefix || path.startsWith(`${prefix}/`)) return true;
    return dirSegmentAtAnyDepth(prefix);
  }
  if (normalizedPattern.endsWith("/")) {
    const name = normalizedPattern.slice(0, -1);
    if (path.startsWith(normalizedPattern)) return true;
    return dirSegmentAtAnyDepth(name);
  }
  if (!normalizedPattern.includes("/") && path.startsWith(`${normalizedPattern}/`)) {
    return true;
  }
  return globToRegExp(normalizedPattern).test(pathWithoutTrailingSlash);
}
function globToRegExp(pattern) {
  let source = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    const next = pattern[i + 1];
    if (char === "*" && next === "*") {
      source += ".*";
      i += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else {
      source += escapeRegExp(char);
    }
  }
  return new RegExp(`^${source}$`);
}
function escapeRegExp(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}
function resolveInsideProject(cwd, targetPath) {
  const resolved = resolve3(cwd, targetPath);
  const relativePath = relative3(cwd, resolved);
  if (relativePath === ".." || relativePath.startsWith(`..${"/"}`) || resolve3(relativePath) === relativePath) {
    throw new Error(`Refusing to write outside the project: ${targetPath}`);
  }
  let realCwd;
  try {
    realCwd = realpathSync(cwd);
  } catch {
    realCwd = resolve3(cwd);
  }
  let probe = resolved;
  while (!existsSync3(probe) && dirname(probe) !== probe) {
    probe = dirname(probe);
  }
  let realProbe;
  try {
    realProbe = realpathSync(probe);
  } catch {
    realProbe = probe;
  }
  const realPrefix = realCwd.endsWith("/") ? realCwd : `${realCwd}/`;
  if (realProbe !== realCwd && !realProbe.startsWith(realPrefix)) {
    throw new Error(`Refusing to write through a symlink outside the project: ${targetPath}`);
  }
  return resolved;
}
function buildViewerUrl(baseUrl, bundleHash) {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return `${base}/#/p/${bundleHash}`;
}
function firstNonEmpty(...values) {
  return values.find((value) => typeof value === "string" && value.trim().length > 0);
}
function helpText() {
  return `VibeTrace

Run with no arguments to collect local AI-agent traces, publish, and register
to the leaderboard in one shot (same as 'vibetrace ship').

Commands:
  vibetrace                         one-shot: collect -> publish -> register
  vibetrace ship [--out ...] [--viewer-url ...] [--include-excerpts]
  vibetrace collect [--yes] [--include-excerpts]
  vibetrace init [--ci]
  vibetrace ci [--out public/vibetrace.json] [--viewer-url https://viewer.example]
  vibetrace snapshot
  vibetrace import --file trace.json
  vibetrace verify [--private-packet [--yes]] [--redact <glob> ...]
  vibetrace publish --public-summary [--out public/vibetrace.json] [--viewer-url https://viewer.example]
  vibetrace inspect [--json]
  vibetrace doctor [--json]`;
}
function invokedAsMain() {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(argv1);
  } catch {
    return false;
  }
}
if (invokedAsMain() && !globalThis.__VIBETRACE_RELAYER__) {
  runCli(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
export {
  addBadgeToReadme,
  anchorStoreAndVerify,
  assertRelayerReceipt,
  augmentEvidenceBadgesForPublish,
  buildViewerUrl,
  hasValidatedAttestationShape,
  matchesIgnore,
  migrateLedgerProjectName,
  publishViaRelayer,
  resolveProjectName,
  reverifyPublishedBundle,
  runCli,
  verifyBundleAgainst0G
};
/*! Bundled license information:

@noble/hashes/esm/utils.js:
  (*! noble-hashes - MIT License (c) 2022 Paul Miller (paulmillr.com) *)
*/
