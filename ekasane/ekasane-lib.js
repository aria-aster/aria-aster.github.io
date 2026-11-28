// ekasane-lib.js — Ekasane ライブラリ (alpha0.00.1)
// 仕様: ekasane-library.md / 詳細設計: ekasane-library-lld.md / データ形式: ekasane-format.md
// 単一ファイル、ES モジュール、外部依存なし。I/O は持たない。

export class EkasaneError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "EkasaneError";
    this.code = code;
  }
}

// ---- デフォルト値（フォーマット仕様の各表より。デザイナー／レンダラー任せの項目は適用しない） ----
const COMMON_DEFAULTS = { author: "", "input-order": "descending" };
const MATERIAL_DEFAULTS = { "material-type": "image", zoom: 100 };
const FONT_DEFAULTS = { size: 32, weight: 400, color: "#000000FF" };
const OBJECT_COMMON_DEFAULTS = { x: 0, y: 0, z: 0, overflow: "hidden" };
const OBJECT_TYPE_DEFAULTS = {
  shape: {
    vector: "horizontal", reverse: false,
    "fill-color": "#00000000", "border-color": "#000000FF", "border-width": 3,
    counterclockwise: false, rotation: 0,
  },
  text: { "max-length": 0, "max-line": 0, "auto-linebreak": false, align: "left", "vertical-align": "top" },
  numeric: { min: 0, max: 65535, "decimal-places": 0, align: "left", "vertical-align": "top" },
  image: { vector: "horizontal", reverse: false },
};

function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isFunctionForm(v, name) {
  return isPlainObject(v) && Array.isArray(v.function) && v.function[0] === name;
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// キー名は大文字・小文字を区別しない（すべて小文字として扱う。フォーマット仕様の共通ルール）
function lowercaseKeys(item) {
  const out = {};
  for (const [k, v] of Object.entries(item)) out[k.toLowerCase()] = v;
  return out;
}

// id の指定を { category, id } に分解する。フル形 "ekasane.<category>.<id>" と省略形 "<id>" の両対応。
// 省略形の場合は defaultCategory を使う。id 自体にドットが含まれ得るので、カテゴリは2番目の要素までで判定する。
function parseIdReference(str, defaultCategory) {
  if (typeof str !== "string") return null;
  if (str.startsWith("ekasane.")) {
    const rest = str.slice("ekasane.".length);
    const dot = rest.indexOf(".");
    if (dot < 0) return null;
    return { category: rest.slice(0, dot), id: rest.slice(dot + 1) };
  }
  return { category: defaultCategory, id: str };
}

// object 定義の中にある function 形の参照（reference / anchor）の引数を集める
function collectReferences(node, out) {
  if (Array.isArray(node)) {
    for (const v of node) collectReferences(v, out);
  } else if (isPlainObject(node)) {
    if (Array.isArray(node.function) && (node.function[0] === "reference" || node.function[0] === "anchor")) {
      out.push(node.function[1]);
    }
    for (const v of Object.values(node)) collectReferences(v, out);
  }
}

export class Ekasane {
  static validators = { common: [], material: [], font: [], object: [] };

  static registerValidator(kind, fn) {
    if (!Object.prototype.hasOwnProperty.call(Ekasane.validators, kind)) {
      throw new EkasaneError("INVALID_KIND", `unknown validator kind: ${kind}`);
    }
    Ekasane.validators[kind].push(fn);
  }

  constructor() {
    this.common = {};
    this.material = new Map();
    this.font = new Map();
    this.object = new Map();
    this.runtimeIds = new Map(); // objectId -> issued runtime id（実行時 ID の控え）
    this._explicitKeys = new Map(); // item object -> Set<key>（元の JSON に明示されていたキー）
  }

  // ---- parse ----
  static parse(text) {
    let raw;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      throw new EkasaneError("INVALID_JSON", `JSON parse failed: ${e.message}`);
    }
    if (!isPlainObject(raw) || !isPlainObject(raw.common)) {
      throw new EkasaneError("INVALID_STRUCTURE", "root must be an object with a common object");
    }
    for (const kind of ["material", "font", "object"]) {
      if (raw[kind] !== undefined && !Array.isArray(raw[kind])) {
        throw new EkasaneError("INVALID_STRUCTURE", `${kind} must be an array`);
      }
    }

    const ek = new Ekasane();

    // common（キーを小文字化し、デフォルトを適用）
    const common = lowercaseKeys(raw.common);
    if (isPlainObject(common.output)) common.output = lowercaseKeys(common.output);
    ek._recordExplicit(common);
    if (common.title === undefined && common.id !== undefined) common.title = common.id;
    for (const [k, v] of Object.entries(COMMON_DEFAULTS)) {
      if (common[k] === undefined) common[k] = v;
    }
    if (isPlainObject(common.output) && common.output.type === undefined) {
      common.output.type = "image/png";
    }
    ek.common = common;

    // material / font / object（配列の状態で重複チェック → デフォルト適用 → Map 化）
    const lists = {
      material: raw.material ?? [],
      font: raw.font ?? [],
      object: raw.object ?? [],
    };
    const idSets = {};
    for (const [kind, list] of Object.entries(lists)) {
      const seen = new Set();
      for (const item of list) {
        if (!isPlainObject(item) || typeof item.id !== "string") {
          throw new EkasaneError("INVALID_STRUCTURE", `${kind} item must be an object with a string id`);
        }
        if (seen.has(item.id)) {
          throw new EkasaneError("DUPLICATE_ID", `duplicate id in ${kind}: ${item.id}`);
        }
        seen.add(item.id);
      }
      idSets[kind] = seen;
    }

    for (const [kind, list] of Object.entries(lists)) {
      const map = ek[kind];
      for (const rawItem of list) {
        const item = lowercaseKeys(rawItem);
        ek._recordExplicit(item);
        if (item.label === undefined) item.label = item.id;
        const defaults = kind === "material" ? MATERIAL_DEFAULTS
          : kind === "font" ? FONT_DEFAULTS
          : { ...OBJECT_COMMON_DEFAULTS, ...(OBJECT_TYPE_DEFAULTS[item.type] ?? {}) };
        for (const [k, v] of Object.entries(defaults)) {
          if (item[k] === undefined) item[k] = v;
        }
        // text の value が文字列ならラン配列に正規化する
        if (kind === "object" && item.type === "text" && typeof item.value === "string") {
          item.value = item.value === "" ? [] : [{ text: item.value }];
        }
        map.set(item.id, item);
      }
    }

    // Reference / anchor の参照先チェック（object の id 集合に対して）
    for (const item of ek.object.values()) {
      const refs = [];
      collectReferences(item, refs);
      for (const ref of refs) {
        const parsed = parseIdReference(ref, "object");
        if (!parsed || parsed.category !== "object" || !idSets.object.has(parsed.id)) {
          throw new EkasaneError("MISSING_REFERENCE", `reference target not found: ${String(ref)} (in object ${item.id})`);
        }
      }
    }

    return ek;
  }

  _recordExplicit(item) {
    this._explicitKeys.set(item, new Set(Object.keys(item)));
  }

  // ---- serialize ----
  serialize() {
    const filterItem = (item, defaults) => {
      const explicit = this._explicitKeys.get(item) ?? new Set();
      const out = {};
      for (const [k, v] of Object.entries(item)) {
        if (explicit.has(k)) { out[k] = v; continue; }
        if (k in defaults) {
          const dv = typeof defaults[k] === "function" ? defaults[k](item) : defaults[k];
          if (!deepEqual(v, dv)) out[k] = v;
          continue;
        }
        out[k] = v; // デフォルトの無いキーはそのまま出す
      }
      return out;
    };
    const commonDefaults = { ...COMMON_DEFAULTS, title: (c) => c.id };
    const root = {
      common: filterItem(this.common, commonDefaults),
      material: [...this.material.values()].map((it) => filterItem(it, { ...MATERIAL_DEFAULTS, label: (i) => i.id })),
      font: [...this.font.values()].map((it) => filterItem(it, { ...FONT_DEFAULTS, label: (i) => i.id })),
      object: [...this.object.values()].map((it) => filterItem(it, {
        ...OBJECT_COMMON_DEFAULTS, ...(OBJECT_TYPE_DEFAULTS[it.type] ?? {}), label: (i) => i.id,
      })),
    };
    return JSON.stringify(root, null, 2);
  }

  // ---- データへのアクセス ----
  getObject(id) { return this.object.get(id); }
  getImage(id) { return this.material.get(id); }
  getMaterial(id) { return this.material.get(id); }
  getFont(id) { return this.font.get(id); }

  // ---- setValue ----
  setValue(id, value) {
    const item = this.object.get(id);
    if (!item) {
      return { result: false, code: "MISSING_OBJECT", message: `object not found: ${id}` };
    }
    // 関数形（reference / input 等）はそのまま設定する
    if (!isPlainObject(value) || !Array.isArray(value.function)) {
      if (item.type === "numeric") {
        if (typeof value !== "number") {
          return { result: false, code: "INVALID_VALUE_TYPE", message: `numeric value must be a number: ${id}` };
        }
        const min = typeof item.min === "number" ? item.min : 0;
        const max = typeof item.max === "number" ? item.max : 65535;
        if (value < min || value > max) {
          return { result: false, code: "VALUE_OUT_OF_RANGE", message: `value ${value} out of range ${min}..${max}: ${id}` };
        }
      } else if (item.type === "text") {
        if (typeof value !== "string" && !Array.isArray(value)) {
          return { result: false, code: "INVALID_VALUE_TYPE", message: `text value must be a string or run array: ${id}` };
        }
        const maxLength = typeof item["max-length"] === "number" ? item["max-length"] : 0;
        if (maxLength > 0) {
          const len = typeof value === "string"
            ? [...value].length
            : value.reduce((n, run) => n + (typeof run?.text === "string" ? [...run.text].length : 0), 0);
          if (len > maxLength) {
            return { result: false, code: "VALUE_TOO_LONG", message: `text length ${len} exceeds max-length ${maxLength}: ${id}` };
          }
        }
        if (typeof value === "string") value = value === "" ? [] : [{ text: value }];
      } else if (item.type === "image") {
        if (typeof value !== "string") {
          return { result: false, code: "INVALID_VALUE_TYPE", message: `image value must be a material id string: ${id}` };
        }
        const ref = parseIdReference(value, "material");
        const materialId = ref && ref.category === "material" ? ref.id : null;
        if (materialId === null || (!this.material.has(materialId) && !this.isRuntimeId(value) && !this.isRuntimeId(materialId))) {
          return { result: false, code: "UNKNOWN_MATERIAL_ID", message: `material not found: ${value}` };
        }
      }
    }
    item.value = value;
    let keys = this._explicitKeys.get(item);
    if (!keys) { keys = new Set(); this._explicitKeys.set(item, keys); }
    keys.add("value");
    return { result: true };
  }

  // ---- 実行時 ID ----
  issueRuntimeId(objectId) {
    const item = this.object.get(objectId);
    if (!item) throw new EkasaneError("MISSING_OBJECT", `object not found: ${objectId}`);
    if (item.type !== "image") throw new EkasaneError("NOT_IMAGE_OBJECT", `object is not image type: ${objectId}`);
    const existing = this.runtimeIds.get(objectId);
    if (existing !== undefined) return existing;
    const issued = new Set(this.runtimeIds.values());
    let candidate = `${objectId}-user-select`;
    let n = 2;
    while (this.material.has(candidate) || issued.has(candidate)) {
      candidate = `${objectId}-user-select-${n}`;
      n += 1;
    }
    this.runtimeIds.set(objectId, candidate);
    return candidate;
  }

  isRuntimeId(id) {
    for (const v of this.runtimeIds.values()) if (v === id) return true;
    return false;
  }

  // ---- ファイル取り込みの接続 ----
  bindImageInput(inputElement, handler) {
    const objectId = inputElement?.id;
    if (!this.object.has(objectId)) {
      throw new EkasaneError("MISSING_OBJECT", `object not found for input: ${objectId}`);
    }
    const listener = () => {
      const file = inputElement.files && inputElement.files[0];
      if (!file) return;
      const clear = () => { inputElement.value = ""; };
      try {
        const r = handler(objectId, file);
        if (r && typeof r.then === "function") r.then(clear, clear);
        else clear();
      } catch (e) {
        clear();
        throw e;
      }
    };
    inputElement.addEventListener("change", listener);
    return () => inputElement.removeEventListener("change", listener);
  }

  // ---- validation（枠のみ。中身のチェック関数は登録表に差し込む） ----
  _runValidators(kind, item, id, issues) {
    const fns = Ekasane.validators[kind] ?? [];
    let ok = true;
    for (const fn of fns) {
      const r = fn(item, { kind, id, ekasane: this }) ?? { result: true };
      const issue = { kind, id, result: r.result !== false };
      if (r.warning !== undefined) issue.warning = r.warning;
      if (r.code !== undefined) issue.code = r.code;
      if (r.message !== undefined) issue.message = r.message;
      issues.push(issue);
      if (r.result === false) ok = false;
    }
    return ok;
  }

  validate() {
    const issues = [];
    let result = true;
    if (!this._runValidators("common", this.common, null, issues)) result = false;
    for (const kind of ["material", "font", "object"]) {
      for (const item of this[kind].values()) {
        if (!this._runValidators(kind, item, item.id, issues)) result = false;
      }
    }
    return { result, issues };
  }

  validateObject(id) {
    const item = this.object.get(id);
    if (!item) {
      return { result: false, issues: [{ kind: "object", id, result: false, code: "MISSING_OBJECT", message: `object not found: ${id}` }] };
    }
    const issues = [];
    const result = this._runValidators("object", item, id, issues);
    return { result, issues };
  }

  // ---- 画像ヘッダ判定 ----
  checkImage(bytes, options = {}) {
    const checkSize = options.checkSize !== false;
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
    const parsed = parseImageHeader(u8);
    if (parsed.status !== "ok") return parsed;
    if (checkSize) {
      const w = this.common.width;
      const h = this.common.height;
      if (typeof w === "number" && typeof h === "number" && (parsed.width > w || parsed.height > h)) {
        // 例外（2026-11-21 改正）：material に trimming が指定され、切り抜き後のサイズが
        // テンプレート範囲内に収まる場合は、元寸法は各辺2倍（面積4倍）まで許容する
        const t = options.trimming;
        const hasTrimming = isPlainObject(t)
          && typeof t.width === "number" && typeof t.height === "number"
          && t.width > 0 && t.height > 0;
        const trimmingFits = hasTrimming && t.width <= w && t.height <= h;
        const withinDouble = parsed.width <= w * 2 && parsed.height <= h * 2;
        if (!(trimmingFits && withinDouble)) {
          return {
            status: "error", code: "IMAGE_TOO_LARGE",
            message: `image size ${parsed.width}x${parsed.height} exceeds template size ${w}x${h}`,
          };
        }
      }
    }
    return parsed;
  }
}

// ---- checkImage の実処理 ----
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIG = [0xff, 0xd8, 0xff];

function prefixMatches(bytes, sig) {
  const n = Math.min(bytes.length, sig.length);
  for (let i = 0; i < n; i++) if (bytes[i] !== sig[i]) return false;
  return true;
}

function asciiAt(bytes, offset, length) {
  let s = "";
  for (let i = 0; i < length; i++) s += String.fromCharCode(bytes[offset + i]);
  return s;
}

function be16(b, o) { return (b[o] << 8) | b[o + 1]; }
function be32(b, o) { return (b[o] * 0x1000000 + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3])) >>> 0; }
function le16(b, o) { return b[o] | (b[o + 1] << 8); }
function le24(b, o) { return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16); }
function le32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function parseJpeg(b) {
  let offset = 2; // SOI の次から
  while (true) {
    if (offset + 1 >= b.length) return { status: "pending" };
    if (b[offset] !== 0xff) {
      return { status: "error", code: "IMAGE_INVALID_HEADER", message: "jpeg: marker expected" };
    }
    const marker = b[offset + 1];
    if (marker === 0xda) {
      return { status: "error", code: "IMAGE_INVALID_HEADER", message: "jpeg: SOS reached before SOF" };
    }
    if (marker === 0x00 || marker === 0xff) {
      return { status: "error", code: "IMAGE_INVALID_HEADER", message: "jpeg: invalid marker" };
    }
    // 長さを持たないマーカー（SOI, RSTn, TEM）
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (offset + 3 >= b.length) return { status: "pending" };
    const segLen = be16(b, offset + 2);
    if (SOF_MARKERS.has(marker)) {
      if (offset + 8 >= b.length) return { status: "pending" };
      const height = be16(b, offset + 5);
      const width = be16(b, offset + 7);
      return { status: "ok", format: "jpeg", width, height };
    }
    offset += 2 + segLen;
    if (offset > b.length) return { status: "pending" };
  }
}

function parseWebp(b) {
  if (b.length < 12) return { status: "pending" };
  if (asciiAt(b, 8, 4) !== "WEBP") {
    return { status: "error", code: "IMAGE_UNSUPPORTED_FORMAT", message: "RIFF but not WEBP" };
  }
  if (b.length < 16) return { status: "pending" };
  const chunk = asciiAt(b, 12, 4);
  if (chunk === "VP8X") {
    if (b.length < 30) return { status: "pending" };
    return { status: "ok", format: "webp", width: le24(b, 24) + 1, height: le24(b, 27) + 1 };
  }
  if (chunk === "VP8L") {
    if (b.length < 21) return { status: "pending" };
    if (b[20] !== 0x2f) return { status: "error", code: "IMAGE_INVALID_HEADER", message: "webp VP8L: bad signature byte" };
    if (b.length < 25) return { status: "pending" };
    const v = le32(b, 21);
    return { status: "ok", format: "webp", width: (v & 0x3fff) + 1, height: ((v >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8 ") {
    if (b.length < 26) return { status: "pending" };
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) {
      return { status: "error", code: "IMAGE_INVALID_HEADER", message: "webp VP8: bad frame magic" };
    }
    if (b.length < 30) return { status: "pending" };
    return { status: "ok", format: "webp", width: le16(b, 26) & 0x3fff, height: le16(b, 28) & 0x3fff };
  }
  return { status: "error", code: "IMAGE_INVALID_HEADER", message: `webp: unknown first chunk ${chunk}` };
}

function parseImageHeader(b) {
  if (b.length === 0) return { status: "pending" };

  if (prefixMatches(b, PNG_SIG)) {
    if (b.length < PNG_SIG.length) return { status: "pending" };
    if (b.length < 24) return { status: "pending" };
    return { status: "ok", format: "png", width: be32(b, 16), height: be32(b, 20) };
  }
  if (prefixMatches(b, JPEG_SIG)) {
    if (b.length < JPEG_SIG.length) return { status: "pending" };
    return parseJpeg(b);
  }
  // RIFF（WebP）: 先頭4バイト "RIFF" の途中でも pending にする
  if (prefixMatches(b, [0x52, 0x49, 0x46, 0x46])) {
    if (b.length < 12) {
      // 8バイト目以降が "WEBP" の途中なら pending、違うなら非対応
      if (b.length > 8 && !prefixMatches(b.subarray(8), [0x57, 0x45, 0x42, 0x50])) {
        return { status: "error", code: "IMAGE_UNSUPPORTED_FORMAT", message: "RIFF but not WEBP" };
      }
      return { status: "pending" };
    }
    return parseWebp(b);
  }
  // ftyp（HEIC / HEIF 等）: 4バイト目から "ftyp"
  if (b.length >= 8 && asciiAt(b, 4, 4) === "ftyp") {
    return { status: "error", code: "IMAGE_UNSUPPORTED_FORMAT", message: "ftyp-based format (HEIC/HEIF etc.) is not supported" };
  }
  if (b.length < 8 && (prefixMatches(b, PNG_SIG) || prefixMatches(b, JPEG_SIG))) {
    return { status: "pending" };
  }
  return { status: "error", code: "IMAGE_UNSUPPORTED_FORMAT", message: "unknown image signature" };
}
